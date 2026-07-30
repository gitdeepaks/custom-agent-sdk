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

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | For OpenAI only | Authenticates requests made by an OpenAI provider adapter. |
| `ANTHROPIC_API_KEY` | For Anthropic only | Authenticates requests made by an Anthropic provider adapter. |
| `OPENAI_BASE_URL` | No | Overrides the OpenAI endpoint when supported by the adapter. |
| `ANTHROPIC_BASE_URL` | No | Overrides the Anthropic endpoint when supported by the adapter. |

The core `@open-agent/sdk` package does not read these variables. Credentials belong to the application or provider package that constructs the `LanguageModel`. Do not use `OPENAI_API_KEY || ANTHROPIC_API_KEY`; select a provider explicitly and validate its corresponding key. Never commit `.env` or real credentials. The repository ignores `.env` while retaining `.env.example` as documentation.

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

Provider packages implement `Provider` and create models through `languageModel(modelId)`. Each provider owns its API key, endpoint, request validation, and environment-variable policy. The core intentionally never reads `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

## Project Structure

```text
src/
├── index.ts                    # Stable public package entry point
└── core/
    ├── index.ts                # Core export boundary
    ├── agent/agent.ts          # Reusable Agent facade
    ├── errors/errors.ts        # Stable SDK and tool errors
    ├── generation/
    │   ├── generate-text.ts    # Generation and tool loop
    │   └── stream-text.ts      # Provider-native streaming
    ├── model/types.ts          # Provider protocol and messages
    ├── provider/provider.ts    # Provider factory contract
    └── tools/tool.ts           # Schemas and typed tools
test/
└── sdk.test.ts                 # Public behavior tests
```

Future OpenAI and Anthropic adapters should be separate packages, such as `@open-agent/openai` and `@open-agent/anthropic`, rather than importing credentials into `@open-agent/sdk`.

## License

MIT
