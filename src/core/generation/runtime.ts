import {
  AbortError,
  AgentSdkError,
  AuthenticationError,
  InvalidRequestError,
  ModelResponseError,
  NetworkError,
  RateLimitError,
  StreamProtocolError,
  TimeoutError,
  toAbortError,
  type TimeoutKind,
} from "../errors/errors";
import type {
  ContentPart,
  FinishReason,
  ModelMessage,
  MessageContent,
  ModelResponse,
  ModelStreamPart,
  ProviderMetadata,
  ProviderWarning,
  ToolCall,
  Usage,
} from "../model/types";
import type {
  GenerateTextOptions,
  RetryOptions,
  TimeoutOptions,
} from "./generate-text";
import type { ToolSet } from "../tools/tool";

const finishReasons: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "other",
]);

const isRecord = (
  value: unknown,
): value is Readonly<Record<PropertyKey, unknown>> =>
  typeof value === "object" && value !== null;

const isJsonValue = (
  value: unknown,
): value is import("../model/types").JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
};

const validateProviderMetadata = (
  value: unknown,
  error: (message: string) => AgentSdkError,
): ProviderMetadata | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isJsonValue(value))
    throw error("providerMetadata must contain only JSON values");
  return Object.fromEntries(Object.entries(value));
};

const validateWarnings = (
  value: unknown,
  error: (message: string) => AgentSdkError,
): readonly ProviderWarning[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw error("warnings must be an array");
  return value.map((warning) => {
    if (!isRecord(warning)) throw error("warning must be an object");
    const type = warning["type"];
    if (type !== "unsupported" && type !== "compatibility" && type !== "other")
      throw error("warning type is invalid");
    if (
      typeof warning["message"] !== "string" ||
      warning["message"].length === 0
    )
      throw error("warning message must be a non-empty string");
    return { type, message: warning["message"] };
  });
};

const validateContent = (
  value: unknown,
  path: string,
  error: (message: string) => AgentSdkError = (message) =>
    new AgentSdkError({ code: "INVALID_ARGUMENT", message }),
): MessageContent => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value))
    throw error(`${path} must be a string or content-part array`);
  const parts: ContentPart[] = [];
  for (const [partIndex, part] of value.entries()) {
    if (!isRecord(part) || typeof part["type"] !== "string")
      throw error(`${path}[${partIndex}] must be a typed content part`);
    const type = part["type"];
    const providerMetadata = validateProviderMetadata(
      part["providerMetadata"],
      error,
    );
    if (type === "text" || type === "reasoning") {
      if (typeof part["text"] !== "string")
        throw error(`${path}[${partIndex}].text must be a string`);
      parts.push({ type, text: part["text"], providerMetadata });
    } else if (type === "refusal") {
      if (typeof part["refusal"] !== "string")
        throw error(`${path}[${partIndex}].refusal must be a string`);
      parts.push({ type, refusal: part["refusal"], providerMetadata });
    } else if (type === "image" || type === "audio" || type === "file") {
      const data = part["data"];
      const mediaType = part["mediaType"];
      if (
        !(
          typeof data === "string" ||
          data instanceof Uint8Array ||
          data instanceof URL
        )
      )
        throw error(`${path}[${partIndex}].data is invalid`);
      if (
        (type === "audio" || type === "file") &&
        typeof mediaType !== "string"
      )
        throw error(`${path}[${partIndex}].mediaType must be a string`);
      if (mediaType !== undefined && typeof mediaType !== "string")
        throw error(`${path}[${partIndex}].mediaType must be a string`);
      if (type === "image")
        parts.push({ type, data, mediaType, providerMetadata });
      else if (typeof mediaType === "string") {
        if (
          part["filename"] !== undefined &&
          typeof part["filename"] !== "string"
        )
          throw error(`${path}[${partIndex}].filename must be a string`);
        if (type === "audio")
          parts.push({ type, data, mediaType, providerMetadata });
        else
          parts.push({
            type,
            data,
            mediaType,
            filename: part["filename"],
            providerMetadata,
          });
      }
    } else if (type === "tool-call") {
      const call = validateToolCall(part, error);
      parts.push({ type, ...call, providerMetadata });
    } else if (type === "tool-result") {
      if (
        typeof part["toolCallId"] !== "string" ||
        typeof part["toolName"] !== "string"
      )
        throw error(`${path}[${partIndex}] has an invalid tool result`);
      if (part["isError"] !== undefined && typeof part["isError"] !== "boolean")
        throw error(`${path}[${partIndex}].isError must be a boolean`);
      parts.push({
        type,
        toolCallId: part["toolCallId"],
        toolName: part["toolName"],
        output: part["output"],
        isError: part["isError"],
        providerMetadata,
      });
    } else if (type === "source") {
      if (
        typeof part["id"] !== "string" ||
        (part["sourceType"] !== "url" && part["sourceType"] !== "document")
      )
        throw error(`${path}[${partIndex}] has an invalid source`);
      if (part["title"] !== undefined && typeof part["title"] !== "string")
        throw error(`${path}[${partIndex}].title must be a string`);
      if (part["url"] !== undefined && typeof part["url"] !== "string")
        throw error(`${path}[${partIndex}].url must be a string`);
      parts.push({
        type,
        sourceType: part["sourceType"],
        id: part["id"],
        title: part["title"],
        url: part["url"],
        providerMetadata,
      });
    } else if (type === "provider-metadata") {
      const metadata = validateProviderMetadata(part["metadata"], error);
      if (typeof part["provider"] !== "string" || metadata === undefined)
        throw error(`${path}[${partIndex}] has invalid provider metadata`);
      parts.push({ type, provider: part["provider"], metadata });
    } else throw error(`${path}[${partIndex}] has unsupported type "${type}"`);
  }
  return parts;
};

