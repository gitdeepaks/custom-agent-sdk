import { describe, expect, test } from "bun:test";
import {
  StreamProtocolError,
  streamText,
  type LanguageModel,
  type ModelStreamPart,
} from "../src";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const streamFrom = (
  parts: readonly ModelStreamPart[],
): ReadableStream<ModelStreamPart> =>
  new ReadableStream({
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

const nextRandom = (state: number): number =>
  (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

describe("release quality gates", () => {
  test("deterministically fuzzes provider stream terminal ordering", async () => {
    let state = 0x5eed1234;

    for (let caseNumber = 0; caseNumber < 100; caseNumber += 1) {
      state = nextRandom(state);
      const length = state % 9;
      const parts: ModelStreamPart[] = [];

      for (let index = 0; index < length; index += 1) {
        state = nextRandom(state);
        parts.push(
          state % 4 === 0
            ? { type: "finish", finishReason: "stop", usage }
            : { type: "text-delta", text: "x" },
        );
      }

      const finishIndexes = parts.flatMap((part, index) =>
        part.type === "finish" ? [index] : [],
      );
      const isValid =
        finishIndexes.length === 1 && finishIndexes[0] === parts.length - 1;
      const model: LanguageModel = {
        specificationVersion: "v1",
        provider: "fuzz",
        modelId: `case-${caseNumber}`,
        generate: async () => ({
          text: "fallback",
          toolCalls: [],
          finishReason: "stop",
          usage,
        }),
        stream: async () => streamFrom(parts),
      };
      const run = streamText({ model, prompt: "fuzz" });
      const resultOutcome = run.result.catch((error: unknown) => error);

      if (isValid) {
        await expect(collect(run.fullStream)).resolves.toBeArray();
        expect(await resultOutcome).not.toBeInstanceOf(Error);
      } else {
        const events = await collect(run.fullStream);
        const terminal = events.at(-1);
        if (
          terminal?.type !== "error" ||
          !(terminal.error instanceof StreamProtocolError)
        ) {
          throw new Error(
            `Malformed stream case ${caseNumber} was accepted: ${JSON.stringify(parts)}`,
          );
        }
        expect(await resultOutcome).toBeInstanceOf(StreamProtocolError);
      }
    }
  });
});
