import {
  AbortError,
  AgentSdkError,
  AuthenticationError,
  InvalidRequestError,
  ModelResponseError,
  NetworkError,
  RateLimitError,
  StreamProtocolError,
  UnsupportedFeatureError,
  type ContentPart,
  type FinishReason,
  type JsonValue,
  type LanguageModel,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamPart,
  type Provider,
  type ProviderMetadata,
  type ProviderWarning,
  type ToolCall,
  type Usage,
} from "../../core/index";

const PROVIDER = "anthropic";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicConfig {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  readonly version?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetch?: AnthropicFetch | undefined;
  readonly defaultMaxTokens?: number | undefined;
}

export interface AnthropicModelSettings {
  readonly topP?: number | undefined;
  readonly topK?: number | undefined;
  readonly stopSequences?: readonly string[] | undefined;
  readonly metadata?: ProviderMetadata | undefined;
}

export interface AnthropicProvider extends Provider {
  readonly provider: "anthropic";
  languageModel(
    modelId: string,
    settings?: AnthropicModelSettings,
  ): LanguageModel;
}

export type AnthropicFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ResolvedConfig {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly version: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: AnthropicFetch;
  readonly defaultMaxTokens: number;
}

interface PreparedRequest {
  readonly body: Readonly<Record<string, unknown>>;
  readonly warnings: readonly ProviderWarning[];
}

interface ParsedMessage {
  readonly id: string;
  readonly model: string;
  readonly text: string;
  readonly content: readonly ContentPart[];
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  readonly warnings: readonly ProviderWarning[];
  readonly metadata: ProviderMetadata;
}

interface StreamState {
  started: boolean;
  responseId?: string | undefined;
  responseModel?: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number | undefined;
  stopReason?: string | null | undefined;
  metadata: Record<string, JsonValue>;
  readonly tools: Map<number, PendingTool>;
}

interface PendingTool {
  readonly id: string;
  readonly name: string;
  readonly initialInput: unknown;
  json: string;
}

type EventResult = "none" | "emitted" | "finished";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const responseError = (
  modelId: string,
  message: string,
  requestId?: string,
): ModelResponseError =>
  new ModelResponseError({
    message: `Invalid Anthropic response: ${message}`,
    provider: PROVIDER,
    modelId,
    requestId,
  });

const streamError = (
  modelId: string,
  message: string,
  requestId?: string,
): StreamProtocolError =>
  new StreamProtocolError({
    message: `Invalid Anthropic stream: ${message}`,
    provider: PROVIDER,
    modelId,
    requestId,
  });

const requireRecord = (
  value: unknown,
  modelId: string,
  label: string,
  requestId?: string,
): Record<string, unknown> => {
  if (!isRecord(value))
    throw responseError(modelId, `${label} must be an object`, requestId);
  return value;
};

const requireString = (
  value: unknown,
  modelId: string,
  label: string,
  requestId?: string,
): string => {
  if (typeof value !== "string")
    throw responseError(modelId, `${label} must be a string`, requestId);
  return value;
};

const requireNonNegativeNumber = (
  value: unknown,
  modelId: string,
  label: string,
  requestId?: string,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw responseError(
      modelId,
      `${label} must be a non-negative number`,
      requestId,
    );
  return value;
};

const parseUnknownJson = (
  source: string,
  error: () => AgentSdkError,
): unknown => {
  try {
    const value: unknown = JSON.parse(source);
    return value;
  } catch {
    throw error();
  }
};

const toBase64 = (data: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, data.length);
    for (let index = offset; index < end; index += 1)
      binary += String.fromCharCode(data[index] ?? 0);
  }
  return btoa(binary);
};

const binarySource = (
  data: string | Uint8Array,
  mediaType: string,
): unknown => ({
  type: "base64",
  media_type: mediaType,
  data: typeof data === "string" ? data : toBase64(data),
});

const contentSource = (
  data: string | Uint8Array | URL,
  mediaType: string,
): unknown =>
  data instanceof URL
    ? { type: "url", url: data.toString() }
    : binarySource(data, mediaType);

