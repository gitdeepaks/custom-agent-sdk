# Open Agent SDK

A provider-neutral, type-safe agent SDK for TypeScript, designed around the ergonomic core of the Vercel AI SDK while keeping providers and application concerns separate.

## Status

This repository includes a provider-neutral core plus first-party OpenAI Responses API and Anthropic Messages API adapters. It supports text generation, multipart messages, native streaming, runtime-validated tools, bounded tool loops, retries, cancellation, normalized provider errors and usage, and a reusable `Agent` API.

## Requirements

- Bun 1.2 or newer
- TypeScript 7

## Install

```bash
bun install
```

## Environment Variables

Create a local environment file from the committed template:

```bash
cp .env.example .env
```

Bun automatically loads `.env`; no `dotenv` dependency is required. Set only the credentials needed by the provider adapter used by your application:

```env
# Used by an OpenAI adapter
OPENAI_API_KEY=sk-...

# Used by an Anthropic adapter
ANTHROPIC_API_KEY=sk-ant-...
```

| Variable             | Required           | Purpose                                                         |
| -------------------- | ------------------ | --------------------------------------------------------------- |
| `OPENAI_API_KEY`     | For OpenAI only    | Authenticates requests made by an OpenAI provider adapter.      |
| `ANTHROPIC_API_KEY`  | For Anthropic only | Authenticates requests made by an Anthropic provider adapter.   |
| `OPENAI_BASE_URL`    | No                 | Overrides the OpenAI endpoint when supported by the adapter.    |
| `ANTHROPIC_BASE_URL` | No                 | Overrides the Anthropic endpoint when supported by the adapter. |

The core `@open-agent/sdk` package does not read these variables. Credentials belong to the application or provider package that constructs the `LanguageModel`. Do not use `OPENAI_API_KEY || ANTHROPIC_API_KEY`; select a provider explicitly and validate its corresponding key. Never commit `.env` or real credentials. The repository ignores `.env` while retaining `.env.example` as documentation.

## Quick Start

Create a provider explicitly and pass its protocol-v1 model to the core:

```ts
import {
  Agent,
  defineSchema,
  tool,
} from "@open-agent/sdk";
import { createOpenAI } from "@open-agent/sdk/openai";

const apiKey = Bun.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required");

const model = createOpenAI({ apiKey }).languageModel("your-model-id");

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

The same agent can be created with the fluent builder API:

```ts
const agent = Agent.builder(model)
  .setInstructions("You are an expert weather agent.")
  .tool(weather)
  .build();
```

## Streaming

```ts
const stream = agent.stream({ prompt: "Explain the forecast" });

for await (const delta of stream.textStream) {
  await Bun.write(Bun.stdout, delta);
}

const finalResult = await stream.result;
```

`fullStream` is the canonical bounded event stream. `textStream` is a text-only view over the same session. They are intentionally alternative views: consume one, not both. This avoids `ReadableStream.tee()` buffering while preserving provider backpressure. Await `result` after consuming the selected stream.

Native and fallback models emit the same ordered SDK protocol:

```text
step-start -> text-start -> text-delta* -> text-end
           -> tool-call* -> finish -> step-finish
```

Malformed provider ordering, duplicate or missing finish events, and events after finish produce a `StreamProtocolError`. Cancelling either consumer aborts the provider request and active tools.

Retries and timeouts are configured consistently for generation and streaming:

```ts
const stream = streamText({
  model,
  prompt: "Explain the forecast",
  retry: {
    maxRetries: 2,
    initialDelayMs: 100,
    maxDelayMs: 5_000,
    onRetry: ({ attempt, error }) => console.warn(attempt, error.code),
  },
  timeouts: {
    requestMs: 60_000,
    firstChunkMs: 15_000,
    chunkMs: 15_000,
    toolMs: 30_000,
  },
});
```

Only classified transient failures are retried. Once provider output is externally visible, a stream is never replayed. Errors expose stable codes, retry metadata, serializable `toJSON()` output, and `partialResult` when generation has already produced text, usage, messages, or completed steps.

## Safety And Type Guarantees

- Model and tool boundaries accept `unknown`, never `any`.
- Tool inputs are validated at runtime before typed execution.
- Prompt input is an exclusive union: provide `prompt` or `messages`, never both.
- Tool loops are bounded with `maxSteps`.
- Abort signals flow through model and tool calls.
- Request, first-chunk, per-chunk, and tool timeouts use `TimeoutError`.
- Public failures use stable errors including `AbortError`, `NetworkError`, `StreamProtocolError`, and `ToolError`.
- Provider responses and stream events are runtime validated before use.
- Retries use capped exponential backoff, jitter, transient-failure classification, and `Retry-After` metadata.
- The source contains no type assertions or unchecked JSON casts.

## Commands

```bash
bun test
bun run typecheck
bun run build
```

## Provider Contract

`LanguageModel` uses the versioned `v1` provider protocol. The core owns orchestration and runtime boundary validation; adapters own authentication, wire-format validation, provider error normalization, and SSE decoding. Keeping that boundary narrow prevents vendor types and credentials from leaking into agents.

Provider adapters implement `Provider` and create models through `languageModel(modelId, settings?)`. Each provider owns its API key, endpoint, request validation, and typed model settings. The core intentionally never reads `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

```ts
import { createAnthropic } from "@open-agent/sdk/anthropic";

const apiKey = Bun.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

const model = createAnthropic({ apiKey }).languageModel("your-model-id");
```

## Project Structure

```text
src/
├── index.ts                    # Stable public package entry point
├── core/
│   ├── index.ts                # Core export boundary
│   ├── agent/agent.ts          # Reusable Agent facade
│   ├── errors/errors.ts        # Stable SDK and tool errors
│   ├── generation/
│   │   ├── generate-text.ts    # Generation and tool loop
│   │   └── stream-text.ts      # Provider-native streaming
│   ├── model/types.ts          # Provider protocol and messages
│   ├── provider/provider.ts    # Provider factory contract
│   └── tools/tool.ts           # Schemas and typed tools
└── providers/
    ├── openai/                 # OpenAI Responses API adapter
    └── anthropic/              # Anthropic Messages API adapter
test/
├── provider-contract.ts        # Shared adapter contract suite
└── phase2-providers.test.ts    # Provider wire fixtures
```

## License

MIT
