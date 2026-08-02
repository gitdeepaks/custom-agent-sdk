import { describe, expect, test } from "bun:test";
import {
  MemoryLanguageModelCache,
  cacheMiddleware,
  defaultSettingsMiddleware,
  generateText,
  loggingMiddleware,
  retryMiddleware,
  streamText,
  tool,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelLogEvent,
  type LanguageModelMiddleware,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamPart,
} from "../src";

const usage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 } as const;

const response = (text = "ok"): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: "stop",
  usage,
});

const request = (headers?: Readonly<Record<string, string>>): ModelRequest => ({
  messages: [{ role: "user", content: "secret prompt" }],
  tools: [],
  headers,
});

const streamParts = (text = "ok"): readonly ModelStreamPart[] => [
  { type: "text-delta", text },
  { type: "finish", finishReason: "stop", usage },
];

const readableParts = (
  parts: readonly ModelStreamPart[],
): ReadableStream<ModelStreamPart> => {
  let index = 0;
  return new ReadableStream<ModelStreamPart>({
    pull(controller) {
      const part = parts[index];
      if (part === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(part);
    },
  });
};

const collect = async <Value>(
  stream: ReadableStream<Value>,
): Promise<Value[]> => {
  const values: Value[] = [];
  for await (const value of stream) values.push(value);
  return values;
};

describe("Phase 5 middleware", () => {
  test("composes middleware in the same order for generate and stream", async () => {
    const events: string[] = [];
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "ordered",
      async generate() {
        events.push("provider:generate");
        return response();
      },
      async stream() {
        events.push("provider:stream");
        return readableParts(streamParts());
      },
    };
    const middleware = (name: string): LanguageModelMiddleware => ({
      async generate(context, modelRequest, next) {
        expect(context.model).toBe(model);
        events.push(`${name}:generate:before`);
        const result = await next(modelRequest);
        events.push(`${name}:generate:after`);
        return result;
      },
      async stream(context, modelRequest, next) {
        expect(context.model).toBe(model);
        events.push(`${name}:stream:before`);
        const result = await next(modelRequest);
        events.push(`${name}:stream:after`);
        return result;
      },
    });
    const wrapped = wrapLanguageModel({
      model,
      middleware: [middleware("outer"), middleware("inner")],
    });

    await wrapped.generate(request());
    if (!wrapped.stream) throw new Error("Expected wrapped native stream");
    await collect(await wrapped.stream(request()));

    expect(events).toEqual([
      "outer:generate:before",
      "inner:generate:before",
      "provider:generate",
      "inner:generate:after",
      "outer:generate:after",
      "outer:stream:before",
      "inner:stream:before",
      "provider:stream",
      "inner:stream:after",
      "outer:stream:after",
    ]);
  });

  test("applies immutable defaults while explicit request settings win", async () => {
    const seen: ModelRequest[] = [];
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "defaults",
      async generate(modelRequest) {
        seen.push(modelRequest);
        return response();
      },
    };
    const wrapped = wrapLanguageModel({
      model,
      middleware: [
        defaultSettingsMiddleware({
          temperature: 0.2,
          maxOutputTokens: 100,
          headers: { authorization: "default", shared: "default" },
          providerOptions: { region: "default", tier: "standard" },
        }),
      ],
    });
    const original: ModelRequest = {
      ...request({ authorization: "request", tenant: "one" }),
      temperature: 0.8,
      providerOptions: { region: "request" },
    };

    await wrapped.generate(original);

    expect(seen[0]).toMatchObject({
      temperature: 0.8,
      maxOutputTokens: 100,
      headers: {
        authorization: "request",
        shared: "default",
        tenant: "one",
      },
      providerOptions: { region: "request", tier: "standard" },
    });
    expect(original.maxOutputTokens).toBeUndefined();
    expect(original.headers).toEqual({
      authorization: "request",
      tenant: "one",
    });
  });

  test("logging excludes content by default and finishes streams on consumption", async () => {
    const events: LanguageModelLogEvent[] = [];
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "logging",
      async generate() {
        return response("secret output");
      },
      async stream() {
        return readableParts(streamParts("secret output"));
      },
    };
    const wrapped = wrapLanguageModel({
      model,
      middleware: [
        loggingMiddleware({
          logger: {
            log(event) {
              events.push(event);
            },
          },
        }),
      ],
    });

    await wrapped.generate(request());
    if (!wrapped.stream) throw new Error("Expected wrapped native stream");
    const modelStream = await wrapped.stream(request());
    expect(events.map((event) => event.type)).toEqual([
      "model-start",
      "model-finish",
      "model-start",
    ]);
    await collect(modelStream);

    expect(events.map((event) => event.type)).toEqual([
      "model-start",
      "model-finish",
      "model-start",
      "model-finish",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret prompt");
    expect(JSON.stringify(events)).not.toContain("secret output");
  });

  test("caches completed generate and stream results without cross-mode reuse", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "cache",
      async generate() {
        generateCalls += 1;
        return response(`generate-${generateCalls}`);
      },
      async stream() {
        streamCalls += 1;
        return readableParts(streamParts(`stream-${streamCalls}`));
      },
    };
    const wrapped = wrapLanguageModel({
      model,
      middleware: [cacheMiddleware({ cache: new MemoryLanguageModelCache() })],
    });

    expect((await wrapped.generate(request())).text).toBe("generate-1");
    expect((await wrapped.generate(request())).text).toBe("generate-1");
    if (!wrapped.stream) throw new Error("Expected wrapped native stream");
    expect(await collect(await wrapped.stream(request()))).toEqual([
      ...streamParts("stream-1"),
    ]);
    expect(await collect(await wrapped.stream(request()))).toEqual([
      ...streamParts("stream-1"),
    ]);
    expect(generateCalls).toBe(1);
    expect(streamCalls).toBe(1);
  });

  test("does not cache cancelled streams and hashes headers into cache identity", async () => {
    let calls = 0;
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "cache-safety",
      async generate() {
        calls += 1;
        return response(`call-${calls}`);
      },
      async stream() {
        calls += 1;
        return readableParts(streamParts(`call-${calls}`));
      },
    };
    const wrapped = wrapLanguageModel({
      model,
      middleware: [cacheMiddleware({ cache: new MemoryLanguageModelCache() })],
    });

    expect((await wrapped.generate(request({ tenant: "one" }))).text).toBe(
      "call-1",
    );
    expect((await wrapped.generate(request({ tenant: "two" }))).text).toBe(
      "call-2",
    );
    if (!wrapped.stream) throw new Error("Expected wrapped native stream");
    const reader = (await wrapped.stream(request())).getReader();
    await reader.read();
    await reader.cancel("consumer stopped");
    await collect(await wrapped.stream(request()));
    expect(calls).toBe(4);
  });

  test("retries classified transient failures for both operations", async () => {
    let generateCalls = 0;
    let streamCalls = 0;
    const retries: string[] = [];
    const transient = (): Error & { retryable: boolean } =>
      Object.assign(new Error("temporary"), { retryable: true });
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "retry",
      async generate() {
        generateCalls += 1;
        if (generateCalls === 1) throw transient();
        return response();
      },
      async stream() {
        streamCalls += 1;
        if (streamCalls === 1) throw transient();
        return readableParts(streamParts());
      },
    };
    const wrapped = wrapLanguageModel({
      model,
      middleware: [
        retryMiddleware({
          maxRetries: 1,
          initialDelayMs: 1,
          onRetry(event) {
            retries.push(event.operation);
          },
        }),
      ],
    });

    await wrapped.generate(request());
    if (!wrapped.stream) throw new Error("Expected wrapped native stream");
    await collect(await wrapped.stream(request()));
    expect([generateCalls, streamCalls]).toEqual([2, 2]);
    expect(retries).toEqual(["generate", "stream"]);
  });
});