const serializeToolOutput = (output: unknown, modelId: string): string => {
  if (typeof output === "string") return output;
  try {
    const serialized = JSON.stringify(output);
    if (typeof serialized === "string") return serialized;
  } catch (cause) {
    throw new InvalidRequestError({
      message: "Anthropic tool results must be JSON-serializable",
      provider: PROVIDER,
      modelId,
      cause,
    });
  }
  throw new InvalidRequestError({
    message: "Anthropic tool results must be JSON-serializable",
    provider: PROVIDER,
    modelId,
  });
};

const systemText = (message: ModelMessage, modelId: string): string => {
  if (message.role !== "system") return "";
  if (typeof message.content === "string") return message.content;
  const text: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") text.push(part.text);
    else if (part.type !== "provider-metadata")
      throw new UnsupportedFeatureError({
        message: `Anthropic system messages do not support ${part.type} content`,
        provider: PROVIDER,
        modelId,
      });
  }
  return text.join("\n");
};

const userBlocks = (
  message: ModelMessage,
  modelId: string,
  warnings: ProviderWarning[],
): unknown[] => {
  if (message.role === "tool")
    return [
      {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: serializeToolOutput(message.output, modelId),
        is_error: message.isError ?? false,
      },
    ];
  if (typeof message.content === "string")
    return [{ type: "text", text: message.content }];
  const blocks: unknown[] = [];
  for (const part of message.content) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      const mediaType = part.mediaType ?? "image/jpeg";
      blocks.push({
        type: "image",
        source: contentSource(part.data, mediaType),
      });
    } else if (part.type === "file") {
      blocks.push({
        type: "document",
        source: contentSource(part.data, part.mediaType),
        title: part.filename,
      });
    } else if (part.type === "tool-result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: serializeToolOutput(part.output, modelId),
        is_error: part.isError ?? false,
      });
    } else if (part.type === "provider-metadata") {
      warnings.push({
        type: "unsupported",
        message: "Anthropic ignores provider metadata content",
      });
    } else {
      throw new UnsupportedFeatureError({
        message: `Anthropic user messages do not support ${part.type} content`,
        provider: PROVIDER,
        modelId,
      });
    }
  }
  return blocks;
};

const assistantBlocks = (
  message: ModelMessage,
  modelId: string,
  warnings: ProviderWarning[],
): unknown[] => {
  if (message.role !== "assistant") return [];
  const blocks: unknown[] = [];
  const callIds = new Set<string>();
  if (typeof message.content === "string") {
    if (message.content.length > 0)
      blocks.push({ type: "text", text: message.content });
  } else {
    for (const part of message.content) {
      if (part.type === "text") blocks.push({ type: "text", text: part.text });
      else if (part.type === "tool-call") {
        if (!isRecord(part.input))
          throw new InvalidRequestError({
            message: "Anthropic tool call inputs must be objects",
            provider: PROVIDER,
            modelId,
          });
        callIds.add(part.toolCallId);
        blocks.push({
          type: "tool_use",
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        });
      } else if (part.type === "provider-metadata") {
        warnings.push({
          type: "unsupported",
          message: "Anthropic ignores provider metadata content",
        });
      } else {
        throw new UnsupportedFeatureError({
          message: `Anthropic assistant messages do not support ${part.type} content`,
          provider: PROVIDER,
          modelId,
        });
      }
    }
  }
  for (const call of message.toolCalls ?? []) {
    if (!isRecord(call.input))
      throw new InvalidRequestError({
        message: "Anthropic tool call inputs must be objects",
        provider: PROVIDER,
        modelId,
      });
    if (!callIds.has(call.toolCallId))
      blocks.push({
        type: "tool_use",
        id: call.toolCallId,
        name: call.toolName,
        input: call.input,
      });
  }
  return blocks;
};

const appendMessage = (
  messages: Array<{ role: string; content: unknown[] }>,
  role: "user" | "assistant",
  blocks: unknown[],
): void => {
  const previous = messages[messages.length - 1];
  if (previous?.role === role) previous.content.push(...blocks);
  else messages.push({ role, content: blocks });
};

