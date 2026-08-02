import {
  AgentSdkError,
  BudgetExceededError,
  ToolApprovalRequiredError,
  ToolError,
  getErrorMessage,
  toAbortError,
} from "../errors/errors";
import {
  getTool,
  normalizeToolRegistry,
  toModelTools,
  type AnyTool,
  type ToolSet,
} from "../tools/tool";
import {
  invokeLifecycle,
  type ContextManager,
  type Cost,
  type LifecycleCallbacks,
  type PrepareStep,
  type RequestToolApproval,
  type RunBudget,
  type StopCondition,
  type ToolExecutionPolicy,
} from "./orchestration";
import {
  addUsage,
  zeroUsage,
  type FinishReason,
  type LanguageModel,
  type ModelMessage,
  type ModelOutputFormat,
  type ModelRequest,
  type ModelResponse,
  type ProviderMetadata,
  type ProviderOptions,
  type ProviderWarning,
  type ToolCall,
  type ToolMessage,
  type Usage,
} from "../model/types";
import {
  createOperationSignal,
  createPartialResult,
  getTimeouts,
  normalizeModelError,
  raceWithSignal,
  validateModelResponse,
  validateMessages,
  validateOptions,
} from "./runtime";
import { wrapLanguageModel } from "../middleware/middleware";
import {
  createTelemetryRuntime,
  type TelemetryOptions,
  type TelemetryRuntime,
} from "../telemetry/telemetry";

export type Prompt =
  | { readonly prompt: string; readonly messages?: never }
  | { readonly messages: readonly ModelMessage[]; readonly prompt?: never };

export interface StepResult {
  readonly stepNumber: number;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly toolResults: readonly ToolMessage[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  readonly responseId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly warnings: readonly ProviderWarning[];
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface PartialGenerateTextResult {
  readonly text: string;
  readonly usage: Usage;
  readonly steps: readonly StepResult[];
  readonly responseMessages: readonly ModelMessage[];
  readonly warnings: readonly ProviderWarning[];
  readonly completedToolResults?: readonly ToolMessage[] | undefined;
}

export interface GenerateTextResult extends PartialGenerateTextResult {
  readonly finishReason: FinishReason;
  readonly stopReason:
    "model-finish" | "stop-condition" | "max-steps" | "budget";
  readonly cost?: Cost | undefined;
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
  readonly providerOptions?: ProviderOptions | undefined;
  readonly runId?: string | undefined;
  readonly context?: unknown;
  readonly activeTools?: readonly (keyof Tools & string)[] | undefined;
  readonly prepareStep?: PrepareStep | undefined;
  readonly stopWhen?: StopCondition | readonly StopCondition[] | undefined;
  readonly toolExecution?: ToolExecutionPolicy | undefined;
  readonly requestToolApproval?: RequestToolApproval | undefined;
  readonly budget?: RunBudget | undefined;
  readonly contextManager?: ContextManager | undefined;
  readonly callbacks?: LifecycleCallbacks | undefined;
  readonly telemetry?: TelemetryOptions | undefined;
  readonly onStepFinish?:
    ((step: StepResult) => void | Promise<void>) | undefined;
};

export const createMessages = (
  options: Prompt & { readonly system?: string | undefined },
): ModelMessage[] => {
  const messages: ModelMessage[] = [];
  if (options.system)
    messages.push({ role: "system", content: options.system });
  if (options.prompt !== undefined)
    messages.push({ role: "user", content: options.prompt });
  else messages.push(...options.messages);
  return messages;
};

export const sleep = (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted)
    return Promise.reject(
      toAbortError(signal, "Generation was aborted during retry backoff"),
    );
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(
        signal
          ? toAbortError(signal, "Generation was aborted during retry backoff")
          : new AgentSdkError({
              code: "ABORTED",
              message: "Generation was aborted",
            }),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
};

export const retryDelay = (
  attempt: number,
  error: AgentSdkError,
  retry: RetryOptions | undefined,
): number => {
  const initial = retry?.initialDelayMs ?? 100;
  const maximum = retry?.maxDelayMs ?? 10_000;
  const factor = retry?.backoffFactor ?? 2;
  const jitter = retry?.jitter ?? 0.2;
  const exponential = Math.min(maximum, initial * factor ** (attempt - 1));
  const randomized = exponential * (1 - jitter + Math.random() * jitter * 2);
  return Math.min(
    maximum,
    Math.max(error.retryAfterMs ?? 0, Math.round(randomized)),
  );
};

export const callModel = async (
  model: LanguageModel,
  request: ModelRequest,
  options: {
    readonly maxRetries: number;
    readonly retry?: RetryOptions | undefined;
    readonly requestTimeoutMs: number;
  },
): Promise<ModelResponse> => {
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    if (request.abortSignal?.aborted)
      throw toAbortError(request.abortSignal, "Generation was aborted");
    const operation = createOperationSignal(
      request.abortSignal,
      options.requestTimeoutMs,
      "request",
    );
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
      await options.retry?.onRetry?.({
        attempt: attempt + 1,
        maxRetries: options.maxRetries,
        delayMs,
        error,
      });
      await sleep(delayMs, request.abortSignal);
    } finally {
      operation.dispose();
    }
  }
  throw new AgentSdkError({
    code: "MODEL_ERROR",
    message: "Model retry policy terminated unexpectedly",
  });
};

