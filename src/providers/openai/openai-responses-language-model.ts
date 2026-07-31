import {
  AbortError,
  AgentSdkError,
  AuthenticationError,
  InvalidRequestError,
  ModelResponseError,
  NetworkError,
  PROVIDER_PROTOCOL_VERSION,
  RateLimitError,
  StreamProtocolError,
  UnsupportedFeatureError,
  type ContentPart,
  type FinishReason,
  type JsonValue,
  type LanguageModel,
  type MessageContent,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamPart,
  type ProviderMetadata,
  type ProviderWarning,
  type ToolCall,
  type Usage,
} from "../../core/index";

interface ModelConfig {
  readonly apiKey: string;
  readonly responsesURL: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly modelId: string;
  readonly settings?: OpenAIModelSettings | undefined;
}

export interface OpenAIModelSettings {
  readonly background?: boolean | undefined;
  readonly include?: readonly string[] | undefined;
  readonly instructions?: string | undefined;
  readonly metadata?: ProviderMetadata | undefined;
  readonly parallelToolCalls?: boolean | undefined;
  readonly previousResponseId?: string | undefined;
  readonly reasoning?: JsonValue | undefined;
  readonly serviceTier?: string | undefined;
  readonly store?: boolean | undefined;
  readonly text?: JsonValue | undefined;
  readonly toolChoice?: JsonValue | undefined;
  readonly truncation?: string | undefined;
  readonly user?: string | undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

interface PreparedRequest {
  readonly body: UnknownRecord;
  readonly warnings: readonly ProviderWarning[];
}

interface ParsedResponse {
  readonly text: string;
  readonly content: readonly ContentPart[];
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  readonly responseId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly timestamp?: Date | undefined;
  readonly providerMetadata?: ProviderMetadata | undefined;
}

interface StreamToolCall {
  itemId: string;
  callId?: string | undefined;
  name?: string | undefined;
  arguments: string;
  emitted: boolean;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const optionalString = (record: UnknownRecord, key: string): string | undefined =>
  typeof record[key] === "string" ? record[key] : undefined;

const optionalNumber = (record: UnknownRecord, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const eventItemId = (record: UnknownRecord): string | undefined => {
  const itemId = record["item_id"];
  if (typeof itemId === "string") return itemId;
  const outputIndex = record["output_index"];
  return typeof outputIndex === "number" && Number.isInteger(outputIndex)
    ? String(outputIndex)
    : undefined;
};

const encodeBase64 = (data: Uint8Array): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < data.length; index += 3) {
    const first = data[index] ?? 0;
    const second = data[index + 1];
    const third = data[index + 2];
    result += alphabet[Math.floor(first / 4)] ?? "";
    result += alphabet[((first & 3) << 4) | Math.floor((second ?? 0) / 16)] ?? "";
    result += second === undefined ? "=" : alphabet[((second & 15) << 2) | Math.floor((third ?? 0) / 64)] ?? "";
    result += third === undefined ? "=" : alphabet[third & 63] ?? "";
  }
  return result;
};

const dataReference = (
  data: string | Uint8Array | URL,
  mediaType: string,
): string => {
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) return `data:${mediaType};base64,${encodeBase64(data)}`;
  if (/^(?:https?:|data:)/i.test(data)) return data;
  return `data:${mediaType};base64,${data}`;
};

const serializeValue = (value: unknown, description: string): string => {
  if (typeof value === "string") return value;
  try {
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized === "string") return serialized;
  } catch (cause) {
    throw new InvalidRequestError({
      message: `${description} must be JSON-serializable`,
      provider: "openai",
      cause,
    });
  }
  throw new InvalidRequestError({
    message: `${description} must be JSON-serializable`,
    provider: "openai",
  });
};

const parseArguments = (
  value: string,
  error: (message: string, cause?: unknown) => AgentSdkError,
): unknown => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch (cause) {
    throw error("OpenAI returned invalid function-call arguments", cause);
  }
};

const warning = (message: string): ProviderWarning => ({
  type: "unsupported",
  message,
});

