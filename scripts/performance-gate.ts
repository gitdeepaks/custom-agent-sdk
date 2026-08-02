import { streamText, type LanguageModel, type ModelStreamPart } from "../src";

const chunkCount = 20_000;
let pulls = 0;
let emitted = 0;

const model: LanguageModel = {
  specificationVersion: "v1",
  provider: "performance-gate",
  modelId: "long-stream",
  generate: async () => ({
    text: "x".repeat(chunkCount),
    toolCalls: [],
    finishReason: "stop",
    usage: {
      inputTokens: 1,
      outputTokens: chunkCount,
      totalTokens: chunkCount + 1,
    },
  }),
  stream: async () =>
    new ReadableStream<ModelStreamPart>({
      pull(controller) {
        pulls += 1;
        if (emitted < chunkCount) {
          emitted += 1;
          controller.enqueue({ type: "text-delta", text: "x" });
          return;
        }
        controller.enqueue({
          type: "finish",
          finishReason: "stop",
          usage: {
            inputTokens: 1,
            outputTokens: chunkCount,
            totalTokens: chunkCount + 1,
          },
        });
        controller.close();
      },
    }),
};

const heapBefore = process.memoryUsage().heapUsed;
const startedAt = performance.now();
const run = streamText({ model, prompt: "long stream" });
const text = await new Response(run.textStream).text();
const result = await run.result;
const durationMs = performance.now() - startedAt;
const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

if (text.length !== chunkCount || result.text.length !== chunkCount) {
  throw new Error("Long-stream output was truncated");
}
if (pulls > chunkCount + 1) {
  throw new Error(`Provider was over-pulled: ${pulls} pulls`);
}
if (durationMs > 10_000) {
  throw new Error(`Long-stream gate exceeded 10 seconds: ${durationMs}ms`);
}
if (heapGrowth > 64 * 1024 * 1024) {
  throw new Error(`Long-stream heap growth exceeded 64 MiB: ${heapGrowth}`);
}

console.log(
  `Long-stream gate: ${chunkCount} chunks in ${durationMs.toFixed(1)}ms, ` +
    `${(heapGrowth / 1024 / 1024).toFixed(1)} MiB heap growth`,
);
