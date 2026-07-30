import {
  AbortError,
  AgentSdkError,
  ModelResponseError,
  NetworkError,
  StreamProtocolError,
  TimeoutError,
  toAbortError,
  type TimeoutKind,
} from "../errors/errors";
import type {
  FinishReason,
  ModelMessage,
  ModelResponse,
  ModelStreamPart,
  ToolCall,
  Usage,
} from "../model/types";
import type { GenerateTextOptions, RetryOptions, TimeoutOptions } from "./generate-text";
import type { ToolSet } from "../tools/tool";

const finishReasons: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "other",
]);

const isRecord = (value: unknown): value is Readonly<Record<PropertyKey, unknown>> =>
  typeof value === "object" && value !== null;

const invalidArgument = (message: string): never => {
  throw new AgentSdkError({ code: "INVALID_ARGUMENT", message });
};

const validateInteger = (name: string, value: number, minimum: number, maximum: number): void => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalidArgument(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
};

const validateTimeout = (name: string, value: number | undefined): void => {
  if (value !== undefined) validateInteger(name, value, 1, 86_400_000);
};

const validateRetryOptions = (retry: RetryOptions | undefined): void => {
  if (!retry) return;
  validateTimeout("retry.initialDelayMs", retry.initialDelayMs);
  validateTimeout("retry.maxDelayMs", retry.maxDelayMs);
  if (retry.backoffFactor !== undefined && (!Number.isFinite(retry.backoffFactor) || retry.backoffFactor < 1 || retry.backoffFactor > 10)) {
    invalidArgument("retry.backoffFactor must be finite and between 1 and 10");
  }
  if (retry.jitter !== undefined && (!Number.isFinite(retry.jitter) || retry.jitter < 0 || retry.jitter > 1)) {
    invalidArgument("retry.jitter must be finite and between 0 and 1");
  }
};

const validateMessage = (message: unknown, index: number): void => {
  if (isRecord(message)) {
    if (typeof message["role"] !== "string") invalidArgument(`messages[${index}] must have a valid role`);
    const role = message["role"];
    if (role === "system" || role === "user") {
      if (typeof message["content"] !== "string") invalidArgument(`messages[${index}].content must be a string`);
      return;
    }
    if (role === "assistant") {
      if (typeof message["content"] !== "string") invalidArgument(`messages[${index}].content must be a string`);
      const toolCalls = message["toolCalls"];
      if (toolCalls !== undefined && !Array.isArray(toolCalls)) invalidArgument(`messages[${index}].toolCalls must be an array`);
      return;
    }
    if (role === "tool") {
      if (typeof message["toolCallId"] !== "string" || typeof message["toolName"] !== "string") {
        invalidArgument(`messages[${index}] must contain string toolCallId and toolName values`);
      }
      return;
    }
    invalidArgument(`messages[${index}].role is unsupported`);
  }
  invalidArgument(`messages[${index}] must be an object`);
};