const toInputContent = (
  role: "system" | "user" | "assistant",
  content: MessageContent,
  warnings: ProviderWarning[],
): readonly UnknownRecord[] => {
  if (typeof content === "string") {
    return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
  }

  const result: UnknownRecord[] = [];
  for (const part of content) {
    if (part.type === "text") {
      result.push({ type: role === "assistant" ? "output_text" : "input_text", text: part.text });
    } else if (part.type === "image") {
      if (role !== "user") {
        throw new UnsupportedFeatureError({
          message: "OpenAI Responses only accepts image content in user messages",
          provider: "openai",
        });
      }
      result.push({
        type: "input_image",
        image_url: dataReference(part.data, part.mediaType ?? "image/png"),
        detail: "auto",
      });
    } else if (part.type === "file") {
      if (role !== "user") {
        throw new UnsupportedFeatureError({
          message: "OpenAI Responses only accepts file content in user messages",
          provider: "openai",
        });
      }
      const reference = dataReference(part.data, part.mediaType);
      result.push(reference.startsWith("http")
        ? { type: "input_file", file_url: reference }
        : {
            type: "input_file",
            file_data: reference,
            ...(part.filename === undefined ? {} : { filename: part.filename }),
          });
    } else if (part.type === "refusal" && role === "assistant") {
      result.push({ type: "refusal", refusal: part.refusal });
    } else if (part.type === "audio") {
      throw new UnsupportedFeatureError({
        message: "OpenAI Responses input audio is not supported by this adapter",
        provider: "openai",
      });
    } else if (part.type !== "tool-call" && part.type !== "tool-result") {
      warnings.push(warning(`OpenAI ignored ${part.type} content in a ${role} message`));
    }
  }
  return result;
};

const toolCallItem = (toolCall: ToolCall): UnknownRecord => ({
  type: "function_call",
  call_id: toolCall.toolCallId,
  name: toolCall.toolName,
  arguments: serializeValue(toolCall.input, `Input for tool ${toolCall.toolName}`),
});

const toolResultItem = (
  toolCallId: string,
  output: unknown,
  isError: boolean | undefined,
): UnknownRecord => ({
  type: "function_call_output",
  call_id: toolCallId,
  output: serializeValue(
    isError ? { error: output } : output,
    `Output for tool call ${toolCallId}`,
  ),
});

const messageItems = (
  message: ModelMessage,
  warnings: ProviderWarning[],
): readonly UnknownRecord[] => {
  if (message.role === "tool") {
    return [toolResultItem(message.toolCallId, message.output, message.isError)];
  }

  const content = toInputContent(message.role, message.content, warnings);
  const items: UnknownRecord[] = content.length === 0
    ? []
    : [{ type: "message", role: message.role, content }];

  if (message.role === "assistant") {
    const callIds = new Set<string>();
    for (const part of typeof message.content === "string" ? [] : message.content) {
      if (part.type === "tool-call") {
        items.push(toolCallItem(part));
        callIds.add(part.toolCallId);
      }
      if (part.type === "tool-result") {
        items.push(toolResultItem(part.toolCallId, part.output, part.isError));
      }
    }
    for (const call of message.toolCalls ?? []) {
      if (!callIds.has(call.toolCallId)) items.push(toolCallItem(call));
    }
  } else if (message.role === "user" || message.role === "system") {
    for (const part of typeof message.content === "string" ? [] : message.content) {
      if (part.type === "tool-result") {
        items.push(toolResultItem(part.toolCallId, part.output, part.isError));
      }
    }
  }
  return items;
};

const providerOptions = (
  request: ModelRequest,
  warnings: ProviderWarning[],
  settings: OpenAIModelSettings | undefined,
): UnknownRecord => {
  const result: Record<string, unknown> = {};
  if (settings) {
    if (settings.background !== undefined) result["background"] = settings.background;
    if (settings.include !== undefined) result["include"] = settings.include;
    if (settings.instructions !== undefined) result["instructions"] = settings.instructions;
    if (settings.metadata !== undefined) result["metadata"] = settings.metadata;
    if (settings.parallelToolCalls !== undefined)
      result["parallel_tool_calls"] = settings.parallelToolCalls;
    if (settings.previousResponseId !== undefined)
      result["previous_response_id"] = settings.previousResponseId;
    if (settings.reasoning !== undefined) result["reasoning"] = settings.reasoning;
    if (settings.serviceTier !== undefined) result["service_tier"] = settings.serviceTier;
    if (settings.store !== undefined) result["store"] = settings.store;
    if (settings.text !== undefined) result["text"] = settings.text;
    if (settings.toolChoice !== undefined) result["tool_choice"] = settings.toolChoice;
    if (settings.truncation !== undefined) result["truncation"] = settings.truncation;
    if (settings.user !== undefined) result["user"] = settings.user;
  }
  const options = request.providerOptions;
  if (!options) return result;
  const supported = new Set([
    "background",
    "include",
    "instructions",
    "metadata",
    "parallel_tool_calls",
    "previous_response_id",
    "reasoning",
    "service_tier",
    "store",
    "text",
    "tool_choice",
    "truncation",
    "user",
  ]);
  for (const [key, value] of Object.entries(options)) {
    if (supported.has(key)) result[key] = value;
    else warnings.push(warning(`OpenAI provider option "${key}" is not supported`));
  }
  return result;
};