const readProviderOptions = (
  request: ModelRequest,
  body: Record<string, unknown>,
  warnings: ProviderWarning[],
  settings: AnthropicModelSettings | undefined,
): void => {
  if (settings?.topP !== undefined) body["top_p"] = settings.topP;
  if (settings?.topK !== undefined) body["top_k"] = settings.topK;
  if (settings?.stopSequences !== undefined)
    body["stop_sequences"] = settings.stopSequences;
  if (settings?.metadata !== undefined) body["metadata"] = settings.metadata;
  if (!request.providerOptions) return;
  const supported = new Set(["topP", "topK", "stopSequences", "metadata"]);
  for (const key of Object.keys(request.providerOptions)) {
    if (!supported.has(key))
      warnings.push({
        type: "unsupported",
        message: `Anthropic provider option "${key}" is ignored`,
      });
  }
  const topP = request.providerOptions["topP"];
  const topK = request.providerOptions["topK"];
  const stopSequences = request.providerOptions["stopSequences"];
  const metadata = request.providerOptions["metadata"];
  if (typeof topP === "number") body["top_p"] = topP;
  else if (topP !== undefined)
    warnings.push({
      type: "unsupported",
      message: "Anthropic topP must be a number",
    });
  if (typeof topK === "number") body["top_k"] = topK;
  else if (topK !== undefined)
    warnings.push({
      type: "unsupported",
      message: "Anthropic topK must be a number",
    });
  if (
    Array.isArray(stopSequences) &&
    stopSequences.every((value) => typeof value === "string")
  )
    body["stop_sequences"] = stopSequences;
  else if (stopSequences !== undefined)
    warnings.push({
      type: "unsupported",
      message: "Anthropic stopSequences must contain strings",
    });
  if (isRecord(metadata)) body["metadata"] = metadata;
  else if (metadata !== undefined)
    warnings.push({
      type: "unsupported",
      message: "Anthropic metadata must be an object",
    });
};

const prepareRequest = (
  request: ModelRequest,
  modelId: string,
  maxTokens: number,
  stream: boolean,
  settings: AnthropicModelSettings | undefined,
): PreparedRequest => {
  const requestedMaxTokens = request.maxOutputTokens ?? maxTokens;
  if (!Number.isInteger(requestedMaxTokens) || requestedMaxTokens <= 0)
    throw new InvalidRequestError({
      message: "Anthropic maxOutputTokens must be a positive integer",
      provider: PROVIDER,
      modelId,
    });
  if (request.temperature !== undefined && request.temperature > 1)
    throw new InvalidRequestError({
      message: "Anthropic temperature must be between 0 and 1",
      provider: PROVIDER,
      modelId,
    });
  const warnings: ProviderWarning[] = [];
  const messages: Array<{ role: string; content: unknown[] }> = [];
  const system: string[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      const text = systemText(message, modelId);
      if (text.length > 0) system.push(text);
    } else if (message.role === "assistant") {
      appendMessage(
        messages,
        "assistant",
        assistantBlocks(message, modelId, warnings),
      );
    } else {
      appendMessage(messages, "user", userBlocks(message, modelId, warnings));
    }
  }
  const body: Record<string, unknown> = {
    model: modelId,
    max_tokens: requestedMaxTokens,
    messages,
    stream,
  };
  if (system.length > 0) body["system"] = system.join("\n\n");
  if (request.temperature !== undefined)
    body["temperature"] = request.temperature;
  if (request.tools.length > 0)
    body["tools"] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  if (request.outputFormat)
    body["output_config"] = {
      format:
        request.outputFormat.schema === undefined
          ? { type: "json_schema", schema: {} }
          : {
              type: "json_schema",
              schema: request.outputFormat.schema,
            },
    };
  readProviderOptions(request, body, warnings, settings);
  return { body, warnings };
};