export const executeTool = async (
  call: ToolCall,
  definition: AnyTool | undefined,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  run: {
    readonly runId: string;
    readonly stepNumber: number;
    readonly context?: unknown;
    readonly requestToolApproval?: RequestToolApproval | undefined;
    readonly callbacks?: LifecycleCallbacks | undefined;
    readonly telemetry?: TelemetryRuntime | undefined;
  },
): Promise<ToolMessage> => {
  if (!definition) {
    throw new ToolError({
      code: "TOOL_NOT_FOUND",
      message: `Model requested unknown tool "${call.toolName}"`,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
    });
  }
  const context = {
    runId: run.runId,
    stepNumber: run.stepNumber,
    toolCallId: call.toolCallId,
    idempotencyKey: `${run.runId}:${call.toolCallId}`,
    context: run.context,
    abortSignal,
  };
  const requiresApproval = await definition.requiresApproval(
    call.input,
    context,
  );
  if (requiresApproval) {
    const outcome =
      (await run.requestToolApproval?.({
        ...context,
        toolName: call.toolName,
        input: call.input,
      })) ?? "user-approval";
    if (
      outcome !== "approved" &&
      outcome !== "denied" &&
      outcome !== "user-approval" &&
      outcome !== "not-applicable"
    )
      throw new AgentSdkError({
        code: "INVALID_ARGUMENT",
        message: `Approval handler returned an invalid outcome for tool "${call.toolName}"`,
      });
    if (outcome === "user-approval")
      throw new ToolApprovalRequiredError({
        requests: [
          {
            runId: run.runId,
            stepNumber: run.stepNumber,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          },
        ],
      });
    if (outcome === "denied") {
      if (run.callbacks?.onToolExecutionEnd)
        await invokeLifecycle(
          run.callbacks.onToolExecutionEnd,
          "onToolExecutionEnd",
          {
            runId: run.runId,
            context: run.context,
            stepNumber: run.stepNumber,
            toolCall: call,
            outcome: "denied",
          },
        );
      return {
        role: "tool",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { error: "Tool execution was denied" },
        isError: true,
      };
    }
  }
  if (run.callbacks?.onToolExecutionStart)
    await invokeLifecycle(
      run.callbacks.onToolExecutionStart,
      "onToolExecutionStart",
      {
        runId: run.runId,
        context: run.context,
        stepNumber: run.stepNumber,
        toolCall: call,
      },
    );
  const telemetryScope = run.telemetry?.startTool(
    call.toolName,
    call.toolCallId,
    call.input,
  );
  const operation = createOperationSignal(
    abortSignal,
    definition.timeoutMs ?? timeoutMs,
    "tool",
  );
  try {
    const output = await raceWithSignal(
      definition.invoke(call.input, {
        ...context,
        abortSignal: operation.signal,
      }),
      operation.signal,
      `Tool "${call.toolName}" was aborted`,
    );
    const result: ToolMessage = {
      role: "tool",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output,
    };
    if (telemetryScope) {
      run.telemetry?.recordToolOutput(telemetryScope, output);
      telemetryScope.endSuccess();
    }
    if (run.callbacks?.onToolExecutionEnd)
      await invokeLifecycle(
        run.callbacks.onToolExecutionEnd,
        "onToolExecutionEnd",
        {
          runId: run.runId,
          context: run.context,
          stepNumber: run.stepNumber,
          toolCall: call,
          outcome: "success",
          output,
        },
      );
    return result;
  } catch (error) {
    telemetryScope?.endError(error);
    if (
      AgentSdkError.isInstance(error) &&
      (error.code === "ABORTED" || error.code === "TIMEOUT")
    )
      throw error;
    if (
      AgentSdkError.isInstance(error) &&
      error.code === "LIFECYCLE_CALLBACK_FAILED"
    )
      throw error;
    if (error instanceof ToolError) throw error;
    const code = AgentSdkError.isInstance(error)
      ? error.code === "TOOL_INPUT_INVALID"
        ? "TOOL_INPUT_INVALID"
        : error.code === "TOOL_OUTPUT_INVALID"
          ? "TOOL_OUTPUT_INVALID"
          : "TOOL_EXECUTION_FAILED"
      : "TOOL_EXECUTION_FAILED";
    const toolError = new ToolError({
      code,
      message: `Tool "${call.toolName}" failed: ${getErrorMessage(error)}`,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      cause: error,
    });
    if (run.callbacks?.onToolExecutionEnd)
      await invokeLifecycle(
        run.callbacks.onToolExecutionEnd,
        "onToolExecutionEnd",
        {
          runId: run.runId,
          context: run.context,
          stepNumber: run.stepNumber,
          toolCall: call,
          outcome: "error",
          error: toolError,
        },
      );
    throw toolError;
  } finally {
    operation.dispose();
  }
};

