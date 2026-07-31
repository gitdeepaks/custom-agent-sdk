export const PROVIDER_PROTOCOL_VERSION = "v1" as const;

export type ProviderProtocolVersion = typeof PROVIDER_PROTOCOL_VERSION;

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ProviderMetadata = Readonly<Record<string, JsonValue>>;
export type ProviderOptions = Readonly<Record<string, JsonValue>>;

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "content-filter"
  | "error"
  | "other";

export interface ProviderWarning {
  readonly type: "unsupported" | "compatibility" | "other";
  readonly message: string;
}

export interface ToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export type BinaryData = string | Uint8Array;

export interface TextContentPart {
  readonly type: "text";
  readonly text: string;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface ImageContentPart {
  readonly type: "image";
  readonly data: BinaryData | URL;
  readonly mediaType?: string | undefined;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface AudioContentPart {
  readonly type: "audio";
  readonly data: BinaryData | URL;
  readonly mediaType: string;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface FileContentPart {
  readonly type: "file";
  readonly data: BinaryData | URL;
  readonly mediaType: string;
  readonly filename?: string | undefined;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface ReasoningContentPart {
  readonly type: "reasoning";
  readonly text: string;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface ToolCallContentPart extends ToolCall {
  readonly type: "tool-call";
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface ToolResultContentPart {
  readonly type: "tool-result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly isError?: boolean | undefined;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface SourceContentPart {
  readonly type: "source";
  readonly sourceType: "url" | "document";
  readonly id: string;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface RefusalContentPart {
  readonly type: "refusal";
  readonly refusal: string;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export interface ProviderMetadataContentPart {
  readonly type: "provider-metadata";
  readonly provider: string;
  readonly metadata: ProviderMetadata;
}

export type ContentPart =
  | TextContentPart
  | ImageContentPart
  | AudioContentPart
  | FileContentPart
  | ReasoningContentPart
  | ToolCallContentPart
  | ToolResultContentPart
  | SourceContentPart
  | RefusalContentPart
  | ProviderMetadataContentPart;

export type MessageContent = string | readonly ContentPart[];

export interface SystemMessage {
  readonly role: "system";
  readonly content: MessageContent;
}

export interface UserMessage {
  readonly role: "user";
  readonly content: MessageContent;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: MessageContent;
  /** @deprecated Represent calls as tool-call content parts. */
  readonly toolCalls?: readonly ToolCall[] | undefined;
}

export interface ToolMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly output: unknown;
  readonly isError?: boolean | undefined;
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
  readonly providerOptions?: ProviderOptions | undefined;
}

export interface ModelResponse {
  readonly text: string;
  readonly content?: readonly ContentPart[] | undefined;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  readonly responseId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly timestamp?: Date | undefined;
  readonly warnings?: readonly ProviderWarning[] | undefined;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

export type ModelStreamPart =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolCall: ToolCall }
  | {
      readonly type: "finish";
      readonly finishReason: FinishReason;
      readonly usage: Usage;
      readonly responseId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly modelId?: string | undefined;
      readonly warnings?: readonly ProviderWarning[] | undefined;
      readonly providerMetadata?: ProviderMetadata | undefined;
    };

export interface LanguageModel {
  readonly specificationVersion: ProviderProtocolVersion;
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
  cachedInputTokens:
    left.cachedInputTokens === undefined && right.cachedInputTokens === undefined
      ? undefined
      : (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
  reasoningTokens:
    left.reasoningTokens === undefined && right.reasoningTokens === undefined
      ? undefined
      : (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
});
