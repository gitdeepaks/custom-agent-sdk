# Open Agent SDK

[![npm prerelease](https://img.shields.io/npm/v/@deepaksankhyan91/open-agent-sdk/next?label=npm%20next)](https://www.npmjs.com/package/@deepaksankhyan91/open-agent-sdk)
[![CI](https://github.com/gitdeepaks/custom-agent-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/gitdeepaks/custom-agent-sdk/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A provider-neutral, type-safe agent SDK for TypeScript, designed around the ergonomic core of the Vercel AI SDK while keeping providers and application concerns separate.

## Status

The SDK is published on npm as [`@deepaksankhyan91/open-agent-sdk`](https://www.npmjs.com/package/@deepaksankhyan91/open-agent-sdk). It is currently released through the `next` prerelease channel.

This repository includes a provider-neutral core plus first-party OpenAI Responses API and Anthropic Messages API adapters. It supports text and structured generation, multipart messages, native streaming, runtime-validated tools, bounded tool loops, retries, cancellation, normalized provider errors and usage, and a reusable `Agent` API.

## Requirements

- Bun 1.2 or newer
- TypeScript 7

## Install

```bash
bun add @deepaksankhyan91/open-agent-sdk@next
```

The package can also be installed with npm:

```bash
npm install @deepaksankhyan91/open-agent-sdk@next
```

Public entry points:

- `@deepaksankhyan91/open-agent-sdk` for core generation, tools, agents, middleware, and telemetry.
- `@deepaksankhyan91/open-agent-sdk/openai` for the OpenAI Responses API adapter.
- `@deepaksankhyan91/open-agent-sdk/anthropic` for the Anthropic Messages API adapter.

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

The core `@deepaksankhyan91/open-agent-sdk` package does not read these variables. Credentials belong to the application or provider package that constructs the `LanguageModel`. Do not use `OPENAI_API_KEY || ANTHROPIC_API_KEY`; select a provider explicitly and validate its corresponding key. Never commit `.env` or real credentials. The repository ignores `.env` while retaining `.env.example` as documentation.

## Quick Start

Create a provider explicitly and pass its protocol-v1 model to the core:

```ts
import { Agent, defineSchema, tool } from "@deepaksankhyan91/open-agent-sdk";
import { createOpenAI } from "@deepaksankhyan91/open-agent-sdk/openai";

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
    const response = await fetch(
      `https://example.com/weather?city=${encodeURIComponent(city)}`,
      {
        signal: abortSignal,
      },
    );
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

## Structured Output

`generateObject()` supports object, array, enum, and arbitrary JSON modes. OpenAI and Anthropic receive native structured-output constraints, and the core validates every final value before returning typed data:

```ts
const profile = await generateObject({
  model,
  prompt: "Generate a user profile",
  schema: profileSchema,
});

console.log(profile.object);
```

Use `mode: "array"` with an element schema, `mode: "enum"` with a literal `values` list, or `mode: "json"` for any `JsonValue`. An optional `repair` callback runs at most once after validation fails, and its result is fully revalidated.

`streamObject()` exposes demand-driven JSON snapshots through `partialObjectStream`. These snapshots are typed as `JsonValue` because incomplete data has not passed the final schema. Only `(await stream.result).object` is returned as the schema-inferred type. `Agent.runObject()` and `Agent.streamObject()` provide the same behavior with agent settings and tool loops.

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

## Tool And Agent Policies

Tools can validate outputs, require approval, and override the default timeout:

```ts
const removeFile = tool({
  name: "removeFile",
  description: "Remove a file within the configured workspace",
  inputSchema: pathSchema,
  outputSchema: resultSchema,
  needsApproval: true,
  timeoutMs: 10_000,
  async execute(input, { abortSignal, runId, idempotencyKey }) {
    return removeWorkspaceFile(input, { abortSignal, runId, idempotencyKey });
  },
});

const result = await generateText({
  model,
  prompt: "Remove the obsolete build output",
  tools: { removeFile },
  maxSteps: 5,
  toolExecution: {
    mode: "parallel",
    maxConcurrency: 4,
    errorMode: "fail-fast",
  },
  requestToolApproval: async (request) =>
    approvalQueue.waitForDecision(request),
});
```

Approval handlers return `approved`, `denied`, `user-approval`, or `not-applicable`. The SDK awaits the decision without replaying prior work. If no handler resolves a required approval, generation fails with `ToolApprovalRequiredError` before the sensitive tool executes.

Agent loops support composable stop conditions, per-step preparation, token and cost budgets, context preparation, and lifecycle callbacks:

```ts
const result = await generateText({
  model,
  prompt: "Investigate and summarize",
  tools: { search, finalAnswer },
  maxSteps: 10,
  stopWhen: [hasToolCall("finalAnswer"), tokenBudgetExceeded(20_000)],
  prepareStep: ({ stepNumber }) => ({
    activeTools: stepNumber === 1 ? ["search"] : ["search", "finalAnswer"],
  }),
  budget: { tokens: { maxTotalTokens: 20_000 } },
  contextManager: {
    prepareMessages: ({ messages }) => pruneForModelContext(messages),
  },
  callbacks: {
    onToolExecutionEnd: ({ toolCall, outcome }) => {
      auditToolOutcome(toolCall.toolCallId, outcome);
    },
  },
});
```

`prepareMessages` changes only the provider request view; canonical run history remains intact. Tool execution defaults to bounded parallelism with four workers. Results retain model call order, and completed sibling outputs are included in partial error metadata when another tool fails.

## Middleware And Telemetry

Wrap any protocol-v1 model with provider-neutral middleware. The first item is outermost, request defaults never overwrite explicit values, cache keys hash all request settings including headers, and stream middleware remains pull-based:

```ts
const productionModel = wrapLanguageModel({
  model,
  middleware: [
    loggingMiddleware({ logger }),
    defaultSettingsMiddleware({ temperature: 0.2 }),
    cacheMiddleware({ cache: new MemoryLanguageModelCache(), ttlMs: 60_000 }),
    retryMiddleware({ maxRetries: 2 }),
  ],
});
```

`loggingMiddleware` excludes prompts and responses by default. Set `recordInputs` or `recordOutputs` only when the application has an appropriate retention policy, and provide `redact` before recording sensitive content. Cache entries contain complete model responses independently of logging and telemetry privacy settings; production applications should provide a tenant-scoped, encrypted `LanguageModelCache` when responses are sensitive.

OpenTelemetry instrumentation is opt-in on generation calls or `AgentSettings`:

```ts
const result = await generateText({
  model: productionModel,
  prompt: "Summarize the incident",
  telemetry: {
    enabled: true,
    recordInputs: false,
    recordOutputs: false,
  },
});
```

When omitted or configured with `enabled: false`, telemetry does not obtain a tracer or meter and adds no stream wrappers. Enabled telemetry records GenAI model spans and token metrics plus run, retry, first-chunk, chunk-interval, tool-duration, and configured cost-budget metrics. Prompts, model outputs, tool data, headers, provider options, and runtime context are not recorded by default. Headers are never recorded.

## Safety And Type Guarantees

- Model and tool boundaries accept `unknown`, never `any`.
- Tool inputs are validated at runtime before typed execution.
- Configured tool output schemas are validated before results reach a model.
- Tool registries are snapshotted, own-property-safe, and reject malformed or duplicate registrations.
- Sensitive tools support awaited approval decisions and deterministic idempotency keys.
- Parallel tool execution is bounded and can return failures to the model when configured.
- Stop conditions and token/cost budgets prevent starting unusable tool or model work.
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
bun run verify:package
```

Contributor setup and release requirements are documented in
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Provider Contract

`LanguageModel` uses the versioned `v1` provider protocol. The core owns orchestration and runtime boundary validation; adapters own authentication, wire-format validation, provider error normalization, and SSE decoding. Keeping that boundary narrow prevents vendor types and credentials from leaking into agents.

Provider adapters implement `Provider` and create models through `languageModel(modelId, settings?)`. Each provider owns its API key, endpoint, request validation, and typed model settings. The core intentionally never reads `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.

```ts
import { createAnthropic } from "@deepaksankhyan91/open-agent-sdk/anthropic";

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
│   ├── middleware/middleware.ts # Model middleware and built-ins
│   ├── model/types.ts          # Provider protocol and messages
│   ├── provider/provider.ts    # Provider factory contract
│   ├── telemetry/telemetry.ts   # OpenTelemetry GenAI instrumentation
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
