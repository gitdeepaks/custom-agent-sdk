import { describe, expect, test } from "bun:test";
import {
  AbortError,
  AgentSdkError,
  NetworkError,
  StreamProtocolError,
  TimeoutError,
  defineSchema,
  generateText,
  streamText,
  tool,
  type LanguageModel,
  type ModelResponse,
  type ModelStreamPart,
} from "../src";

const usage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 };

const modelResponse = (text = "ok"): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: "stop",
  usage,
});

const streamFrom = (
  parts: readonly ModelStreamPart[],
): ReadableStream<ModelStreamPart> =>
  new ReadableStream<ModelStreamPart>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

const collect = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
};

describe("Phase 1 option and response validation", () => {
  const model: LanguageModel = {
    specificationVersion: "v1",
    provider: "test",
    modelId: "validation",
    generate: async () => modelResponse(),
  };

  test("rejects invalid numeric options before calling the provider", async () => {
    let calls = 0;
    const countingModel: LanguageModel = {
      ...model,
      generate: async () => {
        calls += 1;
        return modelResponse();
      },
    };
    await expect(
      generateText({
        model: countingModel,
        prompt: "x",
        temperature: Number.NaN,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      generateText({ model: countingModel, prompt: "x", maxOutputTokens: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      generateText({ model: countingModel, prompt: "x", maxRetries: 11 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toBe(0);
  });

  test("rejects mismatched tool registry keys", async () => {
    const named = tool({
      name: "declared",
      description: "test",
      inputSchema: defineSchema({ jsonSchema: null, parse: () => null }),
      execute: () => null,
    });
    await expect(
      generateText({ model, prompt: "x", tools: { different: named } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  test("rejects malformed provider responses", async () => {
    const malformed: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "malformed",
      generate: async () => ({
        text: "x",
        toolCalls: [],
        finishReason: "stop",
        usage: { ...usage, totalTokens: -1 },
      }),
    };
    await expect(
      generateText({ model: malformed, prompt: "x" }),
    ).rejects.toMatchObject({ code: "MODEL_RESPONSE_INVALID" });
  });

  test("preserves class model method binding", async () => {
    class BoundModel implements LanguageModel {
      readonly specificationVersion = "v1";
      readonly provider = "test";
      readonly modelId = "bound";
      private readonly answer = "bound answer";
      generate(): Promise<ModelResponse> {
        return Promise.resolve(modelResponse(this.answer));
      }
      stream(): Promise<ReadableStream<ModelStreamPart>> {
        return Promise.resolve(
          streamFrom([
            { type: "text-delta", text: this.answer },
            { type: "finish", finishReason: "stop", usage },
          ]),
        );
      }
    }
    const generated = await generateText({
      model: new BoundModel(),
      prompt: "x",
    });
    expect(generated.text).toBe("bound answer");
    const streamed = streamText({ model: new BoundModel(), prompt: "x" });
    expect(await new Response(streamed.textStream).text()).toBe("bound answer");
  });
});

describe("Phase 1 retry policy", () => {
  test("retries only classified failures and invokes onRetry", async () => {
    let attempts = 0;
    const events: number[] = [];
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "retry",
      async generate() {
        attempts += 1;
        if (attempts === 1) throw new NetworkError();
        return modelResponse();
      },
    };
    await generateText({
      model,
      prompt: "x",
      retry: {
        maxRetries: 1,
        initialDelayMs: 1,
        maxDelayMs: 1,
        jitter: 0,
        onRetry: ({ attempt }) => {
          events.push(attempt);
        },
      },
    });
    expect(attempts).toBe(2);
    expect(events).toEqual([1]);
  });

  test("does not retry unclassified provider failures", async () => {
    let attempts = 0;
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "permanent",
      async generate() {
        attempts += 1;
        throw new Error("invalid request");
      },
    };
    await expect(
      generateText({
        model,
        prompt: "x",
        retry: { maxRetries: 3, initialDelayMs: 1 },
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(attempts).toBe(1);
  });

  test("classifies transient statuses and honors Retry-After", async () => {
    let attempts = 0;
    let observedDelay = 0;
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "rate-limit",
      async generate() {
        attempts += 1;
        if (attempts === 1) throw { statusCode: 429, retryAfterMs: 1 };
        return modelResponse();
      },
    };
    await generateText({
      model,
      prompt: "x",
      retry: {
        maxRetries: 1,
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitter: 0,
        onRetry: ({ delayMs }) => {
          observedDelay = delayMs;
        },
      },
    });
    expect(observedDelay).toBeGreaterThanOrEqual(1);
  });

  test("aborts during retry backoff", async () => {
    const controller = new AbortController();
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "backoff",
      generate: async () => {
        throw new NetworkError();
      },
    };
    const pending = generateText({
      model,
      prompt: "x",
      abortSignal: controller.signal,
      retry: { maxRetries: 2, initialDelayMs: 1_000 },
    });
    setTimeout(() => controller.abort("stop"), 5);
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });
});

describe("Phase 1 canonical streaming", () => {
  test("native and fallback streams use identical event ordering", async () => {
    const native: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "native",
      generate: async () => modelResponse("hello"),
      stream: async () =>
        streamFrom([
          { type: "text-delta", text: "hello" },
          { type: "finish", finishReason: "stop", usage },
        ]),
    };
    const fallback: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "fallback",
      generate: async () => modelResponse("hello"),
    };
    const nativeRun = streamText({ model: native, prompt: "x" });
    const fallbackRun = streamText({ model: fallback, prompt: "x" });
    const nativeTypes = (await collect(nativeRun.fullStream)).map(
      (part) => part.type,
    );
    const fallbackTypes = (await collect(fallbackRun.fullStream)).map(
      (part) => part.type,
    );
    expect(nativeTypes).toEqual([
      "step-start",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
      "step-finish",
    ]);
    expect(fallbackTypes).toEqual(nativeTypes);
  });

  test("exposes bounded mutually exclusive views instead of teeing", async () => {
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "exclusive",
      generate: async () => modelResponse(),
      stream: async () =>
        streamFrom([{ type: "finish", finishReason: "stop", usage }]),
    };
    const run = streamText({ model, prompt: "x" });
    const fullReader = run.fullStream.getReader();
    await fullReader.read();
    const textReader = run.textStream.getReader();
    await expect(textReader.read()).rejects.toBeInstanceOf(StreamProtocolError);
    await fullReader.cancel();
  });

  test("does not pull provider chunks without consumer demand", async () => {
    let pulls = 0;
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "backpressure",
      generate: async () => modelResponse(),
      stream: async () =>
        new ReadableStream<ModelStreamPart>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue({ type: "text-delta", text: String(pulls) });
            },
          },
          { highWaterMark: 0 },
        ),
    };
    const run = streamText({ model, prompt: "x" });
    await Bun.sleep(5);
    expect(pulls).toBe(0);
    const reader = run.fullStream.getReader();
    await reader.read();
    const pullsAfterDemand = pulls;
    await Bun.sleep(5);
    expect(pulls).toBe(pullsAfterDemand);
    await reader.cancel();
  });

  test("rejects missing, duplicate, and post-finish events deterministically", async () => {
    const sequences: readonly (readonly ModelStreamPart[])[] = [
      [{ type: "text-delta", text: "unfinished" }],
      [
        { type: "finish", finishReason: "stop", usage },
        { type: "finish", finishReason: "stop", usage },
      ],
      [
        { type: "finish", finishReason: "stop", usage },
        { type: "text-delta", text: "late" },
      ],
    ];
    for (const parts of sequences) {
      const model: LanguageModel = {
        specificationVersion: "v1",
        provider: "test",
        modelId: "bad-stream",
        generate: async () => modelResponse(),
        stream: async () => streamFrom(parts),
      };
      const run = streamText({ model, prompt: "x" });
      const events = await collect(run.fullStream);
      expect(events.at(-1)?.type).toBe("error");
      await expect(run.result).rejects.toBeInstanceOf(StreamProtocolError);
    }
  });

  test("preserves partial text when a provider read fails", async () => {
    let pulls = 0;
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "partial",
      generate: async () => modelResponse(),
      stream: async () =>
        new ReadableStream<ModelStreamPart>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1)
              controller.enqueue({ type: "text-delta", text: "partial" });
            else controller.error(new NetworkError());
          },
        }),
    };
    const run = streamText({ model, prompt: "x" });
    await collect(run.fullStream);
    try {
      await run.result;
      throw new Error("Expected result to reject");
    } catch (error) {
      expect(AgentSdkError.isInstance(error)).toBe(true);
      if (AgentSdkError.isInstance(error))
        expect(error.partialResult).toMatchObject({ text: "partial" });
    }
  });
});

