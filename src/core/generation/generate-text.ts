import {
  AgentSdkError,
  ToolError,
  getErrorMessage,
  toAbortError,
} from "../errors/errors";
import { getTool, toModelTools, type AnyTool, type ToolSet } from "../tools/tool";
import {
  addUsage,
  zeroUsage,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
  type Usage,
} from "../model/types";
import {
  createOperationSignal,
  createPartialResult,
  getTimeouts,
  normalizeModelError,
  raceWithSignal,
  validateModelResponse,
  validateOptions,
} from "./runtime";

export type Prompt =
  | { readonly prompt: string; readonly messages?: never }
  | { readonly messages: readonly ModelMessage[]; readonly prompt?: never };

export interface StepResult {
  readonly stepNumber: number;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly toolResults: readonly ModelMessage[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
}

export interface PartialGenerateTextResult {
  readonly text: string;
  readonly usage: Usage;
  readonly steps: readonly StepResult[];
  readonly responseMessages: readonly ModelMessage[];
}

export interface GenerateTextResult extends PartialGenerateTextResult {
  readonly finishReason: FinishReason;
}

export interface TimeoutOptions {
  readonly requestMs?: number | undefined;
  readonly firstChunkMs?: number | undefined;
  readonly chunkMs?: number | undefined;
  readonly toolMs?: number | undefined;
}

export interface RetryEvent {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly error: AgentSdkError;
}

export interface RetryOptions {
  readonly maxRetries?: number | undefined;
  readonly initialDelayMs?: number | undefined;
  readonly maxDelayMs?: number | undefined;
  readonly backoffFactor?: number | undefined;
  readonly jitter?: number | undefined;
  readonly onRetry?: ((event: RetryEvent) => void | Promise<void>) | undefined;
}

export type GenerateTextOptions<Tools extends ToolSet = ToolSet> = Prompt & {
  readonly model: LanguageModel;
  readonly system?: string | undefined;
  readonly tools?: Tools | undefined;
  readonly maxSteps?: number | undefined;
  /** @deprecated Use retry.maxRetries. */
  readonly maxRetries?: number | undefined;
  readonly retry?: RetryOptions | undefined;
  readonly timeouts?: TimeoutOptions | undefined;
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly onStepFinish?: ((step: StepResult) => void | Promise<void>) | undefined;
};

export const createMessages = (
  options: Prompt & { readonly system?: string | undefined },
): ModelMessage[] => {
  const messages: ModelMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  if (options.prompt !== undefined) messages.push({ role: "user", content: options.prompt });
  else messages.push(...options.messages);
  return messages;
};

export const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(toAbortError(signal, "Generation was aborted during retry backoff"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal ? toAbortError(signal, "Generation was aborted during retry backoff") : new AgentSdkError({ code: "ABORTED", message: "Generation was aborted" }));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
};

export const retryDelay = (attempt: number, error: AgentSdkError, retry: RetryOptions | undefined): number => {
  const initial = retry?.initialDelayMs ?? 100;
  const maximum = retry?.maxDelayMs ?? 10_000;
  const factor = retry?.backoffFactor ?? 2;
  const jitter = retry?.jitter ?? 0.2;
  const exponential = Math.min(maximum, initial * factor ** (attempt - 1));
  const randomized = exponential * (1 - jitter + Math.random() * jitter * 2);
  return Math.min(maximum, Math.max(error.retryAfterMs ?? 0, Math.round(randomized)));
};

export const callModel = async (
  model: LanguageModel,
  request: ModelRequest,
  options: { readonly maxRetries: number; readonly retry?: RetryOptions | undefined; readonly requestTimeoutMs: number },
): Promise<ModelResponse> => {
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    if (request.abortSignal?.aborted) throw toAbortError(request.abortSignal, "Generation was aborted");
    const operation = createOperationSignal(request.abortSignal, options.requestTimeoutMs, "request");
    try {
      const response = await raceWithSignal(
        model.generate({ ...request, abortSignal: operation.signal }),
        operation.signal,
        "Model request was aborted",
      );
      return validateModelResponse(response, model.provider, model.modelId);
    } catch (cause) {
      const error = normalizeModelError(cause, model.provider, model.modelId);
      if (!error.retryable || attempt === options.maxRetries) throw error;
      const delayMs = retryDelay(attempt + 1, error, options.retry);
      await options.retry?.onRetry?.({ attempt: attempt + 1, maxRetries: options.maxRetries, delayMs, error });
      await sleep(delayMs, request.abortSignal);
    } finally {
      operation.dispose();
    }
  }
  throw new AgentSdkError({ code: "MODEL_ERROR", message: "Model retry policy terminated unexpectedly" });
};

