import {
  defineSchema,
  generateText,
  streamText,
  tool,
  type LanguageModel,
} from "../src";
import { createAnthropic } from "../src/providers/anthropic";
import { createOpenAI } from "../src/providers/openai";

const requireEnvironment = (name: string): string => {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required for live provider tests`);
  return value;
};

const smokeTool = tool({
  name: "live_smoke_value",
  description: "Return the fixed value used by the live SDK smoke test",
  inputSchema: defineSchema({
    jsonSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    parse(value): Readonly<Record<string, never>> {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Expected an object");
      return {};
    },
  }),
  execute: () => ({ value: 42 }),
});

const testProvider = async (
  provider: string,
  model: LanguageModel,
): Promise<void> => {
  const generated = await generateText({
    model,
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: "Reply briefly." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Reply with the word ready." }],
      },
    ],
    maxOutputTokens: 32,
    retry: { maxRetries: 1 },
  });
  if (generated.text.trim().length === 0)
    throw new Error(`${provider} returned empty generated text`);

  const streamed = streamText({
    model,
    prompt: "Reply with the word streaming.",
    maxOutputTokens: 32,
    retry: { maxRetries: 1 },
  });
  const streamedText = await new Response(streamed.textStream).text();
  const streamResult = await streamed.result;
  if (streamedText.trim().length === 0)
    throw new Error(`${provider} returned empty streamed text`);

  const toolResult = await generateText({
    model,
    prompt:
      "Call live_smoke_value exactly once. After receiving its result, answer with the numeric value and do not call another tool.",
    tools: { live_smoke_value: smokeTool },
    maxSteps: 2,
    maxOutputTokens: 64,
    retry: { maxRetries: 1 },
  });
  if (!toolResult.steps.some((step) => step.toolCalls.length > 0))
    throw new Error(`${provider} did not execute the requested tool`);

  console.log(
    `${provider}: passed (generate=${generated.usage.totalTokens}, stream=${streamResult.usage.totalTokens}, tool=${toolResult.usage.totalTokens} tokens)`,
  );
};

const openAI = createOpenAI({
  apiKey: requireEnvironment("OPENAI_API_KEY"),
  baseURL: Bun.env["OPENAI_BASE_URL"],
}).languageModel(Bun.env["OPENAI_MODEL"] ?? "gpt-4.1-mini");

const anthropic = createAnthropic({
  apiKey: requireEnvironment("ANTHROPIC_API_KEY"),
  baseURL: Bun.env["ANTHROPIC_BASE_URL"],
}).languageModel(Bun.env["ANTHROPIC_MODEL"] ?? "claude-haiku-4-5-20251001");

await testProvider("openai", openAI);
await testProvider("anthropic", anthropic);