const invalidArgument = (message: string): never => {
  throw new AgentSdkError({ code: "INVALID_ARGUMENT", message });
};

const validateInteger = (
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalidArgument(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
};

const validateTimeout = (name: string, value: number | undefined): void => {
  if (value !== undefined) validateInteger(name, value, 1, 86_400_000);
};

const validateRetryOptions = (retry: RetryOptions | undefined): void => {
  if (!retry) return;
  validateTimeout("retry.initialDelayMs", retry.initialDelayMs);
  validateTimeout("retry.maxDelayMs", retry.maxDelayMs);
  if (
    retry.backoffFactor !== undefined &&
    (!Number.isFinite(retry.backoffFactor) ||
      retry.backoffFactor < 1 ||
      retry.backoffFactor > 10)
  ) {
    invalidArgument("retry.backoffFactor must be finite and between 1 and 10");
  }
  if (
    retry.jitter !== undefined &&
    (!Number.isFinite(retry.jitter) || retry.jitter < 0 || retry.jitter > 1)
  ) {
    invalidArgument("retry.jitter must be finite and between 0 and 1");
  }
};

const validateMessage = (message: unknown, index: number): void => {
  if (isRecord(message)) {
    if (typeof message["role"] !== "string")
      invalidArgument(`messages[${index}] must have a valid role`);
    const role = message["role"];
    if (role === "system" || role === "user") {
      validateContent(message["content"], `messages[${index}].content`);
      return;
    }
    if (role === "assistant") {
      validateContent(message["content"], `messages[${index}].content`);
      const toolCalls = message["toolCalls"];
      if (toolCalls !== undefined && !Array.isArray(toolCalls))
        invalidArgument(`messages[${index}].toolCalls must be an array`);
      return;
    }
    if (role === "tool") {
      if (
        typeof message["toolCallId"] !== "string" ||
        typeof message["toolName"] !== "string"
      ) {
        invalidArgument(
          `messages[${index}] must contain string toolCallId and toolName values`,
        );
      }
      return;
    }
    invalidArgument(`messages[${index}].role is unsupported`);
  }
  invalidArgument(`messages[${index}] must be an object`);
};

export const validateOptions = <Tools extends ToolSet>(
  options: GenerateTextOptions<Tools>,
): void => {
  if (
    !isRecord(options.model) ||
    options.model["specificationVersion"] !== "v1" ||
    typeof options.model["provider"] !== "string" ||
    typeof options.model["modelId"] !== "string" ||
    typeof options.model["generate"] !== "function"
  )
    invalidArgument("model must implement provider protocol v1");
  const hasPrompt = typeof options.prompt === "string";
  const hasMessages = Array.isArray(options.messages);
  if (hasPrompt === hasMessages)
    invalidArgument("Exactly one of prompt or messages must be provided");
  if (options.prompt !== undefined && typeof options.prompt !== "string")
    invalidArgument("prompt must be a string");
  if (options.messages !== undefined) options.messages.forEach(validateMessage);
  if (
    options.providerOptions !== undefined &&
    !isJsonValue(options.providerOptions)
  )
    invalidArgument("providerOptions must contain only JSON values");
  if (options.headers !== undefined) {
    if (!isRecord(options.headers))
      invalidArgument("headers must be an object");
    for (const [name, value] of Object.entries(options.headers)) {
      if (name.length === 0 || typeof value !== "string")
        invalidArgument(
          "headers must contain non-empty names and string values",
        );
    }
  }

  const maxSteps = options.maxSteps ?? 1;
  const maxRetries = options.retry?.maxRetries ?? options.maxRetries ?? 2;
  validateInteger("maxSteps", maxSteps, 1, 100);
  validateInteger("maxRetries", maxRetries, 0, 10);
  if (
    options.temperature !== undefined &&
    (!Number.isFinite(options.temperature) ||
      options.temperature < 0 ||
      options.temperature > 2)
  ) {
    invalidArgument("temperature must be finite and between 0 and 2");
  }
  if (options.maxOutputTokens !== undefined)
    validateInteger("maxOutputTokens", options.maxOutputTokens, 1, 10_000_000);
  validateTimeout("timeouts.requestMs", options.timeouts?.requestMs);
  validateTimeout("timeouts.firstChunkMs", options.timeouts?.firstChunkMs);
  validateTimeout("timeouts.chunkMs", options.timeouts?.chunkMs);
  validateTimeout("timeouts.toolMs", options.timeouts?.toolMs);
  validateRetryOptions(options.retry);

  if (options.abortSignal?.aborted)
    throw toAbortError(
      options.abortSignal,
      "Generation was aborted before it started",
    );
  if (options.tools) {
    for (const [key, definition] of Object.entries(options.tools)) {
      if (
        typeof definition !== "object" ||
        definition === null ||
        typeof definition.name !== "string" ||
        typeof definition.invoke !== "function"
      ) {
        invalidArgument(`Tool registry entry "${key}" is malformed`);
      }
      if (key !== definition.name)
        invalidArgument(
          `Tool registry key "${key}" does not match declared name "${definition.name}"`,
        );
    }
  }
};

const readFiniteNonNegative = (
  record: Readonly<Record<PropertyKey, unknown>>,
  key: string,
): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
};