const parseUsage = (
  value: unknown,
  modelId: string,
  requestId?: string,
): { usage: Usage; metadata: ProviderMetadata } => {
  const object = requireRecord(value, modelId, "usage", requestId);
  const inputTokens = requireNonNegativeNumber(
    object["input_tokens"],
    modelId,
    "usage.input_tokens",
    requestId,
  );
  const outputTokens = requireNonNegativeNumber(
    object["output_tokens"],
    modelId,
    "usage.output_tokens",
    requestId,
  );
  const cacheRead =
    object["cache_read_input_tokens"] === undefined
      ? 0
      : requireNonNegativeNumber(
          object["cache_read_input_tokens"],
          modelId,
          "usage.cache_read_input_tokens",
          requestId,
        );
  const cacheCreation =
    object["cache_creation_input_tokens"] === undefined
      ? 0
      : requireNonNegativeNumber(
          object["cache_creation_input_tokens"],
          modelId,
          "usage.cache_creation_input_tokens",
          requestId,
        );
  const hasCacheRead = object["cache_read_input_tokens"] !== undefined;
  return {
    usage: hasCacheRead
      ? {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          cachedInputTokens: cacheRead,
        }
      : { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    metadata: {
      cacheCreationInputTokens: cacheCreation,
      cacheReadInputTokens: cacheRead,
    },
  };
};

const finishReason = (reason: unknown, hasTools: boolean): FinishReason => {
  if (hasTools || reason === "tool_use") return "tool-calls";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "content-filter";
  return "other";
};

const parseMessage = (
  value: unknown,
  modelId: string,
  requestId?: string,
): ParsedMessage => {
  const message = requireRecord(value, modelId, "response", requestId);
  const id = requireString(message["id"], modelId, "id", requestId);
  const responseModel = requireString(
    message["model"],
    modelId,
    "model",
    requestId,
  );
  if (!Array.isArray(message["content"]))
    throw responseError(modelId, "content must be an array", requestId);
  const text: string[] = [];
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  const warnings: ProviderWarning[] = [];
  for (const rawBlock of message["content"]) {
    const block = requireRecord(rawBlock, modelId, "content block", requestId);
    if (block["type"] === "text") {
      const valueText = requireString(
        block["text"],
        modelId,
        "text block text",
        requestId,
      );
      text.push(valueText);
      content.push({ type: "text", text: valueText });
    } else if (block["type"] === "tool_use") {
      if (!isRecord(block["input"]))
        throw responseError(modelId, "tool input must be an object", requestId);
      const toolCall = {
        toolCallId: requireString(block["id"], modelId, "tool id", requestId),
        toolName: requireString(block["name"], modelId, "tool name", requestId),
        input: block["input"],
      };
      toolCalls.push(toolCall);
      content.push({ type: "tool-call", ...toolCall });
    } else {
      warnings.push({
        type: "compatibility",
        message: "Anthropic returned an unsupported content block",
      });
    }
  }
  const parsedUsage = parseUsage(message["usage"], modelId, requestId);
  const stopSequence =
    typeof message["stop_sequence"] === "string"
      ? message["stop_sequence"]
      : null;
  return {
    id,
    model: responseModel,
    text: text.join(""),
    content,
    toolCalls,
    finishReason: finishReason(message["stop_reason"], toolCalls.length > 0),
    usage: parsedUsage.usage,
    warnings,
    metadata: { ...parsedUsage.metadata, stopSequence },
  };
};

const retryAfterMs = (headers: Headers): number | undefined => {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

const requestIdFrom = (headers: Headers): string | undefined =>
  headers.get("request-id") ?? headers.get("x-request-id") ?? undefined;

const apiError = (response: Response, modelId: string): AgentSdkError => {
  const metadata = {
    provider: PROVIDER,
    modelId,
    requestId: requestIdFrom(response.headers),
    statusCode: response.status,
    retryAfterMs: retryAfterMs(response.headers),
  };
  if (response.status === 401 || response.status === 403)
    return new AuthenticationError({
      message: "Anthropic authentication failed",
      ...metadata,
    });
  if (response.status === 429)
    return new RateLimitError({
      message: "Anthropic rate limit exceeded",
      ...metadata,
    });
  if (response.status >= 400 && response.status < 500)
    return new InvalidRequestError({
      message: "Anthropic rejected the request",
      ...metadata,
    });
  return new AgentSdkError({
    code: "MODEL_ERROR",
    message: "Anthropic service request failed",
    retryable: response.status >= 500,
    ...metadata,
  });
};

const transportError = (
  cause: unknown,
  signal: AbortSignal | undefined,
  modelId: string,
): AgentSdkError => {
  if (signal?.aborted)
    return new AbortError({
      message: "Anthropic request was aborted",
      cause: signal.reason,
      provider: PROVIDER,
      modelId,
    });
  if (cause instanceof DOMException && cause.name === "AbortError")
    return new AbortError({
      message: "Anthropic request was aborted",
      cause,
      provider: PROVIDER,
      modelId,
    });
  if (AgentSdkError.isInstance(cause)) return cause;
  return new NetworkError({
    message: "Anthropic network request failed",
    cause,
    provider: PROVIDER,
    modelId,
  });
};

const requestHeaders = (
  config: ResolvedConfig,
  request: ModelRequest,
): Headers => {
  const headers = new Headers(config.headers);
  for (const [name, value] of Object.entries(request.headers ?? {}))
    headers.set(name, value);
  headers.set("content-type", "application/json");
  headers.set("x-api-key", config.apiKey);
  headers.set("anthropic-version", config.version);
  return headers;
};

const post = async (
  config: ResolvedConfig,
  modelId: string,
  request: ModelRequest,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> => {
  if (request.abortSignal?.aborted)
    throw transportError(
      request.abortSignal.reason,
      request.abortSignal,
      modelId,
    );
  let serializedBody: string;
  try {
    serializedBody = JSON.stringify(body);
  } catch (cause) {
    throw new InvalidRequestError({
      message: "Anthropic request content must be JSON-serializable",
      provider: PROVIDER,
      modelId,
      cause,
    });
  }
  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: requestHeaders(config, request),
      body: serializedBody,
    };
    if (request.abortSignal !== undefined) init.signal = request.abortSignal;
    response = await config.fetch(`${config.baseURL}/messages`, init);
  } catch (cause) {
    throw transportError(cause, request.abortSignal, modelId);
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // The sanitized status error remains the actionable failure.
    }
    throw apiError(response, modelId);
  }
  return response;
};

