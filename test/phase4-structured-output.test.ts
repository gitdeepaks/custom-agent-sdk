import { describe, expect, test } from "bun:test";
import {
  Agent,
  OutputValidationError,
  defineSchema,
  generateObject,
  streamObject,
  type JsonValue,
  type LanguageModel,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamPart,
} from "../src";
import { createAnthropic } from "../src/providers/anthropic";
import { createOpenAI } from "../src/providers/openai";

const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };

const modelResponse = (text: string): ModelResponse => ({
  text,
  toolCalls: [],
  finishReason: "stop",
  usage,
});

class StructuredModel implements LanguageModel {
  readonly specificationVersion = "v1";
  readonly provider = "test";
  readonly modelId = "structured";
  request: ModelRequest | undefined;

  constructor(
    private readonly text: string,
    private readonly chunks: readonly string[] = [text],
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.request = request;
    return modelResponse(this.text);
  }

  async stream(
    request: ModelRequest,
  ): Promise<ReadableStream<ModelStreamPart>> {
    this.request = request;
    const chunks = this.chunks;
    return new ReadableStream<ModelStreamPart>({
      start(controller) {
        for (const text of chunks)
          controller.enqueue({ type: "text-delta", text });
        controller.enqueue({ type: "finish", finishReason: "stop", usage });
        controller.close();
      },
    });
  }
}

const profileSchema = defineSchema({
  jsonSchema: {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "number" } },
    required: ["name", "age"],
    additionalProperties: false,
  },
  parse(value: unknown): { readonly name: string; readonly age: number } {
    if (
      typeof value !== "object" ||
      value === null ||
      !("name" in value) ||
      typeof value.name !== "string" ||
      !("age" in value) ||
      typeof value.age !== "number"
    )
      throw new Error("Expected a profile");
    return { name: value.name, age: value.age };
  },
});

const numberSchema = defineSchema({
  jsonSchema: { type: "number" },
  parse(value: unknown): number {
    if (typeof value !== "number") throw new Error("Expected a number");
    return value;
  },
});