export const validateUsage = (
  value: unknown,
  error: (message: string) => AgentSdkError,
): Usage => {
  if (!isRecord(value)) throw error("usage must be an object");
  const inputTokens = readFiniteNonNegative(value, "inputTokens");
  const outputTokens = readFiniteNonNegative(value, "outputTokens");
  const totalTokens = readFiniteNonNegative(value, "totalTokens");
  const cachedInputTokens = readFiniteNonNegative(value, "cachedInputTokens");
  const reasoningTokens = readFiniteNonNegative(value, "reasoningTokens");
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined
  ) {
    throw error("usage token counts must be finite, non-negative numbers");
  }
  if (totalTokens < inputTokens + outputTokens)
    throw error(
      "usage.totalTokens cannot be less than inputTokens + outputTokens",
    );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
  };
};

const validateToolCall = (
  value: unknown,
  error: (message: string) => AgentSdkError,
): ToolCall => {
  if (!isRecord(value)) throw error("tool call must be an object");
  const toolCallId = value["toolCallId"];
  const toolName = value["toolName"];
  if (typeof toolCallId !== "string" || toolCallId.length === 0)
    throw error("toolCallId must be a non-empty string");
  if (typeof toolName !== "string" || toolName.length === 0)
    throw error("toolName must be a non-empty string");
  return { toolCallId, toolName, input: value["input"] };
};

