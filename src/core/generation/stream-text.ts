import {
  AbortError,
  AgentSdkError,
  StreamProtocolError,
  toAbortError,
} from "../errors/errors";
import {
  callModel,
  createMessages,
  createModelRequest,
  executeTool,
  retryDelay,
  sleep,
  type GenerateTextOptions,
  type GenerateTextResult,
  type StepResult,
} from "./generate-text";
import { getTool, type ToolSet } from "../tools/tool";
import {
  addUsage,
  zeroUsage,
  type FinishReason,
  type ModelMessage,
  type ModelStreamPart,
  type ProviderMetadata,
  type ProviderWarning,
  type ToolCall,
  type Usage,
} from "../model/types";
import {
  createOperationSignal,
  createPartialResult,
  getTimeouts,
  normalizeModelError,
  raceWithSignal,
  validateModelStreamPart,
  validateOptions,
  type OperationSignal,
} from "./runtime";

export type StreamPart =
  | { readonly type: "step-start"; readonly stepNumber: number }
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text-end"; readonly id: string }
  | {
      readonly type: "tool-call";
      readonly stepNumber: number;
      readonly toolCall: ToolCall;
    }
  | {
      readonly type: "finish";
      readonly stepNumber: number;
      readonly finishReason: FinishReason;
      readonly usage: Usage;
      readonly responseId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly modelId?: string | undefined;
      readonly warnings?: readonly ProviderWarning[] | undefined;
      readonly providerMetadata?: ProviderMetadata | undefined;
    }
  | {
      readonly type: "step-finish";
      readonly stepNumber: number;
      readonly step: StepResult;
    }
  | { readonly type: "error"; readonly error: AgentSdkError };

export interface StreamTextResult {
  /** Canonical event stream. This and textStream are alternative, mutually exclusive views. */
  readonly fullStream: ReadableStream<StreamPart>;
  /** Text-only view. This and fullStream are alternative, mutually exclusive views. */
  readonly textStream: ReadableStream<string>;
  readonly result: Promise<GenerateTextResult>;
}

interface OpenNativeStream {
  readonly reader: StreamReader<ModelStreamPart>;
  readonly firstPart: ModelStreamPart;
  readonly requestOperation: OperationSignal;
}

type StreamReadResult<T> =
  | { readonly done: false; readonly value: T }
  | { readonly done: true; readonly value?: T | undefined };

interface StreamReader<T> {
  read(): Promise<StreamReadResult<T>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

const readProviderPart = async (
  reader: StreamReader<ModelStreamPart>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutKind: "first-chunk" | "chunk",
) => {
  const operation = createOperationSignal(signal, timeoutMs, timeoutKind);
  try {
    return await raceWithSignal(
      reader.read(),
      operation.signal,
      `Model stream ${timeoutKind} wait was aborted`,
    );
  } finally {
    operation.dispose();
  }
};

const openNativeStream = async <Tools extends ToolSet>(
  options: GenerateTextOptions<Tools>,
  messages: readonly ModelMessage[],
  runSignal: AbortSignal,
): Promise<OpenNativeStream> => {
  const maxRetries = options.retry?.maxRetries ?? options.maxRetries ?? 2;
  const timeouts = getTimeouts(options.timeouts);
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const requestOperation = createOperationSignal(
      runSignal,
      timeouts.requestMs,
      "request",
    );
    let reader: StreamReader<ModelStreamPart> | undefined;
    try {
      if (!options.model.stream)
        throw new StreamProtocolError({
          message: "Model does not implement native streaming",
        });
      const providerStream = await raceWithSignal(
        options.model.stream(
          createModelRequest(options, messages, requestOperation.signal),
        ),
        requestOperation.signal,
        "Model stream request was aborted",
      );
      const providerReader = providerStream.getReader();
      reader = providerReader;
      const firstRead = await readProviderPart(
        providerReader,
        requestOperation.signal,
        timeouts.firstChunkMs,
        "first-chunk",
      );
      if (firstRead.done)
        throw new StreamProtocolError({
          message: "Model stream ended without a finish event",
          provider: options.model.provider,
          modelId: options.model.modelId,
        });
      const firstPart = validateModelStreamPart(
        firstRead.value,
        options.model.provider,
        options.model.modelId,
      );
      return { reader: providerReader, firstPart, requestOperation };
    } catch (cause) {
      if (reader) {
        try {
          await reader.cancel(cause);
        } catch {
          /* Preserve the original provider failure. */
        }
        reader.releaseLock();
      }
      requestOperation.dispose();
      const error = normalizeModelError(
        cause,
        options.model.provider,
        options.model.modelId,
      );
      if (!error.retryable || attempt === maxRetries) throw error;
      const delayMs = retryDelay(attempt + 1, error, options.retry);
      await options.retry?.onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        error,
      });
      await sleep(delayMs, runSignal);
    }
  }
  throw new StreamProtocolError({
    message: "Model stream retry policy terminated unexpectedly",
  });
};

