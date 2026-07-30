export type AgentSdkErrorCode =
  | "MODEL_ERROR"
  | "MODEL_RESPONSE_INVALID"
  | "STREAM_PROTOCOL_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "ABORTED"
  | "TOOL_NOT_FOUND"
  | "TOOL_INPUT_INVALID"
  | "TOOL_EXECUTION_FAILED"
  | "MAX_STEPS_EXCEEDED"
  | "INVALID_ARGUMENT";

export type TimeoutKind = "request" | "first-chunk" | "chunk" | "tool";

export interface ErrorMetadata {
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly statusCode?: number | undefined;
  readonly retryable?: boolean | undefined;
  readonly retryAfterMs?: number | undefined;
  partialResult?: unknown;
}

export interface SerializedAgentSdkError {
  readonly name: string;
  readonly code: AgentSdkErrorCode;
  readonly message: string;
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly statusCode?: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | undefined;
}

const sdkErrorMarker = Symbol.for("@open-agent/sdk.error");

export class AgentSdkError extends Error {
  readonly [sdkErrorMarker] = true;
  readonly code: AgentSdkErrorCode;
  override readonly cause?: unknown;
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly statusCode?: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | undefined;
  partialResult?: unknown;

  constructor(options: ErrorMetadata & {
    readonly code: AgentSdkErrorCode;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(options.message);
    this.name = "AgentSdkError";
    this.code = options.code;
    this.cause = options.cause;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.requestId = options.requestId;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.partialResult = options.partialResult;
  }

  withPartialResult(partialResult: unknown): this {
    this.partialResult = partialResult;
    return this;
  }

  static isInstance(value: unknown): value is AgentSdkError {
    if (value instanceof AgentSdkError) return true;
    return (
      typeof value === "object" &&
      value !== null &&
      sdkErrorMarker in value &&
      value[sdkErrorMarker] === true
    );
  }

  toJSON(): SerializedAgentSdkError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      modelId: this.modelId,
      requestId: this.requestId,
      statusCode: this.statusCode,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

export class AbortError extends AgentSdkError {
  constructor(options: ErrorMetadata & { readonly message?: string; readonly cause?: unknown } = {}) {
    super({ code: "ABORTED", message: options.message ?? "Operation was aborted", ...options });
    this.name = "AbortError";
  }
}

export class TimeoutError extends AgentSdkError {
  readonly timeoutKind: TimeoutKind;
  readonly timeoutMs: number;

  constructor(options: ErrorMetadata & {
    readonly timeoutKind: TimeoutKind;
    readonly timeoutMs: number;
    readonly message?: string;
    readonly cause?: unknown;
  }) {
    super({
      code: "TIMEOUT",
      message: options.message ?? `${options.timeoutKind} timed out after ${options.timeoutMs}ms`,
      retryable: options.timeoutKind !== "tool",
      ...options,
    });
    this.name = "TimeoutError";
    this.timeoutKind = options.timeoutKind;
    this.timeoutMs = options.timeoutMs;
  }
}

export class NetworkError extends AgentSdkError {
  constructor(options: ErrorMetadata & { readonly message?: string; readonly cause?: unknown } = {}) {
    super({ code: "NETWORK_ERROR", message: options.message ?? "A network request failed", retryable: true, ...options });
    this.name = "NetworkError";
  }
}

export class ModelResponseError extends AgentSdkError {
  constructor(options: ErrorMetadata & { readonly message: string; readonly cause?: unknown }) {
    super({ code: "MODEL_RESPONSE_INVALID", ...options });
    this.name = "ModelResponseError";
  }
}

export class StreamProtocolError extends AgentSdkError {
  constructor(options: ErrorMetadata & { readonly message: string; readonly cause?: unknown }) {
    super({ code: "STREAM_PROTOCOL_ERROR", ...options });
    this.name = "StreamProtocolError";
  }
}

export class ToolError extends AgentSdkError {
  readonly toolName: string;
  readonly toolCallId: string;

  constructor(options: ErrorMetadata & {
    readonly code: "TOOL_NOT_FOUND" | "TOOL_INPUT_INVALID" | "TOOL_EXECUTION_FAILED";
    readonly message: string;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly cause?: unknown;
  }) {
    super(options);
    this.name = "ToolError";
    this.toolName = options.toolName;
    this.toolCallId = options.toolCallId;
  }
}

export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

export const toAbortError = (signal: AbortSignal, message?: string): AgentSdkError => {
  if (AgentSdkError.isInstance(signal.reason)) return signal.reason;
  return message === undefined
    ? new AbortError({ cause: signal.reason })
    : new AbortError({ message, cause: signal.reason });
};