const validateFinishReason = (
  value: unknown,
  error: (message: string) => AgentSdkError,
): FinishReason => {
  if (typeof value === "string" && finishReasons.has(value)) {
    if (
      value === "stop" ||
      value === "length" ||
      value === "tool-calls" ||
      value === "content-filter" ||
      value === "error" ||
      value === "other"
    )
      return value;
  }
  throw error("finishReason is invalid");
};

export const validateModelResponse = (
  value: unknown,
  provider: string,
  modelId: string,
): ModelResponse => {
  const error = (message: string): ModelResponseError =>
    new ModelResponseError({
      message: `Invalid model response: ${message}`,
      provider,
      modelId,
    });
  if (!isRecord(value)) throw error("response must be an object");
  if (typeof value["text"] !== "string") throw error("text must be a string");
  if (!Array.isArray(value["toolCalls"]))
    throw error("toolCalls must be an array");
  const toolCalls = value["toolCalls"].map((toolCall) =>
    validateToolCall(toolCall, error),
  );
  const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.toolCallId));
  if (toolCallIds.size !== toolCalls.length)
    throw error("tool call ids must be unique");
  const finishReason = validateFinishReason(value["finishReason"], error);
  const usage = validateUsage(value["usage"], error);
  const content =
    value["content"] === undefined
      ? undefined
      : validateContent(value["content"], "content", error);
  if (typeof content === "string")
    throw error("content must be a content-part array");
  if (finishReason === "tool-calls" && toolCalls.length === 0)
    throw error("tool-calls finish reason requires at least one tool call");
  if (toolCalls.length > 0 && finishReason !== "tool-calls")
    throw error("tool calls require the tool-calls finish reason");
  const responseId = value["responseId"];
  const responseModelId = value["modelId"];
  const timestamp = value["timestamp"];
  const requestId = value["requestId"];
  if (responseId !== undefined && typeof responseId !== "string")
    throw error("responseId must be a string");
  if (requestId !== undefined && typeof requestId !== "string")
    throw error("requestId must be a string");
  if (responseModelId !== undefined && typeof responseModelId !== "string")
    throw error("modelId must be a string");
  if (
    timestamp !== undefined &&
    (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime()))
  )
    throw error("timestamp must be a valid Date");
  return {
    text: value["text"],
    content,
    toolCalls,
    finishReason,
    usage,
    responseId,
    requestId,
    modelId: responseModelId,
    timestamp,
    warnings: validateWarnings(value["warnings"], error),
    providerMetadata: validateProviderMetadata(
      value["providerMetadata"],
      error,
    ),
  };
};