const parseEventData = (
  data: string,
  modelId: string,
  requestId?: string,
): Record<string, unknown> => {
  const value = parseUnknownJson(data, () =>
    streamError(modelId, "event data is not valid JSON", requestId),
  );
  if (!isRecord(value))
    throw streamError(modelId, "event data must be an object", requestId);
  return value;
};

const streamUsage = (state: StreamState): Usage => ({
  inputTokens: state.inputTokens,
  outputTokens: state.outputTokens,
  totalTokens: state.inputTokens + state.outputTokens,
  cachedInputTokens: state.cachedInputTokens,
});

const streamCount = (
  value: unknown,
  label: string,
  modelId: string,
  requestId: string | undefined,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw streamError(
      modelId,
      `${label} must be a non-negative number`,
      requestId,
    );
  return value;
};

const streamIndex = (
  value: unknown,
  modelId: string,
  requestId: string | undefined,
): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw streamError(
      modelId,
      "content block index must be a non-negative integer",
      requestId,
    );
  return value;
};

const streamedApiError = (
  event: Record<string, unknown>,
  modelId: string,
  requestId: string | undefined,
): AgentSdkError => {
  const detail = event["error"];
  const type =
    isRecord(detail) && typeof detail["type"] === "string"
      ? detail["type"]
      : undefined;
  const metadata = { provider: PROVIDER, modelId, requestId };
  if (type === "authentication_error" || type === "permission_error")
    return new AuthenticationError({
      message: "Anthropic authentication failed",
      ...metadata,
    });
  if (type === "rate_limit_error")
    return new RateLimitError({
      message: "Anthropic rate limit exceeded",
      ...metadata,
    });
  if (type === "invalid_request_error" || type === "not_found_error")
    return new InvalidRequestError({
      message: "Anthropic rejected the streaming request",
      ...metadata,
    });
  return new AgentSdkError({
    code: "MODEL_ERROR",
    message: "Anthropic reported a streaming error",
    retryable: type === "overloaded_error" || type === "api_error",
    ...metadata,
  });
};