describe("Phase 4 structured generation", () => {
  test("generates and validates typed objects with a native output contract", async () => {
    const model = new StructuredModel('{"name":"Ada","age":36}');
    const result = await generateObject({
      model,
      prompt: "Generate a profile",
      schema: profileSchema,
      name: "profile",
    });

    expect(result.object).toEqual({ name: "Ada", age: 36 });
    expect(result.usage).toEqual(usage);
    expect(model.request?.outputFormat).toEqual({
      type: "json",
      name: "profile",
      description: undefined,
      schema: profileSchema.jsonSchema,
    });
  });

  test("supports array, enum, and arbitrary JSON modes", async () => {
    const array = await generateObject({
      model: new StructuredModel("[1,2,3]"),
      prompt: "numbers",
      mode: "array",
      schema: numberSchema,
    });
    const enumeration = await generateObject({
      model: new StructuredModel('"approved"'),
      prompt: "status",
      mode: "enum",
      values: ["approved", "denied"],
    });
    const json = await generateObject({
      model: new StructuredModel("null"),
      prompt: "json",
      mode: "json",
    });

    const status: "approved" | "denied" = enumeration.object;
    const value: JsonValue = json.object;
    expect(array.object).toEqual([1, 2, 3]);
    expect(status).toBe("approved");
    expect(value).toBeNull();
  });

  test("never exposes malformed or schema-invalid output as typed data", async () => {
    await expect(
      generateObject({
        model: new StructuredModel('{"name":"Ada"}'),
        prompt: "profile",
        schema: profileSchema,
      }),
    ).rejects.toBeInstanceOf(OutputValidationError);
    await expect(
      generateObject({
        model: new StructuredModel("not-json"),
        prompt: "profile",
        schema: profileSchema,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_VALIDATION_FAILED" });
  });

  test("repairs once and validates the repaired output", async () => {
    let repairs = 0;
    const result = await generateObject({
      model: new StructuredModel('{"name":"Ada"}'),
      prompt: "profile",
      schema: profileSchema,
      repair({ error, text }) {
        repairs += 1;
        expect(error).toBeInstanceOf(OutputValidationError);
        expect(text).toBe('{"name":"Ada"}');
        return '{"name":"Ada","age":36}';
      },
    });

    expect(result.object.age).toBe(36);
    expect(repairs).toBe(1);
  });

  test("rejects invalid repaired output with generation metadata", async () => {
    try {
      await generateObject({
        model: new StructuredModel("invalid"),
        prompt: "profile",
        schema: profileSchema,
        repair: () => "still invalid",
      });
      throw new Error("Expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OutputValidationError);
      if (error instanceof OutputValidationError)
        expect(error.partialResult).toMatchObject({ usage });
    }
  });

  test("supports schema-validated final output from agents", async () => {
    const agent = new Agent({
      model: new StructuredModel('{"name":"Ada","age":36}'),
    });
    const result = await agent.runObject({
      prompt: "profile",
      schema: profileSchema,
    });
    expect(result.object.name).toBe("Ada");
  });
});

describe("Phase 4 structured streaming", () => {
  test("emits valid JSON snapshots and validates only the final result", async () => {
    const run = streamObject({
      model: new StructuredModel('{"name":"Ada","age":36}', [
        '{"name":"A',
        'da","age":',
        "36}",
      ]),
      prompt: "profile",
      schema: profileSchema,
    });
    const partials: JsonValue[] = [];
    for await (const partial of run.partialObjectStream) partials.push(partial);
    const result = await run.result;

    expect(partials.length).toBeGreaterThan(1);
    expect(partials.at(-1)).toEqual({ name: "Ada", age: 36 });
    expect(result.object).toEqual({ name: "Ada", age: 36 });
  });

  test("preserves partial snapshots while rejecting an invalid final schema", async () => {
    const run = streamObject({
      model: new StructuredModel('{"name":"Ada"}', ['{"name":"A', 'da"}']),
      prompt: "profile",
      schema: profileSchema,
    });
    const partials: JsonValue[] = [];
    for await (const partial of run.partialObjectStream) partials.push(partial);

    expect(partials.length).toBeGreaterThan(0);
    await expect(run.result).rejects.toBeInstanceOf(OutputValidationError);
  });

  test("supports structured final output from streaming agents", async () => {
    const agent = new Agent({
      model: new StructuredModel("[1,2]", ["[1,", "2]"]),
    });
    const run = agent.streamObject({
      prompt: "numbers",
      mode: "array",
      schema: numberSchema,
    });
    for await (const _partial of run.partialObjectStream) {
      // Drain the demand-driven stream.
    }
    expect((await run.result).object).toEqual([1, 2]);
  });
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
};

const requestBody = (
  init: RequestInit | undefined,
): Readonly<Record<string, unknown>> => {
  if (typeof init?.body !== "string")
    throw new Error("Expected a request body");
  const value: unknown = JSON.parse(init.body);
  return requireRecord(value);
};

describe("Phase 4 provider structured output contract", () => {
  test("OpenAI sends native JSON schema and core rejects invalid output", async () => {
    let captured: Readonly<Record<string, unknown>> | undefined;
    const fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      captured = requestBody(init);
      return Response.json({
        id: "response-1",
        status: "completed",
        model: "openai-test",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: '{"name":"Ada"}' }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    };
    const model = createOpenAI({ apiKey: "test", fetch }).languageModel(
      "openai-test",
    );

    await expect(
      generateObject({ model, prompt: "profile", schema: profileSchema }),
    ).rejects.toBeInstanceOf(OutputValidationError);
    if (!captured) throw new Error("Expected an OpenAI request");
    const text = requireRecord(captured["text"]);
    expect(requireRecord(text["format"])).toMatchObject({
      type: "json_schema",
      strict: true,
      schema: profileSchema.jsonSchema,
    });
  });

  test("Anthropic sends native JSON schema and returns validated output", async () => {
    let captured: Readonly<Record<string, unknown>> | undefined;
    const fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      captured = requestBody(init);
      return Response.json({
        id: "message-1",
        model: "anthropic-test",
        content: [{ type: "text", text: '{"name":"Ada","age":36}' }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    };
    const model = createAnthropic({ apiKey: "test", fetch }).languageModel(
      "anthropic-test",
    );
    const result = await generateObject({
      model,
      prompt: "profile",
      schema: profileSchema,
    });

    expect(result.object.age).toBe(36);
    if (!captured) throw new Error("Expected an Anthropic request");
    const outputConfig = requireRecord(captured["output_config"]);
    expect(requireRecord(outputConfig["format"])).toEqual({
      type: "json_schema",
      schema: profileSchema.jsonSchema,
    });
  });
});
