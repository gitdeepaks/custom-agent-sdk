import { describe, expect, test } from "bun:test";
import {
  Agent,
  AgentSdkError,
  ToolApprovalRequiredError,
  ToolError,
  defineSchema,
  generateText,
  hasToolCall,
  streamText,
  tool,
  type LanguageModel,
  type ModelRequest,
  type ModelResponse,
} from "../src";

const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };

const response = (options: Partial<ModelResponse> = {}): ModelResponse => {
  const toolCalls = options.toolCalls ?? [];
  return {
    text: options.text ?? "done",
    toolCalls,
    finishReason:
      options.finishReason ?? (toolCalls.length > 0 ? "tool-calls" : "stop"),
    usage: options.usage ?? usage,
  };
};

class SequenceModel implements LanguageModel {
  readonly specificationVersion = "v1";
  readonly provider = "test";
  readonly modelId = "phase-3";
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: readonly ModelResponse[]) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const value = this.responses[this.index];
    if (!value) throw new Error("No response configured");
    this.index += 1;
    return value;
  }
}

const nullSchema = defineSchema({ jsonSchema: null, parse: () => null });
const stringSchema = defineSchema({
  jsonSchema: { type: "string" },
  parse(value: unknown) {
    if (typeof value !== "string") throw new Error("Expected string");
    return value;
  },
});