const processEvent = (
  eventName: string | undefined,
  data: string,
  state: StreamState,
  controller: ReadableStreamDefaultController<ModelStreamPart>,
  modelId: string,
  requestId: string | undefined,
  warnings: ProviderWarning[],
): EventResult => {
  if (data === "[DONE]") return "none";
  const event = parseEventData(data, modelId, requestId);
  const type = typeof event["type"] === "string" ? event["type"] : eventName;
  if (type === "ping") return "none";
  if (type === "error") throw streamedApiError(event, modelId, requestId);
  if (type === "message_start") {
    if (state.started)
      throw streamError(modelId, "received duplicate message_start", requestId);
    const message = event["message"];
    if (!isRecord(message))
      throw streamError(
        modelId,
        "message_start.message must be an object",
        requestId,
      );
    if (
      typeof message["id"] !== "string" ||
      typeof message["model"] !== "string"
    )
      throw streamError(
        modelId,
        "message_start is missing id or model",
        requestId,
      );
    state.responseId = message["id"];
    state.responseModel = message["model"];
    if (!isRecord(message["usage"]))
      throw streamError(
        modelId,
        "message_start.usage must be an object",
        requestId,
      );
    const usage = message["usage"];
    state.inputTokens = streamCount(
      usage["input_tokens"],
      "usage.input_tokens",
      modelId,
      requestId,
    );
    const read = usage["cache_read_input_tokens"];
    const creation = usage["cache_creation_input_tokens"];
    if (read !== undefined) {
      state.cachedInputTokens = streamCount(
        read,
        "usage.cache_read_input_tokens",
        modelId,
        requestId,
      );
      state.metadata["cacheReadInputTokens"] = state.cachedInputTokens;
    }
    if (creation !== undefined)
      state.metadata["cacheCreationInputTokens"] = streamCount(
        creation,
        "usage.cache_creation_input_tokens",
        modelId,
        requestId,
      );
    state.started = true;
    return "none";
  }
  if (type === "content_block_start") {
    if (!state.started)
      throw streamError(
        modelId,
        "content block arrived before message_start",
        requestId,
      );
    const index = streamIndex(event["index"], modelId, requestId);
    const block = event["content_block"];
    if (!isRecord(block))
      throw streamError(modelId, "invalid content_block_start", requestId);
    if (block["type"] === "tool_use") {
      if (typeof block["id"] !== "string" || typeof block["name"] !== "string")
        throw streamError(
          modelId,
          "tool block is missing id or name",
          requestId,
        );
      if (block["input"] !== undefined && !isRecord(block["input"]))
        throw streamError(modelId, "tool input must be an object", requestId);
      if (state.tools.has(index))
        throw streamError(
          modelId,
          "received duplicate tool block index",
          requestId,
        );
      state.tools.set(index, {
        id: block["id"],
        name: block["name"],
        initialInput: block["input"],
        json: "",
      });
    } else if (block["type"] !== "text")
      warnings.push({
        type: "compatibility",
        message: "Anthropic streamed an unsupported content block",
      });
    return "none";
  }
  if (type === "content_block_delta") {
    if (!state.started)
      throw streamError(
        modelId,
        "content delta arrived before message_start",
        requestId,
      );
    const index = streamIndex(event["index"], modelId, requestId);
    const delta = event["delta"];
    if (!isRecord(delta))
      throw streamError(modelId, "invalid content_block_delta", requestId);
    if (delta["type"] === "text_delta") {
      if (typeof delta["text"] !== "string")
        throw streamError(modelId, "text delta is missing text", requestId);
      if (delta["text"].length > 0) {
        controller.enqueue({ type: "text-delta", text: delta["text"] });
        return "emitted";
      }
    } else if (delta["type"] === "input_json_delta") {
      const tool = state.tools.get(index);
      if (!tool || typeof delta["partial_json"] !== "string")
        throw streamError(modelId, "invalid tool input delta", requestId);
      tool.json += delta["partial_json"];
    }
    return "none";
  }
  if (type === "content_block_stop") {
    const index = streamIndex(event["index"], modelId, requestId);
    const tool = state.tools.get(index);
    if (tool) {
      const input =
        tool.json.length === 0
          ? tool.initialInput
          : parseUnknownJson(tool.json, () =>
              streamError(modelId, "tool input is not valid JSON", requestId),
            );
      if (!isRecord(input))
        throw streamError(modelId, "tool input must be an object", requestId);
      controller.enqueue({
        type: "tool-call",
        toolCall: { toolCallId: tool.id, toolName: tool.name, input },
      });
      state.tools.delete(index);
      return "emitted";
    }
    return "none";
  }
  if (type === "message_delta") {
    if (!state.started)
      throw streamError(
        modelId,
        "message_delta arrived before message_start",
        requestId,
      );
    const delta = event["delta"];
    if (!isRecord(delta))
      throw streamError(
        modelId,
        "message_delta.delta must be an object",
        requestId,
      );
    if (
      typeof delta["stop_reason"] === "string" ||
      delta["stop_reason"] === null
    )
      state.stopReason = delta["stop_reason"];
    if (typeof delta["stop_sequence"] === "string")
      state.metadata["stopSequence"] = delta["stop_sequence"];
    if (!isRecord(event["usage"]))
      throw streamError(
        modelId,
        "message_delta.usage must be an object",
        requestId,
      );
    state.outputTokens = streamCount(
      event["usage"]["output_tokens"],
      "usage.output_tokens",
      modelId,
      requestId,
    );
    return "none";
  }
  if (type === "message_stop") {
    if (!state.started)
      throw streamError(
        modelId,
        "message_stop arrived before message_start",
        requestId,
      );
    if (state.tools.size > 0)
      throw streamError(
        modelId,
        "stream ended before a tool input completed",
        requestId,
      );
    controller.enqueue({
      type: "finish",
      finishReason: finishReason(state.stopReason, false),
      usage: streamUsage(state),
      responseId: state.responseId,
      requestId,
      modelId: state.responseModel,
      warnings,
      providerMetadata: state.metadata,
    });
    return "finished";
  }
  return "none";
};