const validateEventOrder = (
  part: ModelStreamPart,
  state: {
    textEnded: boolean;
    finished: boolean;
    readonly toolCallIds: Set<string>;
  },
  provider: string,
  modelId: string,
): void => {
  const fail = (message: string): never => {
    throw new StreamProtocolError({ message, provider, modelId });
  };
  if (state.finished) fail("Model emitted an event after finish");
  if (part.type === "text-delta") {
    if (state.textEnded || state.toolCallIds.size > 0)
      fail("Text deltas must precede tool calls and finish");
    return;
  }
  state.textEnded = true;
  if (part.type === "tool-call") {
    if (state.toolCallIds.has(part.toolCall.toolCallId))
      fail(`Duplicate tool call id "${part.toolCall.toolCallId}"`);
    state.toolCallIds.add(part.toolCall.toolCallId);
    return;
  }
  state.finished = true;
  if (part.finishReason === "tool-calls" && state.toolCallIds.size === 0)
    fail("tool-calls finish reason requires a tool call");
  if (state.toolCallIds.size > 0 && part.finishReason !== "tool-calls")
    fail("Tool calls require the tool-calls finish reason");
};

async function* nativeParts<Tools extends ToolSet>(
  options: GenerateTextOptions<Tools>,
  messages: readonly ModelMessage[],
  runSignal: AbortSignal,
): AsyncGenerator<ModelStreamPart, void, void> {
  const opened = await openNativeStream(options, messages, runSignal);
  const timeouts = getTimeouts(options.timeouts);
  let completed = false;
  try {
    yield opened.firstPart;
    while (true) {
      const read = await readProviderPart(
        opened.reader,
        opened.requestOperation.signal,
        timeouts.chunkMs,
        "chunk",
      );
      if (read.done) {
        completed = true;
        return;
      }
      yield validateModelStreamPart(
        read.value,
        options.model.provider,
        options.model.modelId,
      );
    }
  } finally {
    if (!completed) {
      try {
        await opened.reader.cancel(runSignal.reason);
      } catch {
        /* The stream's primary error is more actionable. */
      }
    }
    opened.reader.releaseLock();
    opened.requestOperation.dispose();
  }
}

async function* fallbackParts<Tools extends ToolSet>(
  options: GenerateTextOptions<Tools>,
  messages: readonly ModelMessage[],
  runSignal: AbortSignal,
): AsyncGenerator<ModelStreamPart, void, void> {
  const timeouts = getTimeouts(options.timeouts);
  const response = await callModel(
    options.model,
    createModelRequest(options, messages, runSignal),
    {
      maxRetries: options.retry?.maxRetries ?? options.maxRetries ?? 2,
      retry: options.retry,
      requestTimeoutMs: timeouts.requestMs,
    },
  );
  if (response.text.length > 0)
    yield { type: "text-delta", text: response.text };
  for (const toolCall of response.toolCalls)
    yield { type: "tool-call", toolCall };
  yield {
    type: "finish",
    finishReason: response.finishReason,
    usage: response.usage,
    responseId: response.responseId,
    requestId: response.requestId,
    modelId: response.modelId,
    warnings: response.warnings,
    providerMetadata: response.providerMetadata,
  };
}