export const executeTool = async (
  call: ToolCall,
  definition: AnyTool | undefined,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ModelMessage> => {
  if (!definition) {
    throw new ToolError({
      code: "TOOL_NOT_FOUND",
      message: `Model requested unknown tool "${call.toolName}"`,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
    });
  }
  const operation = createOperationSignal(abortSignal, timeoutMs, "tool");
  try {
    const output = await raceWithSignal(
      definition.invoke(call.input, { toolCallId: call.toolCallId, abortSignal: operation.signal }),
      operation.signal,
      `Tool "${call.toolName}" was aborted`,
    );
    return { role: "tool", toolCallId: call.toolCallId, toolName: call.toolName, output };
  } catch (error) {
    if (AgentSdkError.isInstance(error) && (error.code === "ABORTED" || error.code === "TIMEOUT")) throw error;
    if (error instanceof ToolError) throw error;
    const code = AgentSdkError.isInstance(error) && error.code === "TOOL_INPUT_INVALID"
      ? "TOOL_INPUT_INVALID"
      : "TOOL_EXECUTION_FAILED";
    throw new ToolError({
      code,
      message: `Tool "${call.toolName}" failed: ${getErrorMessage(error)}`,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      cause: error,
    });
  } finally {
    operation.dispose();
  }
};

export const createModelRequest = <Tools extends ToolSet>(
  options: GenerateTextOptions<Tools>,
  messages: readonly ModelMessage[],
  abortSignal = options.abortSignal,
): ModelRequest => ({
  messages: [...messages],
  tools: toModelTools(options.tools),
  temperature: options.temperature,
  maxOutputTokens: options.maxOutputTokens,
  abortSignal,
  headers: options.headers,
});

export const generateText = async <Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools>,
): Promise<GenerateTextResult> => {
  validateOptions(options);
  const maxSteps = options.maxSteps ?? 1;
  const maxRetries = options.retry?.maxRetries ?? options.maxRetries ?? 2;
  const timeouts = getTimeouts(options.timeouts);
  const messages = createMessages(options);
  const responseMessages: ModelMessage[] = [];
  const steps: StepResult[] = [];
  let usage = zeroUsage();
  let text = "";

  try {
    for (let index = 0; index < maxSteps; index += 1) {
      const response = await callModel(options.model, createModelRequest(options, messages), {
        maxRetries,
        retry: options.retry,
        requestTimeoutMs: timeouts.requestMs,
      });
      text = response.text;
      usage = addUsage(usage, response.usage);
      const assistantMessage: ModelMessage = {
        role: "assistant",
        content: response.text,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      };
      messages.push(assistantMessage);
      responseMessages.push(assistantMessage);

      const toolResults = await Promise.all(response.toolCalls.map((call) =>
        executeTool(call, getTool(options.tools, call.toolName), options.abortSignal, timeouts.toolMs),
      ));
      messages.push(...toolResults);
      responseMessages.push(...toolResults);

      const step: StepResult = {
        stepNumber: index + 1,
        text: response.text,
        toolCalls: response.toolCalls,
        toolResults,
        finishReason: response.finishReason,
        usage: response.usage,
      };
      steps.push(step);
      await options.onStepFinish?.(step);

      if (response.toolCalls.length === 0) {
        return { text, finishReason: response.finishReason, usage, steps, responseMessages };
      }
    }
    throw new AgentSdkError({
      code: "MAX_STEPS_EXCEEDED",
      message: `Generation did not finish within ${maxSteps} step${maxSteps === 1 ? "" : "s"}`,
    });
  } catch (error) {
    const partial = createPartialResult(text, usage, steps, responseMessages);
    if (AgentSdkError.isInstance(error)) throw error.withPartialResult(partial);
    throw error;
  }
};