describe("Phase 1 cancellation and timeouts", () => {
  test("uses stable abort errors before requests", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "abort",
      generate: async () => modelResponse(),
    };
    await expect(
      generateText({ model, prompt: "x", abortSignal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
  });

  test("times out model requests", async () => {
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "request-timeout",
      generate: () => new Promise<ModelResponse>(() => undefined),
    };
    await expect(
      generateText({
        model,
        prompt: "x",
        retry: { maxRetries: 0 },
        timeouts: { requestMs: 5 },
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  test("times out the first and subsequent stream chunks", async () => {
    const never: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "first-timeout",
      generate: async () => modelResponse(),
      stream: async () => new ReadableStream<ModelStreamPart>(),
    };
    const first = streamText({
      model: never,
      prompt: "x",
      retry: { maxRetries: 0 },
      timeouts: { firstChunkMs: 5 },
    });
    await collect(first.fullStream);
    await expect(first.result).rejects.toMatchObject({
      timeoutKind: "first-chunk",
    });

    const delayed: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "chunk-timeout",
      generate: async () => modelResponse(),
      stream: async () =>
        new ReadableStream<ModelStreamPart>({
          start(controller) {
            controller.enqueue({ type: "text-delta", text: "first" });
          },
        }),
    };
    const chunk = streamText({
      model: delayed,
      prompt: "x",
      retry: { maxRetries: 0 },
      timeouts: { chunkMs: 5 },
    });
    await collect(chunk.fullStream);
    await expect(chunk.result).rejects.toMatchObject({ timeoutKind: "chunk" });
  });

  test("times out tools and passes the timeout signal", async () => {
    let toolSignal: AbortSignal | undefined;
    const slow = tool({
      name: "slow",
      description: "slow",
      inputSchema: defineSchema({ jsonSchema: null, parse: () => null }),
      execute(_input, context) {
        toolSignal = context.abortSignal;
        return new Promise<string>(() => undefined);
      },
    });
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "tool-timeout",
      generate: async () => ({
        text: "",
        toolCalls: [{ toolCallId: "slow-1", toolName: "slow", input: null }],
        finishReason: "tool-calls",
        usage,
      }),
    };
    await expect(
      generateText({
        model,
        prompt: "x",
        tools: { slow },
        maxSteps: 2,
        timeouts: { toolMs: 5 },
      }),
    ).rejects.toMatchObject({ timeoutKind: "tool" });
    expect(toolSignal?.aborted).toBe(true);
  });

  test("consumer cancellation cancels the provider", async () => {
    let providerCancelled = false;
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "cancel",
      generate: async () => modelResponse(),
      stream: async () =>
        new ReadableStream<ModelStreamPart>({
          pull(controller) {
            controller.enqueue({ type: "text-delta", text: "x" });
          },
          cancel() {
            providerCancelled = true;
          },
        }),
    };
    const run = streamText({ model, prompt: "x" });
    const reader = run.fullStream.getReader();
    await reader.read();
    await reader.cancel("stop");
    await expect(run.result).rejects.toBeInstanceOf(AbortError);
    expect(providerCancelled).toBe(true);
  });

  test("consumer cancellation aborts active tool execution", async () => {
    let toolSignal: AbortSignal | undefined;
    let markActive: () => void = () => undefined;
    const active = new Promise<void>((resolve) => {
      markActive = resolve;
    });
    const hanging = tool({
      name: "hanging",
      description: "hanging",
      inputSchema: defineSchema({ jsonSchema: null, parse: () => null }),
      execute(_input, context) {
        toolSignal = context.abortSignal;
        markActive();
        return new Promise<string>(() => undefined);
      },
    });
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "tool-cancel",
      generate: async () => modelResponse(),
      stream: async () =>
        streamFrom([
          {
            type: "tool-call",
            toolCall: {
              toolCallId: "hanging-1",
              toolName: "hanging",
              input: null,
            },
          },
          { type: "finish", finishReason: "tool-calls", usage },
        ]),
    };
    const run = streamText({
      model,
      prompt: "x",
      tools: { hanging },
      maxSteps: 2,
    });
    const reader = run.fullStream.getReader();
    while (true) {
      const read = await reader.read();
      if (read.done || read.value.type === "finish") break;
    }
    const toolPull = reader.read();
    await active;
    await reader.cancel("stop tool");
    await toolPull;
    await expect(run.result).rejects.toBeInstanceOf(AbortError);
    expect(toolSignal?.aborted).toBe(true);
  });
});

test("SDK errors are serializable and cross-package identifiable", () => {
  const error = new NetworkError({ provider: "test", modelId: "m" });
  expect(AgentSdkError.isInstance(error)).toBe(true);
  expect(error.toJSON()).toEqual({
    name: "NetworkError",
    code: "NETWORK_ERROR",
    message: "A network request failed",
    provider: "test",
    modelId: "m",
    requestId: undefined,
    statusCode: undefined,
    retryable: true,
    retryAfterMs: undefined,
  });
});
