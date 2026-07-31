import { describe, expect, test } from "bun:test";
import {
  AbortError,
  RateLimitError,
  defineSchema,
  generateText,
  streamText,
  tool,
  type LanguageModel,
  type Usage,
} from "../src";

export interface ProviderContractFixture {
  readonly provider: string;
  createModel(fetch: ContractFetch): LanguageModel;
  textResponse(requestId: string): Response;
  toolResponse(requestId: string): Response;
  streamResponse(requestId: string): Response;
  toolStreamResponse(requestId: string): Response;
  hangingStreamResponse(onCancel: () => void): Response;
  rateLimitResponse(requestId: string): Response;
  assertTextRequest(body: unknown, headers: Headers): void;
  assertToolResultRequest(body: unknown): void;
}

interface CapturedRequest {
  readonly body: unknown;
  readonly headers: Headers;
}

export type ContractFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const readRequest = (init: RequestInit | undefined): CapturedRequest => {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  const parsed: unknown = JSON.parse(body);
  return { body: parsed, headers: new Headers(init?.headers) };
};

export const providerContract = (fixture: ProviderContractFixture): void => {
  describe(`${fixture.provider} provider contract`, () => {
    test("implements protocol v1 and normalizes text, usage, and request ids", async () => {
      let captured: CapturedRequest | undefined;
      const fetch: ContractFetch = async (_input, init) => {
        captured = readRequest(init);
        return fixture.textResponse("request-text");
      };
      const model = fixture.createModel(fetch);

      const result = await generateText({
        model,
        messages: [
          { role: "system", content: [{ type: "text", text: "Be concise" }] },
          { role: "user", content: [{ type: "text", text: "Hello" }] },
        ],
        retry: { maxRetries: 0 },
      });

      expect(model.specificationVersion).toBe("v1");
      expect(result.text).toBe("Hello from provider");
      expect(result.usage).toEqual({
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
      });
      expect(result.steps[0]).toMatchObject({
        requestId: "request-text",
        responseId: `${fixture.provider}-response`,
      });
      if (!captured) throw new Error("Provider request was not captured");
      fixture.assertTextRequest(captured.body, captured.headers);
    });

    test("streams text with normalized usage and metadata", async () => {
      const fetch: ContractFetch = async () =>
        fixture.streamResponse("request-stream");
      const run = streamText({
        model: fixture.createModel(fetch),
        prompt: "Stream",
        retry: { maxRetries: 0 },
      });

      expect(await new Response(run.textStream).text()).toBe("streamed text");
      const result = await run.result;
      expect(result.usage).toEqual({
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
      });
      expect(result.steps[0]).toMatchObject({ requestId: "request-stream" });
    });

    test("round-trips tool calls and results", async () => {
      const requests: CapturedRequest[] = [];
      let call = 0;
      const fetch: ContractFetch = async (_input, init) => {
        requests.push(readRequest(init));
        call += 1;
        return call === 1
          ? fixture.toolResponse("request-tool")
          : fixture.textResponse("request-final");
      };
      const lookup = tool({
        name: "lookup",
        description: "Look up a value",
        inputSchema: defineSchema({
          jsonSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
          parse(value): { readonly city: string } {
            if (
              typeof value !== "object" ||
              value === null ||
              !("city" in value) ||
              typeof value.city !== "string"
            )
              throw new Error("Expected city");
            return { city: value.city };
          },
        }),
        execute: ({ city }) => ({ city, temperature: 21 }),
      });

      const result = await generateText({
        model: fixture.createModel(fetch),
        prompt: "Weather",
        tools: { lookup },
        maxSteps: 2,
        retry: { maxRetries: 0 },
      });

      expect(result.steps[0]?.toolCalls[0]).toMatchObject({
        toolName: "lookup",
        input: { city: "Paris" },
      });
      const second = requests[1];
      if (!second) throw new Error("Expected a second provider request");
      fixture.assertToolResultRequest(second.body);
    });

    test("streams complete tool calls and continues the loop", async () => {
      let call = 0;
      const fetch: ContractFetch = async () => {
        call += 1;
        return call === 1
          ? fixture.toolStreamResponse("request-tool-stream")
          : fixture.streamResponse("request-stream-final");
      };
      const lookup = tool({
        name: "lookup",
        description: "Look up a value",
        inputSchema: defineSchema({
          jsonSchema: { type: "object" },
          parse(value): { readonly city: string } {
            if (
              typeof value !== "object" ||
              value === null ||
              !("city" in value) ||
              typeof value.city !== "string"
            )
              throw new Error("Expected city");
            return { city: value.city };
          },
        }),
        execute: ({ city }) => ({ city, temperature: 21 }),
      });
      const run = streamText({
        model: fixture.createModel(fetch),
        prompt: "Weather",
        tools: { lookup },
        maxSteps: 2,
        retry: { maxRetries: 0 },
      });

      expect(await new Response(run.textStream).text()).toBe("streamed text");
      const result = await run.result;
      expect(result.steps[0]?.toolCalls[0]).toMatchObject({
        toolCallId: "call-lookup",
        toolName: "lookup",
        input: { city: "Paris" },
      });
    });

    test("classifies rate limits without exposing response bodies", async () => {
      const fetch: ContractFetch = async () =>
        fixture.rateLimitResponse("request-rate-limit");
      try {
        await generateText({
          model: fixture.createModel(fetch),
          prompt: "Hello",
          retry: { maxRetries: 0 },
        });
        throw new Error("Expected rate limit failure");
      } catch (error) {
        expect(error).toBeInstanceOf(RateLimitError);
        if (!(error instanceof RateLimitError)) return;
        expect(error.requestId).toBe("request-rate-limit");
        expect(error.retryAfterMs).toBe(2_000);
        expect(error.message).not.toContain("sensitive-provider-body");
      }
    });

    test("propagates abort signals into transport work", async () => {
      let transportSignal: AbortSignal | undefined;
      const fetch: ContractFetch = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Expected a transport signal");
          transportSignal = signal;
          const abort = (): void =>
            reject(new DOMException("The operation was aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      const controller = new AbortController();
      const pending = generateText({
        model: fixture.createModel(fetch),
        prompt: "Hello",
        abortSignal: controller.signal,
        retry: { maxRetries: 0 },
      });
      await Promise.resolve();
      controller.abort("stop");

      await expect(pending).rejects.toBeInstanceOf(AbortError);
      expect(transportSignal?.aborted).toBe(true);
    });

    test("consumer cancellation releases the provider response body", async () => {
      let cancelled = false;
      const fetch: ContractFetch = async () =>
        fixture.hangingStreamResponse(() => {
          cancelled = true;
        });
      const run = streamText({
        model: fixture.createModel(fetch),
        prompt: "Stream forever",
        retry: { maxRetries: 0 },
      });
      const reader = run.fullStream.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done || part.value.type === "text-delta") break;
      }
      await reader.cancel("stop");

      await expect(run.result).rejects.toBeInstanceOf(AbortError);
      expect(cancelled).toBe(true);
    });
  });
};

export const normalizedUsage = (usage: Usage): Usage => usage;
