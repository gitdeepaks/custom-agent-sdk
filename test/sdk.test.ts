import { describe, expect, test } from "bun:test";
import {
  Agent,
  AgentSdkError,
  NetworkError,
  defineSchema,
  generateText,
  streamText,
  tool,
  ToolError,
  type LanguageModel,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamPart,
} from "../src";

const usage = { inputTokens: 4, outputTokens: 2, totalTokens: 6 };

const response = (options: Partial<ModelResponse> = {}): ModelResponse => {
  const toolCalls = options.toolCalls ?? [];
  return {
    text: options.text ?? "hello",
    toolCalls,
    finishReason:
      options.finishReason ?? (toolCalls.length > 0 ? "tool-calls" : "stop"),
    usage: options.usage ?? usage,
  };
};

class SequenceModel implements LanguageModel {
  readonly specificationVersion = "v1";
  readonly provider = "test";
  readonly modelId = "sequence";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: readonly ModelResponse[]) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const current = this.responses[this.index];
    if (!current) throw new Error("No response configured");
    this.index += 1;
    return current;
  }
}

describe("generateText", () => {
  test("returns text and usage from a provider-neutral model", async () => {
    const model = new SequenceModel([response()]);
    const result = await generateText({ model, prompt: "Hi" });

    expect(result.text).toBe("hello");
    expect(result.usage).toEqual(usage);
    expect(model.requests[0]?.messages).toEqual([
      { role: "user", content: "Hi" },
    ]);
  });

  test("validates typed tool input and continues the loop", async () => {
    const seenInputs: number[] = [];
    const double = tool({
      name: "double",
      description: "Double a number",
      inputSchema: defineSchema({
        jsonSchema: { type: "number" },
        parse(value) {
          if (typeof value !== "number" || !Number.isFinite(value))
            throw new Error("Expected a finite number");
          return value;
        },
      }),
      execute(input) {
        seenInputs.push(input);
        return input * 2;
      },
    });
    const model = new SequenceModel([
      response({
        text: "",
        finishReason: "tool-calls",
        toolCalls: [{ toolCallId: "call-1", toolName: "double", input: 21 }],
      }),
      response({ text: "42" }),
    ]);

    const result = await generateText({
      model,
      prompt: "Double 21",
      tools: { double },
      maxSteps: 2,
    });

    expect(result.text).toBe("42");
    expect(seenInputs).toEqual([21]);
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-1",
      toolName: "double",
      output: 42,
    });
    expect(result.usage.totalTokens).toBe(12);
  });

  test("rejects invalid tool input without invoking execute", async () => {
    let executed = false;
    const strict = tool({
      name: "strict",
      description: "Only numbers",
      inputSchema: defineSchema({
        jsonSchema: { type: "number" },
        parse(value) {
          if (typeof value !== "number") throw new Error("Expected number");
          return value;
        },
      }),
      execute() {
        executed = true;
        return "unexpected";
      },
    });
    const model = new SequenceModel([
      response({
        toolCalls: [{ toolCallId: "bad", toolName: "strict", input: "no" }],
      }),
    ]);

    await expect(
      generateText({ model, prompt: "run", tools: { strict }, maxSteps: 2 }),
    ).rejects.toMatchObject({
      code: "TOOL_INPUT_INVALID",
      toolName: "strict",
    });
    expect(executed).toBe(false);
  });

  test("uses stable errors for unknown tools and invalid limits", async () => {
    const model = new SequenceModel([
      response({
        toolCalls: [
          { toolCallId: "missing", toolName: "unknown", input: null },
        ],
      }),
    ]);

    await expect(
      generateText({ model, prompt: "run", maxSteps: 2 }),
    ).rejects.toBeInstanceOf(ToolError);
    await expect(
      generateText({ model, prompt: "run", maxSteps: 0 }),
    ).rejects.toBeInstanceOf(AgentSdkError);
  });

  test("retries transient model failures", async () => {
    let attempts = 0;
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "retry",
      async generate() {
        attempts += 1;
        if (attempts < 2) throw new NetworkError({ message: "temporary" });
        return response({ text: "recovered" });
      },
    };

    const result = await generateText({ model, prompt: "Hi", maxRetries: 1 });
    expect(result.text).toBe("recovered");
    expect(attempts).toBe(2);
  });
});

describe("streamText", () => {
  test("forwards native provider stream events", async () => {
    const parts: readonly ModelStreamPart[] = [
      { type: "text-delta", text: "hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", finishReason: "stop", usage },
    ];
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "stream",
      generate: async () => response(),
      async stream() {
        return new ReadableStream<ModelStreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        });
      },
    };

    const streamed = streamText({ model, prompt: "Hi" });
    const text = await new Response(streamed.textStream).text();
    const result = await streamed.result;

    expect(text).toBe("hello");
    expect(result.text).toBe("hello");
  });
});

test("Agent applies reusable settings", async () => {
  const model = new SequenceModel([response({ text: "agent response" })]);
  const agent = new Agent({ model, instructions: "Be concise" });
  const result = await agent.run({ prompt: "Hi" });

  expect(result.text).toBe("agent response");
  expect(model.requests[0]?.messages[0]).toEqual({
    role: "system",
    content: "Be concise",
  });
});

describe("Agent.builder", () => {
  test("builds an agent with fluent instructions and tools", async () => {
    const model = new SequenceModel([response({ text: "builder response" })]);
    const first = tool({
      name: "first",
      description: "First tool",
      inputSchema: defineSchema({
        jsonSchema: { type: "null" },
        parse: () => null,
      }),
      execute: () => "first",
    });
    const second = tool({
      name: "second",
      description: "Second tool",
      inputSchema: defineSchema({
        jsonSchema: { type: "null" },
        parse: () => null,
      }),
      execute: () => "second",
    });

    const agent = Agent.builder()
      .setModel(model)
      .setInstructions("You are an expert coding agent")
      .tool(first)
      .toolList([second])
      .build();
    await agent.run({ prompt: "Create a file" });

    expect(model.requests[0]?.messages[0]).toEqual({
      role: "system",
      content: "You are an expert coding agent",
    });
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual([
      "first",
      "second",
    ]);
  });

  test("requires a language model", () => {
    expect(() => Agent.builder().build()).toThrow(
      "Agent builder requires a language model",
    );
  });
});