const prepareRequest = (
  request: ModelRequest,
  modelId: string,
  stream: boolean,
  settings: OpenAIModelSettings | undefined,
): PreparedRequest => {
  const warnings: ProviderWarning[] = [];
  const input = request.messages.flatMap((message) => messageItems(message, warnings));
  const tools = request.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }));
  return {
    body: {
      ...providerOptions(request, warnings, settings),
      model: modelId,
      input,
      stream,
      ...(tools.length === 0 ? {} : { tools }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    },
    warnings,
  };
};

const readUsage = (
  value: unknown,
  error: (message: string) => AgentSdkError,
): Usage => {
  if (!isRecord(value)) throw error("OpenAI response usage is missing");
  const inputTokens = optionalNumber(value, "input_tokens");
  const outputTokens = optionalNumber(value, "output_tokens");
  const totalTokens = optionalNumber(value, "total_tokens");
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    throw error("OpenAI response usage is invalid");
  }
  const inputDetails = isRecord(value["input_tokens_details"])
    ? value["input_tokens_details"]
    : undefined;
  const outputDetails = isRecord(value["output_tokens_details"])
    ? value["output_tokens_details"]
    : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(inputDetails === undefined || optionalNumber(inputDetails, "cached_tokens") === undefined
      ? {}
      : { cachedInputTokens: optionalNumber(inputDetails, "cached_tokens") }),
    ...(outputDetails === undefined || optionalNumber(outputDetails, "reasoning_tokens") === undefined
      ? {}
      : { reasoningTokens: optionalNumber(outputDetails, "reasoning_tokens") }),
  };
};