async function* runStream<Tools extends ToolSet>(
  options: GenerateTextOptions<Tools>,
  runSignal: AbortSignal,
): AsyncGenerator<StreamPart, GenerateTextResult, void> {
  validateOptions({ ...options, abortSignal: runSignal });
  const maxSteps = options.maxSteps ?? 1;
  const timeouts = getTimeouts(options.timeouts);
  const messages = createMessages(options);
  const responseMessages: ModelMessage[] = [];
  const steps: StepResult[] = [];
  let totalUsage = zeroUsage();
  let latestText = "";
  const warnings: ProviderWarning[] = [];

  try {
    for (let index = 0; index < maxSteps; index += 1) {
      if (runSignal.aborted)
        throw toAbortError(runSignal, "Generation stream was aborted");
      const stepNumber = index + 1;
      const textId = `text-${stepNumber}`;
      const state = {
        textEnded: false,
        finished: false,
        toolCallIds: new Set<string>(),
      };
      const toolCalls: ToolCall[] = [];
      let text = "";
      let finishReason: FinishReason | undefined;
      let stepUsage: Usage | undefined;
      let responseId: string | undefined;
      let requestId: string | undefined;
      let responseModelId: string | undefined;
      let providerMetadata: ProviderMetadata | undefined;
      let stepWarnings: readonly ProviderWarning[] = [];
      const providerParts = options.model.stream
        ? nativeParts(options, messages, runSignal)
        : fallbackParts(options, messages, runSignal);
      let textEndEmitted = false;
      try {
        let providerRead = await providerParts.next();
        if (providerRead.done)
          throw new StreamProtocolError({
            message: "Model stream ended without a finish event",
            provider: options.model.provider,
            modelId: options.model.modelId,
          });
        yield { type: "step-start", stepNumber };
        yield { type: "text-start", id: textId };
        while (!providerRead.done) {
          const part = providerRead.value;
          validateEventOrder(
            part,
            state,
            options.model.provider,
            options.model.modelId,
          );
          if (part.type === "text-delta") {
            text += part.text;
            latestText = text;
            yield { type: "text-delta", id: textId, delta: part.text };
          } else if (part.type === "tool-call") {
            toolCalls.push(part.toolCall);
            if (!textEndEmitted) {
              textEndEmitted = true;
              yield { type: "text-end", id: textId };
            }
            yield { type: "tool-call", stepNumber, toolCall: part.toolCall };
          } else {
            finishReason = part.finishReason;
            stepUsage = part.usage;
            responseId = part.responseId;
            requestId = part.requestId;
            responseModelId = part.modelId;
            providerMetadata = part.providerMetadata;
            stepWarnings = part.warnings ?? [];
          }
          providerRead = await providerParts.next();
        }
      } finally {
        await providerParts.return(undefined);
      }
      if (
        !state.finished ||
        finishReason === undefined ||
        stepUsage === undefined
      ) {
        throw new StreamProtocolError({
          message: "Model stream ended without exactly one finish event",
          provider: options.model.provider,
          modelId: options.model.modelId,
        });
      }
      if (!textEndEmitted) yield { type: "text-end", id: textId };
      totalUsage = addUsage(totalUsage, stepUsage);
      latestText = text;
      warnings.push(...stepWarnings);
      yield {
        type: "finish",
        stepNumber,
        finishReason,
        usage: stepUsage,
        responseId,
        requestId,
        modelId: responseModelId,
        warnings: stepWarnings,
        providerMetadata,
      };

      const assistantMessage: ModelMessage = {
        role: "assistant",
        content: text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
      messages.push(assistantMessage);
      responseMessages.push(assistantMessage);
      const toolResults = await Promise.all(
        toolCalls.map((call) =>
          executeTool(
            call,
            getTool(options.tools, call.toolName),
            runSignal,
            timeouts.toolMs,
          ),
        ),
      );
      messages.push(...toolResults);
      responseMessages.push(...toolResults);
      const step: StepResult = {
        stepNumber,
        text,
        toolCalls,
        toolResults,
        finishReason,
        usage: stepUsage,
        responseId,
        requestId,
        modelId: responseModelId,
        warnings: stepWarnings,
        providerMetadata,
      };
      steps.push(step);
      yield { type: "step-finish", stepNumber, step };
      await options.onStepFinish?.(step);

      if (toolCalls.length === 0)
        return {
          text,
          finishReason,
          usage: totalUsage,
          steps,
          responseMessages,
          warnings,
        };
    }
    throw new AgentSdkError({
      code: "MAX_STEPS_EXCEEDED",
      message: `Generation did not finish within ${maxSteps} step${maxSteps === 1 ? "" : "s"}`,
    });
  } catch (error) {
    const partial = createPartialResult(
      latestText,
      totalUsage,
      steps,
      responseMessages,
      warnings,
    );
    if (AgentSdkError.isInstance(error)) throw error.withPartialResult(partial);
    throw error;
  }
}

type StreamView = "full" | "text";

class StreamSession {
  readonly result: Promise<GenerateTextResult>;
  private readonly abortController = new AbortController();
  private readonly iterator: AsyncGenerator<
    StreamPart,
    GenerateTextResult,
    void
  >;
  private owner: StreamView | undefined;
  private settled = false;
  private resolveResult: (result: GenerateTextResult) => void = () => undefined;
  private rejectResult: (error: unknown) => void = () => undefined;

  constructor(options: GenerateTextOptions) {
    const relayAbort = (): void =>
      this.abortController.abort(options.abortSignal?.reason);
    if (options.abortSignal?.aborted) relayAbort();
    else
      options.abortSignal?.addEventListener("abort", relayAbort, {
        once: true,
      });
    this.iterator = runStream(options, this.abortController.signal);
    this.result = new Promise<GenerateTextResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    void this.result.catch(() => undefined);
  }

  claim(view: StreamView): void {
    if (this.owner === undefined) this.owner = view;
    else if (this.owner !== view)
      throw new StreamProtocolError({
        message: `The ${this.owner} stream is already being consumed; fullStream and textStream are alternative views`,
      });
  }

  async next(
    view: StreamView,
  ): Promise<IteratorResult<StreamPart, GenerateTextResult>> {
    this.claim(view);
    try {
      const next = await this.iterator.next();
      if (next.done && !this.settled) {
        this.settled = true;
        this.resolveResult(next.value);
      }
      return next;
    } catch (error) {
      const sdkError = AgentSdkError.isInstance(error)
        ? error
        : new StreamProtocolError({
            message: "Stream orchestration failed",
            cause: error,
          });
      if (!this.settled) {
        this.settled = true;
        this.rejectResult(sdkError);
      }
      throw sdkError;
    }
  }

  async cancel(reason: unknown): Promise<void> {
    const error = AgentSdkError.isInstance(reason)
      ? reason
      : new AbortError({
          message: "Stream consumer cancelled generation",
          cause: reason,
        });
    this.abortController.abort(error);
    try {
      await this.iterator.throw(error);
    } catch {
      /* Cancellation already has a stable error. */
    }
    if (!this.settled) {
      this.settled = true;
      this.rejectResult(error);
    }
  }
}

const createFullStream = (session: StreamSession): ReadableStream<StreamPart> =>
  new ReadableStream<StreamPart>(
    {
      async pull(controller) {
        try {
          const next = await session.next("full");
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          const sdkError = AgentSdkError.isInstance(error)
            ? error
            : new StreamProtocolError({
                message: "Stream failed",
                cause: error,
              });
          controller.enqueue({ type: "error", error: sdkError });
          controller.close();
        }
      },
      cancel(reason) {
        return session.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );

const createTextStream = (session: StreamSession): ReadableStream<string> =>
  new ReadableStream<string>(
    {
      async pull(controller) {
        try {
          while (true) {
            const next = await session.next("text");
            if (next.done) {
              controller.close();
              return;
            }
            if (next.value.type === "text-delta") {
              controller.enqueue(next.value.delta);
              return;
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return session.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );

export const streamText = <Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools>,
): StreamTextResult => {
  validateOptions(options);
  const session = new StreamSession(options);
  return {
    fullStream: createFullStream(session),
    textStream: createTextStream(session),
    result: session.result,
  };
};