export const validateOptions = <Tools extends ToolSet>(options: GenerateTextOptions<Tools>): void => {
  const hasPrompt = typeof options.prompt === "string";
  const hasMessages = Array.isArray(options.messages);
  if (hasPrompt === hasMessages) invalidArgument("Exactly one of prompt or messages must be provided");
  if (options.prompt !== undefined && typeof options.prompt !== "string") invalidArgument("prompt must be a string");
  if (options.messages !== undefined) options.messages.forEach(validateMessage);

  const maxSteps = options.maxSteps ?? 1;
  const maxRetries = options.retry?.maxRetries ?? options.maxRetries ?? 2;
  validateInteger("maxSteps", maxSteps, 1, 100);
  validateInteger("maxRetries", maxRetries, 0, 10);
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) {
    invalidArgument("temperature must be finite and between 0 and 2");
  }
  if (options.maxOutputTokens !== undefined) validateInteger("maxOutputTokens", options.maxOutputTokens, 1, 10_000_000);
  validateTimeout("timeouts.requestMs", options.timeouts?.requestMs);
  validateTimeout("timeouts.firstChunkMs", options.timeouts?.firstChunkMs);
  validateTimeout("timeouts.chunkMs", options.timeouts?.chunkMs);
  validateTimeout("timeouts.toolMs", options.timeouts?.toolMs);
  validateRetryOptions(options.retry);

  if (options.abortSignal?.aborted) throw toAbortError(options.abortSignal, "Generation was aborted before it started");
  if (options.tools) {
    for (const [key, definition] of Object.entries(options.tools)) {
      if (typeof definition !== "object" || definition === null || typeof definition.name !== "string" || typeof definition.invoke !== "function") {
        invalidArgument(`Tool registry entry "${key}" is malformed`);
      }
      if (key !== definition.name) invalidArgument(`Tool registry key "${key}" does not match declared name "${definition.name}"`);
    }
  }
};

const readFiniteNonNegative = (record: Readonly<Record<PropertyKey, unknown>>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
};

export const validateUsage = (value: unknown, error: (message: string) => AgentSdkError): Usage => {
  if (!isRecord(value)) throw error("usage must be an object");
  const inputTokens = readFiniteNonNegative(value, "inputTokens");
  const outputTokens = readFiniteNonNegative(value, "outputTokens");
  const totalTokens = readFiniteNonNegative(value, "totalTokens");
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    throw error("usage token counts must be finite, non-negative numbers");
  }
  if (totalTokens < inputTokens + outputTokens) throw error("usage.totalTokens cannot be less than inputTokens + outputTokens");
  return { inputTokens, outputTokens, totalTokens };
};

const validateToolCall = (value: unknown, error: (message: string) => AgentSdkError): ToolCall => {
  if (!isRecord(value)) throw error("tool call must be an object");
  const toolCallId = value["toolCallId"];
  const toolName = value["toolName"];
  if (typeof toolCallId !== "string" || toolCallId.length === 0) throw error("toolCallId must be a non-empty string");
  if (typeof toolName !== "string" || toolName.length === 0) throw error("toolName must be a non-empty string");
  return { toolCallId, toolName, input: value["input"] };
};

const validateFinishReason = (value: unknown, error: (message: string) => AgentSdkError): FinishReason => {
  if (typeof value === "string" && finishReasons.has(value)) {
    if (value === "stop" || value === "length" || value === "tool-calls" || value === "content-filter" || value === "error" || value === "other") return value;
  }
  throw error("finishReason is invalid");
};

export const validateModelResponse = (value: unknown, provider: string, modelId: string): ModelResponse => {
  const error = (message: string): ModelResponseError => new ModelResponseError({ message: `Invalid model response: ${message}`, provider, modelId });
  if (!isRecord(value)) throw error("response must be an object");
  if (typeof value["text"] !== "string") throw error("text must be a string");
  if (!Array.isArray(value["toolCalls"])) throw error("toolCalls must be an array");
  const toolCalls = value["toolCalls"].map((toolCall) => validateToolCall(toolCall, error));
  const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.toolCallId));
  if (toolCallIds.size !== toolCalls.length) throw error("tool call ids must be unique");
  const finishReason = validateFinishReason(value["finishReason"], error);
  const usage = validateUsage(value["usage"], error);
  if (finishReason === "tool-calls" && toolCalls.length === 0) throw error("tool-calls finish reason requires at least one tool call");
  if (toolCalls.length > 0 && finishReason !== "tool-calls") throw error("tool calls require the tool-calls finish reason");
  const responseId = value["responseId"];
  const responseModelId = value["modelId"];
  const timestamp = value["timestamp"];
  if (responseId !== undefined && typeof responseId !== "string") throw error("responseId must be a string");
  if (responseModelId !== undefined && typeof responseModelId !== "string") throw error("modelId must be a string");
  if (timestamp !== undefined && (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime()))) throw error("timestamp must be a valid Date");
  return { text: value["text"], toolCalls, finishReason, usage, responseId, modelId: responseModelId, timestamp };
};