const finishReason = (response: UnknownRecord, hasToolCalls: boolean): FinishReason => {
  if (hasToolCalls) return "tool-calls";
  const status = optionalString(response, "status");
  if (status === "failed" || status === "cancelled") return "error";
  const details = isRecord(response["incomplete_details"])
    ? response["incomplete_details"]
    : undefined;
  const reason = details === undefined ? undefined : optionalString(details, "reason");
  if (reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "content-filter";
  if (status === "incomplete") return "other";
  return "stop";
};

const responseMetadata = (response: UnknownRecord): ProviderMetadata | undefined => {
  const metadata = response["metadata"];
  const status = optionalString(response, "status");
  const serviceTier = optionalString(response, "service_tier");
  const openai: Record<string, JsonValue> = {};
  if (status !== undefined) openai["status"] = status;
  if (serviceTier !== undefined) openai["serviceTier"] = serviceTier;
  if (isJsonValue(metadata)) openai["metadata"] = metadata;
  return Object.keys(openai).length === 0 ? undefined : { openai };
};

const parseResponse = (
  value: unknown,
  modelId: string,
  streamError: boolean,
): ParsedResponse => {
  const makeError = (message: string, cause?: unknown): AgentSdkError =>
    streamError
      ? new StreamProtocolError({ message, provider: "openai", modelId, cause })
      : new ModelResponseError({ message, provider: "openai", modelId, cause });
  if (!isRecord(value)) throw makeError("OpenAI returned a non-object response");
  const output = value["output"];
  if (!Array.isArray(output)) throw makeError("OpenAI response output is missing");

  let text = "";
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item) || typeof item["type"] !== "string") {
      throw makeError("OpenAI response contains an invalid output item");
    }
    if (item["type"] === "message") {
      if (!Array.isArray(item["content"])) {
        throw makeError("OpenAI response message content is invalid");
      }
      for (const part of item["content"]) {
        if (!isRecord(part) || typeof part["type"] !== "string") {
          throw makeError("OpenAI response contains invalid message content");
        }
        if (part["type"] === "output_text") {
          const partText = optionalString(part, "text");
          if (partText === undefined) throw makeError("OpenAI output text is invalid");
          text += partText;
          content.push({ type: "text", text: partText });
        } else if (part["type"] === "refusal") {
          const refusal = optionalString(part, "refusal");
          if (refusal === undefined) throw makeError("OpenAI refusal is invalid");
          content.push({ type: "refusal", refusal });
        }
      }
    } else if (item["type"] === "function_call") {
      const callId = optionalString(item, "call_id");
      const name = optionalString(item, "name");
      const argumentText = optionalString(item, "arguments");
      if (callId === undefined || name === undefined || argumentText === undefined) {
        throw makeError("OpenAI returned an invalid function call");
      }
      const call: ToolCall = {
        toolCallId: callId,
        toolName: name,
        input: parseArguments(argumentText, makeError),
      };
      toolCalls.push(call);
      content.push({ type: "tool-call", ...call });
    } else if (item["type"] === "image_generation_call") {
      const image = optionalString(item, "result");
      if (image !== undefined) {
        content.push({ type: "image", data: image, mediaType: "image/png" });
      }
    }
  }

  const createdAt = optionalNumber(value, "created_at");
  const timestamp = createdAt === undefined ? undefined : new Date(createdAt * 1_000);
  return {
    text,
    content,
    toolCalls,
    finishReason: finishReason(value, toolCalls.length > 0),
    usage: readUsage(value["usage"], makeError),
    responseId: optionalString(value, "id"),
    modelId: optionalString(value, "model"),
    timestamp,
    providerMetadata: responseMetadata(value),
  };
};

const retryAfterMs = (headers: Headers): number | undefined => {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null && Number.isFinite(Number(milliseconds))) {
    return Math.max(0, Number(milliseconds));
  }
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

const httpError = (response: Response, modelId: string): AgentSdkError => {
  const options = {
    provider: "openai",
    modelId,
    statusCode: response.status,
    requestId: response.headers.get("x-request-id") ?? undefined,
    retryAfterMs: retryAfterMs(response.headers),
  };
  if (response.status === 401 || response.status === 403) {
    return new AuthenticationError({ ...options, message: "OpenAI authentication failed" });
  }
  if (response.status === 429) {
    return new RateLimitError({ ...options, message: "OpenAI rate limit exceeded" });
  }
  if (response.status === 408 || response.status === 409 || response.status === 425) {
    return new AgentSdkError({
      code: "MODEL_ERROR",
      message: "OpenAI is temporarily unavailable",
      retryable: true,
      ...options,
    });
  }
  if (response.status >= 400 && response.status < 500) {
    return new InvalidRequestError({ ...options, message: "OpenAI rejected the request" });
  }
  return new AgentSdkError({
    code: "MODEL_ERROR",
    message: "OpenAI is temporarily unavailable",
    retryable: response.status === 408 || response.status === 409 || response.status >= 500,
    ...options,
  });
};

const abortError = (signal: AbortSignal | undefined, modelId: string): AbortError =>
  new AbortError({
    message: "OpenAI request was aborted",
    provider: "openai",
    modelId,
    cause: signal?.reason,
  });

const requestHeaders = (
  apiKey: string,
  configured: Readonly<Record<string, string>> | undefined,
  request: Readonly<Record<string, string>> | undefined,
  stream: boolean,
): Headers => {
  const headers = new Headers(configured);
  for (const [name, value] of Object.entries(request ?? {})) headers.set(name, value);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  return headers;
};

const parseJsonResponse = async (response: Response, modelId: string): Promise<unknown> => {
  try {
    const value: unknown = await response.json();
    return value;
  } catch (cause) {
    throw new ModelResponseError({
      message: "OpenAI returned malformed JSON",
      provider: "openai",
      modelId,
      requestId: response.headers.get("x-request-id") ?? undefined,
      cause,
    });
  }
};