describe("Phase 3 tool contracts", () => {
  test("validates outputs before returning them to the model", async () => {
    const invalid = tool({
      name: "invalid",
      description: "Returns an invalid output",
      inputSchema: nullSchema,
      outputSchema: defineSchema({
        jsonSchema: { const: "valid" },
        parse(value: unknown) {
          if (value !== "valid") throw new Error("Expected valid output");
          return value;
        },
      }),
      execute: () => "invalid",
    });
    const model = new SequenceModel([
      response({
        toolCalls: [{ toolCallId: "call-1", toolName: "invalid", input: null }],
      }),
    ]);

    await expect(
      generateText({ model, prompt: "run", tools: { invalid }, maxSteps: 2 }),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_INVALID" });
  });

  test("awaits approval and preserves execution metadata", async () => {
    const contexts: string[] = [];
    const sensitive = tool({
      name: "sensitive",
      description: "Sensitive operation",
      inputSchema: nullSchema,
      outputSchema: stringSchema,
      needsApproval: true,
      execute(_input, context) {
        contexts.push(context.idempotencyKey);
        return "approved";
      },
    });
    const model = new SequenceModel([
      response({
        toolCalls: [
          { toolCallId: "sensitive-1", toolName: "sensitive", input: null },
        ],
      }),
      response({ text: "complete" }),
    ]);
    const approvals: string[] = [];
    const result = await generateText({
      model,
      prompt: "run",
      runId: "run-1",
      tools: { sensitive },
      maxSteps: 2,
      requestToolApproval(request) {
        approvals.push(request.toolCallId);
        return "approved";
      },
    });

    expect(approvals).toEqual(["sensitive-1"]);
    expect(contexts).toEqual(["run-1:sensitive-1"]);
    expect(result.text).toBe("complete");
  });

  test("never executes an unresolved approval", async () => {
    let executed = false;
    const sensitive = tool({
      name: "sensitive",
      description: "Sensitive operation",
      inputSchema: nullSchema,
      needsApproval: true,
      execute() {
        executed = true;
        return "unexpected";
      },
    });
    const model = new SequenceModel([
      response({
        toolCalls: [
          { toolCallId: "sensitive-1", toolName: "sensitive", input: null },
        ],
      }),
    ]);

    await expect(
      generateText({ model, prompt: "run", tools: { sensitive }, maxSteps: 2 }),
    ).rejects.toBeInstanceOf(ToolApprovalRequiredError);
    expect(executed).toBe(false);
  });

  test("bounds parallel execution and preserves model call order", async () => {
    let active = 0;
    let maximumActive = 0;
    const delayed = tool({
      name: "delayed",
      description: "Delayed operation",
      inputSchema: stringSchema,
      outputSchema: stringSchema,
      async execute(input) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Bun.sleep(input === "first" ? 8 : 1);
        active -= 1;
        return input;
      },
    });
    const calls = ["first", "second", "third"].map((input, index) => ({
      toolCallId: `call-${index}`,
      toolName: "delayed",
      input,
    }));
    const model = new SequenceModel([
      response({ toolCalls: calls }),
      response({ text: "complete" }),
    ]);

    const result = await generateText({
      model,
      prompt: "run",
      tools: { delayed },
      maxSteps: 2,
      toolExecution: { maxConcurrency: 2 },
    });

    expect(maximumActive).toBe(2);
    expect(result.steps[0]?.toolResults.map((item) => item.output)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("preserves completed sibling results when a tool fails", async () => {
    const worker = tool({
      name: "worker",
      description: "May fail",
      inputSchema: stringSchema,
      outputSchema: stringSchema,
      async execute(input) {
        if (input === "fail") {
          await Bun.sleep(5);
          throw new Error("failed");
        }
        return input;
      },
    });
    const model = new SequenceModel([
      response({
        toolCalls: [
          { toolCallId: "ok", toolName: "worker", input: "complete" },
          { toolCallId: "bad", toolName: "worker", input: "fail" },
        ],
      }),
    ]);

    try {
      await generateText({
        model,
        prompt: "run",
        tools: { worker },
        maxSteps: 2,
      });
      throw new Error("Expected generation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      if (AgentSdkError.isInstance(error))
        expect(error.partialResult).toMatchObject({
          completedToolResults: [{ toolCallId: "ok", output: "complete" }],
        });
    }
  });

  test("rejects duplicate builder registrations", () => {
    const duplicate = tool({
      name: "duplicate",
      description: "Duplicate",
      inputSchema: nullSchema,
      execute: () => null,
    });
    expect(() => Agent.builder().tool(duplicate).tool(duplicate)).toThrow(
      'Tool "duplicate" is already registered',
    );
  });
});

describe("Phase 3 agent orchestration", () => {
  test("prepares each step, limits active tools, and manages request context", async () => {
    const first = tool({
      name: "first",
      description: "First",
      inputSchema: nullSchema,
      execute: () => null,
    });
    const second = tool({
      name: "second",
      description: "Second",
      inputSchema: nullSchema,
      execute: () => null,
    });
    const model = new SequenceModel([response()]);
    await generateText({
      model,
      prompt: "original",
      tools: { first, second },
      prepareStep: () => ({ activeTools: ["second"], temperature: 0.25 }),
      contextManager: {
        prepareMessages: () => [{ role: "user", content: "compacted" }],
      },
    });

    expect(model.requests[0]?.tools.map((item) => item.name)).toEqual([
      "second",
    ]);
    expect(model.requests[0]?.temperature).toBe(0.25);
    expect(model.requests[0]?.messages).toEqual([
      { role: "user", content: "compacted" },
    ]);
  });

  test("stops before unusable or explicitly terminal tool calls", async () => {
    let executions = 0;
    const finalAnswer = tool({
      name: "finalAnswer",
      description: "Terminal tool",
      inputSchema: nullSchema,
      execute() {
        executions += 1;
        return null;
      },
    });
    const terminal = response({
      toolCalls: [
        { toolCallId: "final", toolName: "finalAnswer", input: null },
      ],
    });
    const maxResult = await generateText({
      model: new SequenceModel([terminal]),
      prompt: "run",
      tools: { finalAnswer },
      maxSteps: 1,
    });
    const conditionResult = await generateText({
      model: new SequenceModel([terminal]),
      prompt: "run",
      tools: { finalAnswer },
      maxSteps: 3,
      stopWhen: hasToolCall("finalAnswer"),
    });

    expect(maxResult.stopReason).toBe("max-steps");
    expect(conditionResult.stopReason).toBe("stop-condition");
    expect(executions).toBe(0);
  });

  test("enforces token budgets and lifecycle ordering", async () => {
    const events: string[] = [];
    const model = new SequenceModel([response({ usage })]);
    const result = await generateText({
      model,
      prompt: "run",
      budget: { tokens: { maxTotalTokens: 5 } },
      callbacks: {
        onStart: () => {
          events.push("start");
        },
        onStepStart: () => {
          events.push("step-start");
        },
        onStepEnd: () => {
          events.push("step-end");
        },
        onFinish: () => {
          events.push("finish");
        },
      },
    });

    expect(result.stopReason).toBe("model-finish");
    expect(events).toEqual(["start", "step-start", "step-end", "finish"]);
  });

  test("uses the same stop semantics for streaming", async () => {
    let executed = false;
    const terminal = tool({
      name: "terminal",
      description: "Terminal",
      inputSchema: nullSchema,
      execute() {
        executed = true;
        return null;
      },
    });
    const model: LanguageModel = {
      specificationVersion: "v1",
      provider: "test",
      modelId: "stream-phase-3",
      generate: async () => response(),
      stream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: "tool-call",
              toolCall: {
                toolCallId: "terminal-1",
                toolName: "terminal",
                input: null,
              },
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage,
            });
            controller.close();
          },
        }),
    };
    const streamed = streamText({
      model,
      prompt: "run",
      tools: { terminal },
      maxSteps: 1,
    });
    for await (const _event of streamed.fullStream) {
      // Drain the backpressured session.
    }
    const result = await streamed.result;

    expect(result.stopReason).toBe("max-steps");
    expect(executed).toBe(false);
  });
});