export const createModelRequest = <Tools extends ToolSet>(
  options: GenerateTextOptions<Tools>,
  messages: readonly ModelMessage[],
  abortSignal = options.abortSignal,
  overrides?: {
    readonly tools?: ToolSet | undefined;
    readonly temperature?: number | undefined;
    readonly maxOutputTokens?: number | undefined;
    readonly providerOptions?: ProviderOptions | undefined;
    readonly outputFormat?: ModelOutputFormat | undefined;
  },
): ModelRequest => ({
  messages: [...messages],
  tools: toModelTools(overrides?.tools ?? options.tools),
  temperature: overrides?.temperature ?? options.temperature,
  maxOutputTokens: overrides?.maxOutputTokens ?? options.maxOutputTokens,
  abortSignal,
  headers: options.headers,
  providerOptions: overrides?.providerOptions ?? options.providerOptions,
  outputFormat: overrides?.outputFormat,
});

export const executeTools = async (
  calls: readonly ToolCall[],
  tools: ToolSet,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
  run: Parameters<typeof executeTool>[4],
  policy: ToolExecutionPolicy | undefined,
): Promise<readonly ToolMessage[]> => {
  const maxConcurrency =
    policy?.mode === "sequential" ? 1 : (policy?.maxConcurrency ?? 4);
  const results: (ToolMessage | undefined)[] = new Array(calls.length);
  let nextIndex = 0;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      const call = calls[index];
      if (!call) return;
      try {
        results[index] = await executeTool(
          call,
          getTool(tools, call.toolName),
          abortSignal,
          timeoutMs,
          run,
        );
      } catch (error) {
        if (policy?.errorMode === "return-errors") {
          results[index] = {
            role: "tool",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { error: getErrorMessage(error) },
            isError: true,
          };
        } else failure = error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, calls.length) }, worker),
  );
  if (failure !== undefined) {
    const completed = results.filter(
      (result): result is ToolMessage => result !== undefined,
    );
    if (AgentSdkError.isInstance(failure))
      throw failure.withPartialResult(completed);
    throw failure;
  }
  return results.filter(
    (result): result is ToolMessage => result !== undefined,
  );
};

const stopRequested = async (
  stopWhen: StopCondition | readonly StopCondition[] | undefined,
  context: Parameters<StopCondition>[0],
): Promise<boolean> => {
  const conditions = stopWhen
    ? Array.isArray(stopWhen)
      ? stopWhen
      : [stopWhen]
    : [];
  for (const condition of conditions) if (await condition(context)) return true;
  return false;
};

const budgetExceeded = (
  budget: RunBudget | undefined,
  usage: Usage,
  cost: Cost | undefined,
): boolean =>
  (budget?.tokens?.maxInputTokens !== undefined &&
    usage.inputTokens >= budget.tokens.maxInputTokens) ||
  (budget?.tokens?.maxOutputTokens !== undefined &&
    usage.outputTokens >= budget.tokens.maxOutputTokens) ||
  (budget?.tokens?.maxTotalTokens !== undefined &&
    usage.totalTokens >= budget.tokens.maxTotalTokens) ||
  (budget?.cost !== undefined &&
    cost !== undefined &&
    cost.amount >= budget.cost.maximum.amount);