const createEventStream = (
  response: Response,
  request: ModelRequest,
  modelId: string,
  warnings: readonly ProviderWarning[],
): ReadableStream<ModelStreamPart> => {
  const body = response.body;
  const requestId = requestIdFrom(response.headers);
  if (!body) throw streamError(modelId, "response body is missing", requestId);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state: StreamState = {
    started: false,
    inputTokens: 0,
    outputTokens: 0,
    metadata: {},
    tools: new Map(),
  };
  const streamWarnings = [...warnings];
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let inputEnded = false;
  let inputFinalized = false;
  let cancelled = false;
  let terminal = false;
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = (cancelReader: boolean, reason?: unknown): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (cancelReader) {
        try {
          await reader.cancel(reason);
        } catch {
          // Preserve the stream's primary completion, cancellation, or error.
        }
      }
      try {
        reader.releaseLock();
      } catch {
        // A concurrent cancellation may already have released the reader.
      }
    })();
    return cleanupPromise;
  };

  return new ReadableStream<ModelStreamPart>(
    {
      async pull(controller) {
        const dispatch = (): EventResult => {
          if (dataLines.length === 0) {
            eventName = undefined;
            return "none";
          }
          const result = processEvent(
            eventName,
            dataLines.join("\n"),
            state,
            controller,
            modelId,
            requestId,
            streamWarnings,
          );
          eventName = undefined;
          dataLines = [];
          return result;
        };
        const consumeLine = (line: string): EventResult => {
          if (line === "") return dispatch();
          if (line.startsWith("event:")) eventName = line.slice(6).trimStart();
          else if (line.startsWith("data:")) {
            const value = line.slice(5);
            dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
          }
          return "none";
        };
        const processBufferedLines = (): EventResult => {
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            let line = buffer.slice(0, newline);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            buffer = buffer.slice(newline + 1);
            const result = consumeLine(line);
            if (result !== "none") return result;
            newline = buffer.indexOf("\n");
          }
          return "none";
        };
        try {
          while (!cancelled && !terminal) {
            const bufferedResult = processBufferedLines();
            if (bufferedResult === "emitted") return;
            if (bufferedResult === "finished") {
              terminal = true;
              controller.close();
              await cleanup(true);
              return;
            }

            if (inputEnded) {
              if (!inputFinalized) {
                inputFinalized = true;
                if (buffer.length > 0) {
                  const finalLine = buffer.endsWith("\r")
                    ? buffer.slice(0, -1)
                    : buffer;
                  buffer = "";
                  const lineResult = consumeLine(finalLine);
                  if (lineResult === "emitted") return;
                  if (lineResult === "finished") {
                    terminal = true;
                    controller.close();
                    await cleanup(false);
                    return;
                  }
                }
                const finalResult = dispatch();
                if (finalResult === "emitted") return;
                if (finalResult === "finished") {
                  terminal = true;
                  controller.close();
                  await cleanup(false);
                  return;
                }
              }
              throw streamError(
                modelId,
                "stream ended without message_stop",
                requestId,
              );
            }

            const chunk = await reader.read();
            if (chunk.done) {
              inputEnded = true;
              buffer += decoder.decode();
            } else {
              buffer += decoder.decode(chunk.value, { stream: true });
            }
          }
        } catch (cause) {
          if (!cancelled && !terminal) {
            terminal = true;
            await cleanup(true, cause);
            controller.error(
              transportError(cause, request.abortSignal, modelId),
            );
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        terminal = true;
        await cleanup(true, reason);
      },
    },
    { highWaterMark: 0 },
  );
};