export const validateModelStreamPart = (
  value: unknown,
  provider: string,
  modelId: string,
): ModelStreamPart => {
  const error = (message: string): StreamProtocolError =>
    new StreamProtocolError({
      message: `Invalid model stream: ${message}`,
      provider,
      modelId,
    });
  if (!isRecord(value) || typeof value["type"] !== "string")
    throw error("event must have a string type");
  if (value["type"] === "text-delta") {
    if (typeof value["text"] !== "string" || value["text"].length === 0)
      throw error("text-delta text must be a non-empty string");
    return { type: "text-delta", text: value["text"] };
  }
  if (value["type"] === "tool-call")
    return {
      type: "tool-call",
      toolCall: validateToolCall(value["toolCall"], error),
    };
  if (value["type"] === "finish") {
    const finishReason = validateFinishReason(value["finishReason"], error);
    const usage = validateUsage(value["usage"], error);
    if (
      value["responseId"] !== undefined &&
      typeof value["responseId"] !== "string"
    )
      throw error("finish responseId must be a string");
    if (
      value["requestId"] !== undefined &&
      typeof value["requestId"] !== "string"
    )
      throw error("finish requestId must be a string");
    if (value["modelId"] !== undefined && typeof value["modelId"] !== "string")
      throw error("finish modelId must be a string");
    return {
      type: "finish",
      finishReason,
      usage,
      responseId: value["responseId"],
      requestId:
        typeof value["requestId"] === "string" ? value["requestId"] : undefined,
      modelId:
        typeof value["modelId"] === "string" ? value["modelId"] : undefined,
      warnings: validateWarnings(value["warnings"], error),
      providerMetadata: validateProviderMetadata(
        value["providerMetadata"],
        error,
      ),
    };
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
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
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

export const raceWithSignal = <T>(
  promise: Promise<T>,
  signal: AbortSignal,
  message: string,
): Promise<T> => {
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

export const normalizeModelError = (
  error: unknown,
  provider: string,
  modelId: string,
): AgentSdkError => {
  if (AgentSdkError.isInstance(error)) return error;
  if (error instanceof DOMException && error.name === "AbortError")
    return new AbortError({ cause: error, provider, modelId });
  if (error instanceof TypeError)
    return new NetworkError({ cause: error, provider, modelId });
  if (isRecord(error)) {
    const rawStatus = error["statusCode"] ?? error["status"];
    const statusCode =
      typeof rawStatus === "number" && Number.isInteger(rawStatus)
        ? rawStatus
        : undefined;
    const rawRetryAfter = error["retryAfterMs"] ?? error["retryAfter"];
    const retryAfterMs =
      typeof rawRetryAfter === "number" &&
      Number.isFinite(rawRetryAfter) &&
      rawRetryAfter >= 0
        ? rawRetryAfter
        : typeof rawRetryAfter === "string" &&
            Number.isFinite(Number(rawRetryAfter))
          ? Math.max(0, Number(rawRetryAfter) * 1_000)
          : undefined;
    if (statusCode !== undefined) {
      const retryable =
        statusCode === 408 ||
        statusCode === 409 ||
        statusCode === 425 ||
        statusCode === 429 ||
        (statusCode >= 500 && statusCode <= 599 && statusCode !== 501);
      const metadata = {
        cause: error,
        provider,
        modelId,
        statusCode,
        retryAfterMs,
      };
      if (statusCode === 401 || statusCode === 403)
        return new AuthenticationError(metadata);
      if (statusCode === 429) return new RateLimitError(metadata);
      if (statusCode >= 400 && statusCode <= 499 && !retryable)
        return new InvalidRequestError(metadata);
      return new AgentSdkError({
        code: "MODEL_ERROR",
        message: retryable
          ? "The model provider is temporarily unavailable"
          : "The model provider rejected the request",
        ...metadata,
        retryable,
      });
    }
  }
  return new AgentSdkError({
    code: "MODEL_ERROR",
    message: "Model request failed",
    cause: error,
    provider,
    modelId,
  });
};

export interface ResolvedTimeouts {
  readonly requestMs: number;
  readonly firstChunkMs: number;
  readonly chunkMs: number;
  readonly toolMs: number;
}

export const getTimeouts = (
  timeouts: TimeoutOptions | undefined,
): ResolvedTimeouts => ({
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
  warnings: readonly ProviderWarning[] = [],
): import("./generate-text").PartialGenerateTextResult => ({
  text,
  usage,
  steps,
  responseMessages,
  warnings,
});
