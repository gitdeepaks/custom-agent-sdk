export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "other";

export interface ToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface SystemMessage {
  readonly role: "system";
  readonly content: string;
}

export interface UserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[] | undefined;
}

export interface ToolMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
}

export type ModelMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelTool[];
  readonly temperature?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface ModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  readonly responseId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly timestamp?: Date | undefined;
}

export type ModelStreamPart =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCall: ToolCall }
  | {
      readonly type: "finish";
      readonly finishReason: FinishReason;
      readonly usage: Usage;
      readonly responseId?: string | undefined;
    };

export interface LanguageModel {
  readonly provider: string;
  readonly modelId: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): Promise<ReadableStream<ModelStreamPart>>;
}

export const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

export const addUsage = (left: Usage, right: Usage): Usage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  totalTokens: left.totalTokens + right.totalTokens,
});
