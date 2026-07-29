# Open Agent SDK

A provider-neutral, type-safe agent SDK for TypeScript, designed around the ergonomic core of the Vercel AI SDK while keeping providers and application concerns separate.

## Status

This repository is the production-oriented core foundation. It includes text generation, native streaming, runtime-validated tools, bounded tool loops, retries, cancellation, stable errors, usage aggregation, and a reusable `Agent` API. Provider adapters, structured output, middleware, telemetry, persistence, and UI framework packages should be versioned independently as the project grows.

## Requirements

- Bun 1.2 or newer
- TypeScript 7

## Install

```bash
bun install
```

## Quick Start

Providers implement the small `LanguageModel` interface:

```ts
import {
  Agent,
  defineSchema,
  tool,
  type LanguageModel,
} from "@open-agent/sdk";

declare const model: LanguageModel;

const weather = tool({
  name: "weather",
  description: "Get the weather for a city",
  inputSchema: defineSchema({
    jsonSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
    parse(value) {
      if (typeof value !== "object" || value === null || !("city" in value)) {
        throw new Error("Expected an object with city");
      }
      const city = value.city;
      if (typeof city !== "string") throw new Error("city must be a string");
      return { city };
    },
  }),
  async execute({ city }, { abortSignal }) {
    const response = await fetch(`https://example.com/weather?city=${encodeURIComponent(city)}`, {
      signal: abortSignal,
    });
    return response.json();
  },
});

const agent = new Agent({
  model,
  instructions: "You are a concise weather assistant.",
  tools: { weather },
  maxSteps: 5,
});

const result = await agent.run({ prompt: "What is the weather in Delhi?" });
console.log(result.text);
```

## Streaming

```ts
const stream = agent.stream({ prompt: "Explain the forecast" });

for await (const delta of stream.textStream) {
  await Bun.write(Bun.stdout, delta);
}

const finalResult = await stream.result;
```

When a provider implements `LanguageModel.stream`, events are forwarded as they arrive. Providers without native streaming fall back to complete-step events without pretending buffered output is token streaming.

## Safety And Type Guarantees

- Model and tool boundaries accept `unknown`, never `any`.
- Tool inputs are validated at runtime before typed execution.
- Prompt input is an exclusive union: provide `prompt` or `messages`, never both.
- Tool loops are bounded with `maxSteps`.
- Abort signals flow through model and tool calls.
- Public failures use stable error codes through `AgentSdkError` and `ToolError`.
- The source contains no type assertions or unchecked JSON casts.

## Commands

```bash
bun test
bun run typecheck
bun run build
```

## Provider Contract

Implement `LanguageModel.generate` and optionally `LanguageModel.stream`. The core owns orchestration; adapters own authentication, wire-format validation, provider error normalization, and SSE decoding. Keeping that boundary narrow prevents vendor types and credentials from leaking into agents.

## License

MIT