export const validateModelStreamPart = (value: unknown, provider: string, modelId: string): ModelStreamPart => {
  const error = (message: string): StreamProtocolError => new StreamProtocolError({ message: `Invalid model stream: ${message}`, provider, modelId });
  if (!isRecord(value) || typeof value["type"] !== "string") throw error("event must have a string type");
  if (value["type"] === "text-delta") {
    if (typeof value["text"] !== "string" || value["text"].length === 0) throw error("text-delta text must be a non-empty string");
    return { type: "text-delta", text: value["text"] };
  }
  if (value["type"] === "tool-call") return { type: "tool-call", toolCall: validateToolCall(value["toolCall"], error) };
  if (value["type"] === "finish") {
    const finishReason = validateFinishReason(value["finishReason"], error);
    const usage = validateUsage(value["usage"], error);
    if (value["responseId"] !== undefined && typeof value["responseId"] !== "string") throw error("finish responseId must be a string");
    return { type: "finish", finishReason, usage, responseId: value["responseId"] };
  }
  throw error(`unknown event type "${value["type"]}"`);
};

export interface OperationSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

export const createOperationSignal = (
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
  timeoutKind: TimeoutKind,
): OperationSignal => {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    controller.abort(new TimeoutError({ timeoutKind, timeoutMs }));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
};

export const raceWithSignal = <T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> => {
  if (signal.aborted) return Promise.reject(toAbortError(signal, message));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(toAbortError(signal, message));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

export const normalizeModelError = (error: unknown, provider: string, modelId: string): AgentSdkError => {
  if (AgentSdkError.isInstance(error)) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new AbortError({ cause: error, provider, modelId });
  if (error instanceof TypeError) return new NetworkError({ cause: error, provider, modelId });
  if (isRecord(error)) {
    const rawStatus = error["statusCode"] ?? error["status"];
    const statusCode = typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : undefined;
    const rawRetryAfter = error["retryAfterMs"] ?? error["retryAfter"];
    const retryAfterMs = typeof rawRetryAfter === "number" && Number.isFinite(rawRetryAfter) && rawRetryAfter >= 0
      ? rawRetryAfter
      : typeof rawRetryAfter === "string" && Number.isFinite(Number(rawRetryAfter))
        ? Math.max(0, Number(rawRetryAfter) * 1_000)
        : undefined;
    if (statusCode !== undefined) {
      const retryable = statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599 && statusCode !== 501);
      return new AgentSdkError({
        code: "MODEL_ERROR",
        message: retryable ? "The model provider is temporarily unavailable" : "The model provider rejected the request",
        cause: error,
        provider,
        modelId,
        statusCode,
        retryAfterMs,
        retryable,
      });
    }
  }
  return new AgentSdkError({ code: "MODEL_ERROR", message: "Model request failed", cause: error, provider, modelId });
};

export interface ResolvedTimeouts {
  readonly requestMs: number;
  readonly firstChunkMs: number;
  readonly chunkMs: number;
  readonly toolMs: number;
}

export const getTimeouts = (timeouts: TimeoutOptions | undefined): ResolvedTimeouts => ({
  requestMs: timeouts?.requestMs ?? 60_000,
  firstChunkMs: timeouts?.firstChunkMs ?? 30_000,
  chunkMs: timeouts?.chunkMs ?? 30_000,
  toolMs: timeouts?.toolMs ?? 30_000,
});

export const createPartialResult = (
  text: string,
  usage: Usage,
  steps: readonly import("./generate-text").StepResult[],
  responseMessages: readonly ModelMessage[],
): import("./generate-text").PartialGenerateTextResult => ({ text, usage, steps, responseMessages });
