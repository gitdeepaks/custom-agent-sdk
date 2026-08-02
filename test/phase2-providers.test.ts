import { expect } from "bun:test";
import { createAnthropic } from "../src/providers/anthropic";
import { createOpenAI } from "../src/providers/openai";
import {
  providerContract,
  type ProviderContractFixture,
} from "./provider-contract";

const jsonResponse = (
  body: unknown,
  requestId: string,
  requestIdHeader: string,
): Response =>
  Response.json(body, { headers: { [requestIdHeader]: requestId } });

const sseResponse = (
  events: readonly string[],
  requestId: string,
  requestIdHeader: string,
): Response => {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const event = events[index];
        if (event === undefined) {
          controller.close();
          return;
        }
        index += 1;
        const bytes = encoder.encode(event);
        const split = Math.max(1, Math.floor(bytes.length / 2));
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        [requestIdHeader]: requestId,
      },
    },
  );
};

const hangingSseResponse = (
  firstEvent: string,
  requestIdHeader: string,
  onCancel: () => void,
): Response => {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(firstEvent));
        }
      },
      cancel() {
        onCancel();
      },
    }),
    { headers: { [requestIdHeader]: "request-hanging" } },
  );
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
};

const openAIResponse = (
  output: readonly unknown[],
  usage = { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
) => ({
  id: "openai-response",
  object: "response",
  created_at: 1_700_000_000,
  status: "completed",
  model: "openai-test-model",
  output,
  usage,
});

const openAI: ProviderContractFixture = {
  provider: "openai",
  createModel: (fetch) =>
    createOpenAI({ apiKey: "test-key", fetch }).languageModel(
      "openai-test-model",
    ),
  textResponse: (requestId) =>
    jsonResponse(
      openAIResponse([
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from provider" }],
        },
      ]),
      requestId,
      "x-request-id",
    ),
  toolResponse: (requestId) =>
    jsonResponse(
      openAIResponse([
        {
          type: "function_call",
          call_id: "call-lookup",
          name: "lookup",
          arguments: '{"city":"Paris"}',
        },
      ]),
      requestId,
      "x-request-id",
    ),
  streamResponse: (requestId) => {
    const completed = openAIResponse(
      [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "streamed text" }],
        },
      ],
      { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    );
    return sseResponse(
      [
        'data: {"type":"response.output_text.delta","delta":"streamed "}\n\n',
        'data: {"type":"response.output_text.delta","delta":"text"}\n\n',
        `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
      ],
      requestId,
      "x-request-id",
    );
  },
  toolStreamResponse: (requestId) => {
    const call = {
      type: "function_call",
      id: "item-call",
      call_id: "call-lookup",
      name: "lookup",
      arguments: '{"city":"Paris"}',
    };
    const completed = openAIResponse([call]);
    return sseResponse(
      [
        `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } })}\n\n`,
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"city\\":\\"Paris\\"}"}\n\n',
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: call })}\n\n`,
        `data: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
      ],
      requestId,
      "x-request-id",
    );
  },
  hangingStreamResponse: (onCancel) =>
    hangingSseResponse(
      'data: {"type":"response.output_text.delta","delta":"first"}\n\n',
      "x-request-id",
      onCancel,
    ),
  rateLimitResponse: (requestId) =>
    new Response("sensitive-provider-body", {
      status: 429,
      headers: { "x-request-id": requestId, "retry-after": "2" },
    }),
  assertTextRequest(body, headers) {
    const request = requireRecord(body);
    expect(request["model"]).toBe("openai-test-model");
    expect(request["input"]).toBeArray();
    expect(headers.get("authorization")).toBe("Bearer test-key");
  },
  assertToolResultRequest(body) {
    const request = requireRecord(body);
    expect(request["input"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call-lookup",
        }),
      ]),
    );
  },
};

const anthropicMessage = (
  content: readonly unknown[],
  stopReason: string,
  usage = { input_tokens: 8, output_tokens: 4 },
) => ({
  id: "anthropic-response",
  type: "message",
  role: "assistant",
  model: "anthropic-test-model",
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage,
});

const anthropic: ProviderContractFixture = {
  provider: "anthropic",
  createModel: (fetch) =>
    createAnthropic({ apiKey: "test-key", fetch }).languageModel(
      "anthropic-test-model",
    ),
  textResponse: (requestId) =>
    jsonResponse(
      anthropicMessage(
        [{ type: "text", text: "Hello from provider" }],
        "end_turn",
      ),
      requestId,
      "request-id",
    ),
  toolResponse: (requestId) =>
    jsonResponse(
      anthropicMessage(
        [
          {
            type: "tool_use",
            id: "call-lookup",
            name: "lookup",
            input: { city: "Paris" },
          },
        ],
        "tool_use",
      ),
      requestId,
      "request-id",
    ),
  streamResponse: (requestId) =>
    sseResponse(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"anthropic-response","model":"anthropic-test-model","usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"text"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
      requestId,
      "request-id",
    ),
  toolStreamResponse: (requestId) =>
    sseResponse(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"anthropic-response","model":"anthropic-test-model","usage":{"input_tokens":8,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-lookup","name":"lookup","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":4}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
      requestId,
      "request-id",
    ),
  hangingStreamResponse: (onCancel) =>
    hangingSseResponse(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"anthropic-response","model":"anthropic-test-model","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"first"}}\n\n',
      "request-id",
      onCancel,
    ),
  rateLimitResponse: (requestId) =>
    new Response("sensitive-provider-body", {
      status: 429,
      headers: { "request-id": requestId, "retry-after": "2" },
    }),
  assertTextRequest(body, headers) {
    const request = requireRecord(body);
    expect(request["model"]).toBe("anthropic-test-model");
    expect(request["system"]).toBe("Be concise");
    expect(headers.get("x-api-key")).toBe("test-key");
  },
  assertToolResultRequest(body) {
    const request = requireRecord(body);
    expect(JSON.stringify(request["messages"])).toContain("tool_result");
    expect(JSON.stringify(request["messages"])).toContain("call-lookup");
  },
};

providerContract(openAI);
providerContract(anthropic);