class AnthropicLanguageModel implements LanguageModel {
  readonly specificationVersion = "v1";
  readonly provider = PROVIDER;

  constructor(
    readonly modelId: string,
    private readonly config: ResolvedConfig,
    private readonly settings?: AnthropicModelSettings,
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const prepared = prepareRequest(
      request,
      this.modelId,
      this.config.defaultMaxTokens,
      false,
      this.settings,
    );
    const response = await post(
      this.config,
      this.modelId,
      request,
      prepared.body,
    );
    const requestId = requestIdFrom(response.headers);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ModelResponseError({
        message: "Invalid Anthropic response: body is not valid JSON",
        provider: PROVIDER,
        modelId: this.modelId,
        requestId,
      });
    }
    const parsed = parseMessage(value, this.modelId, requestId);
    return {
      text: parsed.text,
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      finishReason: parsed.finishReason,
      usage: parsed.usage,
      responseId: parsed.id,
      requestId,
      modelId: parsed.model,
      warnings: [...prepared.warnings, ...parsed.warnings],
      providerMetadata: parsed.metadata,
    };
  }

  async stream(
    request: ModelRequest,
  ): Promise<ReadableStream<ModelStreamPart>> {
    const prepared = prepareRequest(
      request,
      this.modelId,
      this.config.defaultMaxTokens,
      true,
      this.settings,
    );
    const response = await post(
      this.config,
      this.modelId,
      request,
      prepared.body,
    );
    return createEventStream(
      response,
      request,
      this.modelId,
      prepared.warnings,
    );
  }
}

const resolveConfig = (config: AnthropicConfig): ResolvedConfig => {
  if (
    !config ||
    typeof config.apiKey !== "string" ||
    config.apiKey.trim().length === 0
  )
    throw new InvalidRequestError({
      message: "Anthropic apiKey is required",
      provider: PROVIDER,
    });
  const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (baseURL.length === 0)
    throw new InvalidRequestError({
      message: "Anthropic baseURL must not be empty",
      provider: PROVIDER,
    });
  const version = config.version ?? DEFAULT_VERSION;
  if (version.trim().length === 0)
    throw new InvalidRequestError({
      message: "Anthropic version must not be empty",
      provider: PROVIDER,
    });
  const defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(defaultMaxTokens) || defaultMaxTokens <= 0)
    throw new InvalidRequestError({
      message: "Anthropic defaultMaxTokens must be a positive integer",
      provider: PROVIDER,
    });
  return {
    apiKey: config.apiKey,
    baseURL,
    version,
    headers: config.headers ?? {},
    fetch: config.fetch ?? globalThis.fetch,
    defaultMaxTokens,
  };
};

export const createAnthropic = (config: AnthropicConfig): AnthropicProvider => {
  const resolved = resolveConfig(config);
  return {
    provider: PROVIDER,
    languageModel(
      modelId: string,
      settings?: AnthropicModelSettings,
    ): LanguageModel {
      if (modelId.trim().length === 0)
        throw new InvalidRequestError({
          message: "Anthropic modelId must not be empty",
          provider: PROVIDER,
        });
      return new AnthropicLanguageModel(modelId, resolved, settings);
    },
  };
};