export const generateTextInternal = async <Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools>,
  outputFormat?: ModelOutputFormat,
): Promise<GenerateTextResult> => {
  validateOptions(options);
  const maxSteps = options.maxSteps ?? 1;
  const maxRetries = options.retry?.maxRetries ?? options.maxRetries ?? 2;
  const timeouts = getTimeouts(options.timeouts);
  const normalizedTools = normalizeToolRegistry(options.tools);
  const messages = createMessages(options);
  const responseMessages: ModelMessage[] = [];
  const steps: StepResult[] = [];
  let usage = zeroUsage();
  let text = "";
  const warnings: ProviderWarning[] = [];
  const runId = options.runId ?? crypto.randomUUID();
  const telemetry = createTelemetryRuntime(options.telemetry);
  const runTelemetry = telemetry?.startRun("generate_text", runId);
  let cost: Cost | undefined;
  const retry = options.callbacks?.onRetry || telemetry
    ? {
        ...options.retry,
        async onRetry(event: RetryEvent): Promise<void> {
          await options.retry?.onRetry?.(event);
          await invokeLifecycle(options.callbacks?.onRetry, "onRetry", event);
          telemetry?.recordRetry(event);
        },
      }
    : options.retry;

  try {
    if (options.callbacks?.onStart)
      await invokeLifecycle(options.callbacks.onStart, "onStart", {
        runId,
        context: options.context,
      });
    for (let index = 0; index < maxSteps; index += 1) {
      const stepNumber = index + 1;
      const stepContext = {
        runId,
        context: options.context,
        stepNumber,
        messages: [...messages],
        steps: [...steps],
        usage,
      };
      if (options.callbacks?.onStepStart)
        await invokeLifecycle(
          options.callbacks.onStepStart,
          "onStepStart",
          stepContext,
        );
      const prepared = options.prepareStep
        ? await options.prepareStep(stepContext)
        : undefined;
      const requestMessages =
        (options.contextManager?.prepareMessages
          ? await options.contextManager.prepareMessages(stepContext)
          : undefined) ?? messages;
      validateMessages(requestMessages);
      const activeNames =
        prepared?.activeTools ?? options.activeTools ?? normalizedTools.names;
      const activeTools: Record<string, AnyTool> = Object.create(null);
      for (const name of activeNames) {
        const definition = getTool(normalizedTools.tools, name);
        if (!definition)
          throw new AgentSdkError({
            code: "INVALID_ARGUMENT",
            message: `Unknown active tool "${name}"`,
          });
        activeTools[name] = definition;
      }
      const model = prepared?.model ?? options.model;
      const instrumentedModel = telemetry
        ? wrapLanguageModel({
            model,
            middleware: [telemetry.modelMiddleware(stepNumber)],
          })
        : model;
      const remainingOutputTokens =
        options.budget?.tokens?.maxOutputTokens === undefined
          ? undefined
          : Math.max(
              1,
              options.budget.tokens.maxOutputTokens - usage.outputTokens,
            );
      const requestedOutputTokens =
        prepared?.maxOutputTokens ?? options.maxOutputTokens;
      const effectiveOutputTokens =
        remainingOutputTokens === undefined
          ? requestedOutputTokens
          : requestedOutputTokens === undefined
            ? remainingOutputTokens
            : Math.min(requestedOutputTokens, remainingOutputTokens);
      const response = await callModel(
        instrumentedModel,
        createModelRequest(options, requestMessages, options.abortSignal, {
          tools: activeTools,
          temperature: prepared?.temperature,
          maxOutputTokens: effectiveOutputTokens,
          providerOptions: prepared?.providerOptions,
          outputFormat,
        }),
        {
          maxRetries,
          retry,
          requestTimeoutMs: timeouts.requestMs,
        },
      );
      text = response.text;
      usage = addUsage(usage, response.usage);
      warnings.push(...(response.warnings ?? []));
      if (options.budget?.cost) {
        const stepCost = options.budget.cost.calculate({
          model,
          usage: response.usage,
        });
        if (
          !Number.isFinite(stepCost.amount) ||
          stepCost.amount < 0 ||
          stepCost.currency !== options.budget.cost.maximum.currency
        )
          throw new BudgetExceededError({
            budget: "cost",
            message:
              "Cost calculator currency does not match the configured budget",
          });
        cost = {
          amount: (cost?.amount ?? 0) + stepCost.amount,
          currency: stepCost.currency,
        };
        telemetry?.recordCost(stepCost, model.provider, model.modelId);
      }
      const assistantMessage: ModelMessage = {
        role: "assistant",
        content: response.content ?? response.text,
        toolCalls:
          response.toolCalls.length > 0 ? response.toolCalls : undefined,
      };
      messages.push(assistantMessage);
      responseMessages.push(assistantMessage);

      const shouldStop = await stopRequested(options.stopWhen, {
        ...stepContext,
        usage,
        toolCalls: response.toolCalls,
      });
      const reachedMaxSteps =
        stepNumber >= maxSteps && response.toolCalls.length > 0;
      const reachedBudget = budgetExceeded(options.budget, usage, cost);
      const toolResults =
        shouldStop || reachedMaxSteps || reachedBudget
          ? []
          : await executeTools(
              response.toolCalls,
              normalizedTools.tools,
              options.abortSignal,
              timeouts.toolMs,
              {
                runId,
                stepNumber,
                context: options.context,
                requestToolApproval: options.requestToolApproval,
                callbacks: options.callbacks,
                telemetry,
              },
              options.toolExecution,
            );
      messages.push(...toolResults);
      responseMessages.push(...toolResults);

      const step: StepResult = {
        stepNumber,
        text: response.text,
        toolCalls: response.toolCalls,
        toolResults,
        finishReason: response.finishReason,
        usage: response.usage,
        responseId: response.responseId,
        requestId: response.requestId,
        modelId: response.modelId,
        warnings: response.warnings ?? [],
        providerMetadata: response.providerMetadata,
      };
      steps.push(step);
      await options.onStepFinish?.(step);
      if (options.callbacks?.onStepEnd)
        await invokeLifecycle(options.callbacks.onStepEnd, "onStepEnd", {
          ...step,
          runId,
          context: options.context,
        });

      if (
        response.toolCalls.length === 0 ||
        shouldStop ||
        reachedMaxSteps ||
        reachedBudget
      ) {
        const result: GenerateTextResult = {
          text,
          finishReason: response.finishReason,
          stopReason:
            response.toolCalls.length === 0
              ? "model-finish"
              : reachedBudget
                ? "budget"
                : reachedMaxSteps
                  ? "max-steps"
                  : "stop-condition",
          usage,
          steps,
          responseMessages,
          warnings,
          cost,
        };
        if (options.callbacks?.onFinish)
          await invokeLifecycle(options.callbacks.onFinish, "onFinish", {
            runId,
            context: options.context,
            steps,
            usage,
          });
        runTelemetry?.endSuccess({
          "open_agent.finish_reason": response.finishReason,
          "gen_ai.usage.input_tokens": usage.inputTokens,
          "gen_ai.usage.output_tokens": usage.outputTokens,
        });
        return result;
      }
    }
    throw new AgentSdkError({
      code: "MAX_STEPS_EXCEEDED",
      message: `Generation did not finish within ${maxSteps} step${maxSteps === 1 ? "" : "s"}`,
    });
  } catch (error) {
    runTelemetry?.endError(error);
    const partial = createPartialResult(
      text,
      usage,
      steps,
      responseMessages,
      warnings,
    );
    try {
      if (options.callbacks?.onError)
        await invokeLifecycle(options.callbacks.onError, "onError", {
          runId,
          context: options.context,
          error,
        });
    } catch {
      // Preserve the execution failure; callback failures must not replace it.
    }
    if (AgentSdkError.isInstance(error)) {
      const completedToolResults = Array.isArray(error.partialResult)
        ? error.partialResult.filter(
            (value): value is ToolMessage =>
              typeof value === "object" &&
              value !== null &&
              "role" in value &&
              value.role === "tool" &&
              "toolCallId" in value &&
              typeof value.toolCallId === "string" &&
              "toolName" in value &&
              typeof value.toolName === "string" &&
              "output" in value,
          )
        : undefined;
      throw error.withPartialResult({ ...partial, completedToolResults });
    }
    throw error;
  }
};

export const generateText = <Tools extends ToolSet = ToolSet>(
  options: GenerateTextOptions<Tools>,
): Promise<GenerateTextResult> => generateTextInternal(options);