describe("Phase 5 telemetry", () => {
  test("is fully disabled without telemetry or with enabled false", async () => {
    let redactions = 0;
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "disabled-telemetry",
      async generate() {
        return response("private");
      },
    };

    await generateText({ model, prompt: "private" });
    await generateText({
      model,
      prompt: "private",
      telemetry: {
        enabled: false,
        recordInputs: true,
        recordOutputs: true,
        redact(value) {
          redactions += 1;
          return value;
        },
      },
    });

    expect(redactions).toBe(0);
  });

  test("records opted-in model and tool data while keeping defaults private", async () => {
    let defaultRedactions = 0;
    const plainModel: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "private-defaults",
      async generate() {
        return response("private output");
      },
    };
    await generateText({
      model: plainModel,
      prompt: "private input",
      telemetry: {
        redact(value) {
          defaultRedactions += 1;
          return value;
        },
      },
    });
    expect(defaultRedactions).toBe(0);

    const redacted: string[] = [];
    let call = 0;
    const toolModel: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "telemetry-tool",
      async generate() {
        call += 1;
        return call === 1
          ? {
              text: "",
              toolCalls: [
                {
                  toolCallId: "call-1",
                  toolName: "lookup",
                  input: { secret: "input" },
                },
              ],
              finishReason: "tool-calls",
              usage,
            }
          : response("private model output");
      },
    };
    const lookup = tool({
      name: "lookup",
      description: "Lookup a value",
      inputSchema: {
        jsonSchema: { type: "object" },
        parse(value: unknown) {
          return value;
        },
      },
      execute: () => ({ secret: "output" }),
    });

    const result = await generateText({
      model: toolModel,
      prompt: "private model input",
      tools: { lookup },
      maxSteps: 2,
      telemetry: {
        recordInputs: true,
        recordOutputs: true,
        recordToolInputs: true,
        recordToolOutputs: true,
        redact(value) {
          redacted.push(value);
          return "[redacted]";
        },
      },
    });

    expect(result.text).toBe("private model output");
    expect(
      redacted.some((value) => value.includes("private model input")),
    ).toBe(true);
    expect(
      redacted.some((value) => value.includes("private model output")),
    ).toBe(true);
    expect(redacted.some((value) => value.includes('"secret":"input"'))).toBe(
      true,
    );
    expect(redacted.some((value) => value.includes('"secret":"output"'))).toBe(
      true,
    );
  });

  test("instruments native streaming without changing emitted data", async () => {
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "telemetry-stream",
      async generate() {
        return response("fallback");
      },
      async stream() {
        return readableParts(streamParts("native"));
      },
    };
    const streamed = streamText({ model, prompt: "hello", telemetry: {} });

    expect(await collect(streamed.textStream)).toEqual(["native"]);
    expect((await streamed.result).text).toBe("native");
  });
});