const mergeWarnings = (
  first: readonly ProviderWarning[],
  second: readonly ProviderWarning[] = [],
): readonly ProviderWarning[] | undefined => {
  const warnings = [...first, ...second];
  return warnings.length === 0 ? undefined : warnings;
};

const parseSseBlock = (block: string): string | undefined => {
  const lines = block.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length === 0 ? undefined : data.join("\n");
};

const streamFromResponse = (
  response: Response,
  modelId: string,
  requestId: string | undefined,
  warnings: readonly ProviderWarning[],
  signal: AbortSignal | undefined,
): ReadableStream<ModelStreamPart> => {
  const body = response.body;
  if (!body) {
    throw new StreamProtocolError({
      message: "OpenAI returned an empty event stream",
      provider: "openai",
      modelId,
      requestId,
    });
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<string, StreamToolCall>();
  const emittedCallIds = new Set<string>();
  let buffer = "";
  let finished = false;

  const streamError = (message: string, cause?: unknown): StreamProtocolError =>
    new StreamProtocolError({ message, provider: "openai", modelId, requestId, cause });

  const emitCall = (call: StreamToolCall, controller: ReadableStreamDefaultController<ModelStreamPart>): void => {
    if (call.emitted) return;
    if (call.callId === undefined || call.name === undefined) {
      throw streamError("OpenAI function-call stream is missing call metadata");
    }
    controller.enqueue({
      type: "tool-call",
      toolCall: {
        toolCallId: call.callId,
        toolName: call.name,
        input: parseArguments(call.arguments, streamError),
      },
    });
    call.emitted = true;
    emittedCallIds.add(call.callId);
  };

  const processEvent = (
    value: unknown,
    controller: ReadableStreamDefaultController<ModelStreamPart>,
  ): void => {
    if (!isRecord(value) || typeof value["type"] !== "string") {
      throw streamError("OpenAI returned an invalid SSE event");
    }
    const type = value["type"];
    if (type === "response.output_text.delta") {
      const delta = optionalString(value, "delta");
      if (delta === undefined) throw streamError("OpenAI text delta is invalid");
      if (delta.length > 0) controller.enqueue({ type: "text-delta", text: delta });
      return;
    }
    if (type === "response.output_item.added") {
      const item = value["item"];
      if (isRecord(item) && item["type"] === "function_call") {
        const itemId = eventItemId(value) ?? optionalString(item, "id");
        if (itemId === undefined) throw streamError("OpenAI function call has no item id");
        calls.set(itemId, {
          itemId,
          callId: optionalString(item, "call_id"),
          name: optionalString(item, "name"),
          arguments: optionalString(item, "arguments") ?? "",
          emitted: false,
        });
      }
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      const itemId = eventItemId(value);
      const delta = optionalString(value, "delta");
      if (itemId === undefined || delta === undefined) {
        throw streamError("OpenAI function-call argument delta is invalid");
      }
      const existing = calls.get(itemId) ?? {
        itemId,
        arguments: "",
        emitted: false,
      };
      existing.arguments += delta;
      calls.set(itemId, existing);
      return;
    }
    if (type === "response.output_item.done") {
      const item = value["item"];
      if (isRecord(item) && item["type"] === "function_call") {
        const itemId = eventItemId(value) ?? optionalString(item, "id");
        if (itemId === undefined) throw streamError("OpenAI completed function call has no item id");
        const existing = calls.get(itemId) ?? { itemId, arguments: "", emitted: false };
        existing.callId = optionalString(item, "call_id") ?? existing.callId;
        existing.name = optionalString(item, "name") ?? existing.name;
        const completeArguments = optionalString(item, "arguments");
        if (completeArguments !== undefined) existing.arguments = completeArguments;
        calls.set(itemId, existing);
        emitCall(existing, controller);
      }
      return;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const rawResponse = value["response"];
      const parsed = parseResponse(rawResponse, modelId, true);
      for (const call of calls.values()) emitCall(call, controller);
      for (const call of parsed.toolCalls) {
        if (!emittedCallIds.has(call.toolCallId)) {
          controller.enqueue({ type: "tool-call", toolCall: call });
          emittedCallIds.add(call.toolCallId);
        }
      }
      controller.enqueue({
        type: "finish",
        finishReason: parsed.finishReason,
        usage: parsed.usage,
        responseId: parsed.responseId,
        requestId,
        modelId: parsed.modelId,
        warnings: mergeWarnings(warnings),
        providerMetadata: parsed.providerMetadata,
      });
      finished = true;
      return;
    }
    if (type === "response.failed" || type === "error") {
      throw streamError("OpenAI reported a streaming response failure");
    }
  };

  return new ReadableStream<ModelStreamPart>({
    async pull(controller) {
      try {
        while (!finished) {
          const boundary = buffer.search(/\r?\n\r?\n/);
          if (boundary >= 0) {
            const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/);
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + (separator?.[0].length ?? 2));
            const data = parseSseBlock(block);
            if (data === undefined || data === "[DONE]") continue;
            let event: unknown;
            try {
              event = JSON.parse(data);
            } catch (cause) {
              throw streamError("OpenAI returned malformed SSE JSON", cause);
            }
            processEvent(event, controller);
            if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
            continue;
          }

          const chunk = await reader.read();
          if (chunk.done) {
            buffer += decoder.decode();
            const data = parseSseBlock(buffer);
            if (data !== undefined && data !== "[DONE]") {
              let event: unknown;
              try {
                event = JSON.parse(data);
              } catch (cause) {
                throw streamError("OpenAI returned malformed final SSE JSON", cause);
              }
              processEvent(event, controller);
            }
            if (!finished) throw streamError("OpenAI event stream ended before a finish event");
            controller.close();
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        controller.close();
      } catch (error) {
        if (signal?.aborted) controller.error(abortError(signal, modelId));
        else if (AgentSdkError.isInstance(error)) controller.error(error);
        else if (error instanceof TypeError) {
          controller.error(new NetworkError({
            message: "OpenAI event stream network request failed",
            provider: "openai",
            modelId,
            requestId,
            cause: error,
          }));
        }
        else controller.error(streamError("Failed while reading the OpenAI event stream", error));
        void reader.cancel().catch(() => undefined);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
};

export class OpenAIResponsesLanguageModel implements LanguageModel {
  readonly specificationVersion = PROVIDER_PROTOCOL_VERSION;
  readonly provider = "openai";
  readonly modelId: string;
  readonly #config: ModelConfig;

  constructor(config: ModelConfig) {
    this.#config = config;
    this.modelId = config.modelId;
  }

  async #fetch(request: ModelRequest, stream: boolean): Promise<{
    readonly response: Response;
    readonly warnings: readonly ProviderWarning[];
  }> {
    if (request.abortSignal?.aborted) throw abortError(request.abortSignal, this.modelId);
    const prepared = prepareRequest(
      request,
      this.modelId,
      stream,
      this.#config.settings,
    );
    let response: Response;
    try {
      response = await this.#config.fetch(this.#config.responsesURL, {
        method: "POST",
        headers: requestHeaders(
          this.#config.apiKey,
          this.#config.headers,
          request.headers,
          stream,
        ),
        body: JSON.stringify(prepared.body),
        ...(request.abortSignal === undefined ? {} : { signal: request.abortSignal }),
      });
    } catch (cause) {
      if (request.abortSignal?.aborted) throw abortError(request.abortSignal, this.modelId);
      throw new NetworkError({
        message: "OpenAI network request failed",
        provider: "openai",
        modelId: this.modelId,
        cause,
      });
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw httpError(response, this.modelId);
    }
    return { response, warnings: prepared.warnings };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { response, warnings } = await this.#fetch(request, false);
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const value = await parseJsonResponse(response, this.modelId);
    const parsed = parseResponse(value, this.modelId, false);
    return {
      text: parsed.text,
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      finishReason: parsed.finishReason,
      usage: parsed.usage,
      responseId: parsed.responseId,
      requestId,
      modelId: parsed.modelId,
      timestamp: parsed.timestamp,
      warnings: mergeWarnings(warnings),
      providerMetadata: parsed.providerMetadata,
    };
  }

  async stream(request: ModelRequest): Promise<ReadableStream<ModelStreamPart>> {
    const { response, warnings } = await this.#fetch(request, true);
    const requestId = response.headers.get("x-request-id") ?? undefined;
    return streamFromResponse(
      response,
      this.modelId,
      requestId,
      warnings,
      request.abortSignal,
    );
  }
}
