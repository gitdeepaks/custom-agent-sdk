export type AgentSdkErrorCode =
  | "MODEL_ERROR"
  | "TOOL_NOT_FOUND"
  | "TOOL_INPUT_INVALID"
  | "TOOL_EXECUTION_FAILED"
  | "MAX_STEPS_EXCEEDED"
  | "ABORTED"
  | "INVALID_ARGUMENT";

export class AgentSdkError extends Error {
  readonly code: AgentSdkErrorCode;
  override readonly cause?: unknown;
  readonly retryable: boolean;

  constructor(options: {
    readonly code: AgentSdkErrorCode;
    readonly message: string;
    readonly cause?: unknown;
    readonly retryable?: boolean;
  }) {
    super(options.message);
    this.name = "AgentSdkError";
    this.code = options.code;
    this.cause = options.cause;
    this.retryable = options.retryable ?? false;
  }
}

export class ToolError extends AgentSdkError {
  readonly toolName: string;
  readonly toolCallId: string;

  constructor(options: {
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
