# Production Readiness Plan

## Objective

Evolve `@deepaksankhyan91/open-agent-sdk` into a production-grade, provider-neutral TypeScript AI SDK with reliability and developer experience comparable to mature systems such as the Vercel AI SDK.

The initial production milestone will focus on:

- Core text generation, streaming, tools, and agent orchestration.
- First-party OpenAI and Anthropic provider adapters.
- Correctness, security, observability, and release engineering.
- Clean API improvements, including breaking changes where justified before `1.0.0`.

Full feature parity with larger AI platforms is not part of the first milestone. Embeddings, image generation, speech, UI integrations, persistence, and advanced workflows can be developed after the core is stable.

## Current Capabilities

The SDK already provides a useful foundation:

- Provider-neutral `LanguageModel` interface.
- `generateText()` and `streamText()` APIs.
- Typed tools with runtime input validation.
- Bounded multi-step tool execution.
- Basic retries and cancellation.
- Token usage aggregation.
- Stable base SDK and tool errors.
- Reusable `Agent` API.
- Fluent `Agent.builder()` API.
- Strict TypeScript configuration.
- Bun-based testing and build tooling.

These features are suitable for prototyping, but the SDK should not be described as production-ready until the release blockers in this plan are resolved.

## Release Blockers

### Streaming Memory Safety

The current `ReadableStream.tee()` design can buffer data indefinitely when a consumer reads only `textStream` or only `fullStream`.

Required changes:

- Replace the dual-stream `tee()` implementation with a bounded design.
- Define one canonical stream protocol.
- Preserve backpressure.
- Propagate consumer cancellation to the provider and active tools.
- Cancel and release provider readers in `finally` blocks.
- Define consistent stream error semantics.
- Preserve partial output, steps, and usage when a stream fails.

### Provider Method Binding

Provider methods must be invoked on their model instance. Extracting `model.stream` and calling it as a standalone function can lose its `this` binding and break class-based adapters.

### Cancellation and Timeouts

Cancellation must work consistently:

- Before a request starts.
- During retry backoff.
- While reading a provider stream.
- During tool execution.
- When a stream consumer stops reading.
- While waiting for the first stream chunk.
- Between stream chunks.

The SDK should support request, first-chunk, per-chunk, and tool timeouts. All timeout and abort failures must use stable SDK error types.

### Retry Classification

The SDK must not retry every provider failure.

Retry only transient failures such as:

- Rate limits when the request is safe to retry.
- Provider overload.
- Temporary server failures.
- Retriable network interruptions.
- Retriable timeouts.

Do not retry authentication failures, invalid requests, unsupported features, or content-policy failures.

The retry policy should support:

- Maximum retry count.
- Capped exponential backoff.
- Jitter.
- `Retry-After` headers.
- An `onRetry` lifecycle callback.
- An upper bound on delays and attempts.
- No automatic replay after stream output has become externally visible.

### Runtime Boundary Validation

TypeScript types do not protect JavaScript consumers or the SDK from malformed adapters. Validate:

- Exactly one of `prompt` or `messages` is provided.
- Numeric generation options are finite and within supported ranges.
- Provider responses contain valid content, tool calls, usage, and finish reasons.
- Provider stream events follow the documented state machine.
- Stream completion occurs exactly once.
- Usage values are finite and non-negative.
- Tool registries have consistent keys and declared names.

### Package Publication

A clean checkout must produce a complete package without manual preparation.

Required changes:

- Add a `prepack` build and verification step.
- Test the packed tarball in an isolated consumer project.
- Verify runtime and declaration exports.
- Pin stable compiler and runtime type dependencies.
- Add complete package metadata.
- Add CI release gates and provenance.

## Target Package Architecture

Use independently versioned packages with a narrow core boundary:

```text
packages/
|-- core/          # Generation, streaming, tools, agents, and shared contracts
|-- openai/        # OpenAI request, response, SSE, and error normalization
|-- anthropic/     # Anthropic request, response, SSE, and error normalization
|-- test/          # Mock models, deterministic streams, and contract suites
`-- telemetry/     # Optional OpenTelemetry integration
```

Provider packages own:

- Authentication and credentials.
- HTTP request construction.
- Provider-specific options.
- SSE and response parsing.
- Provider error normalization.
- Finish reason and usage normalization.
- Request IDs, response metadata, and warnings.

The core package must not read provider environment variables or depend on vendor SDK types.

## Core API Direction

Object configuration should remain the canonical API because it scales well and preserves type inference:

```ts
const agent = new ToolLoopAgent({
  model,
  instructions: "You are a helpful assistant.",
  tools: { weather },
  stopWhen: isStepCount(5),
});
```

The fluent builder can remain as a convenience wrapper over the same configuration model:

```ts
const agent = Agent.builder(model)
  .setInstructions("You are a helpful assistant.")
  .tool(weather)
  .build();
```

The builder must not maintain a separate execution implementation. Both construction styles must produce the same validated agent settings.

## Message and Stream Protocol

### Multipart Messages

Replace string-only message content with typed content parts:

- Text.
- Image.
- Audio.
- File or document.
- Reasoning.
- Tool call.
- Tool result.
- Source or citation.
- Refusal.
- Provider metadata.

Example:

```ts
const message = {
  role: "user",
  content: [
    { type: "text", text: "Explain this image" },
    { type: "image", data: image },
  ],
};
```

### Stream State Machine

Use explicit start, delta, and end events:

```ts
{ type: "text-start", id: "text-1" }
{ type: "text-delta", id: "text-1", delta: "Hello" }
{ type: "text-end", id: "text-1" }
{ type: "tool-input-start", id: "call-1", toolName: "weather" }
{ type: "tool-input-delta", id: "call-1", delta: "..." }
{ type: "tool-call", id: "call-1", toolName: "weather", input: {} }
{ type: "finish", finishReason: "stop", usage: {} }
```

The core must reject malformed ordering, duplicate terminal events, events after completion, and streams that end without a terminal event.

## Structured Output

Add schema-backed structured generation:

- Object generation.
- Array generation.
- Enum generation.
- JSON generation.
- Provider-native structured output negotiation.
- Runtime result validation.
- Partial structured output streaming.
- Output repair callbacks.
- Stable validation errors.

Example:

```ts
const result = await generateObject({
  model,
  schema: userSchema,
  prompt: "Generate a user profile",
});
```

Agents should also support a final structured output schema.

## Tool System

### Tool Contracts

Extend tools with:

- Input schema validation.
- Output schema validation.
- Per-tool timeout.
- Optional retry policy.
- Execution context and run metadata.
- Idempotency keys.
- Maximum output size.
- Dynamic availability.
- Lifecycle callbacks.
- Explicit side-effect classification.

### Execution Policies

Support:

- Sequential execution.
- Parallel execution.
- Configurable concurrency limits.
- Fail-fast or settle-all behavior.
- Tool errors returned to the model when configured.
- Partial result preservation.
- Duplicate tool name rejection.
- Safe own-property tool lookup.

### Human Approval

Destructive or sensitive tools must support approval before execution.

Approval outcomes:

- `approved`.
- `denied`.
- `user-approval`.
- `not-applicable`.

Security controls should include:

- Per-run tool allowlists and denylists.
- Filesystem scope.
- Network destination policy.
- Shell command policy.
- Sensitive data redaction.
- Tool output size limits.
- Audit events.

## Agent Orchestration

Add composable loop controls instead of relying only on `maxSteps`:

```ts
stopWhen: [
  isStepCount(10),
  hasToolCall("finalAnswer"),
  tokenBudgetExceeded(20_000),
]
```

Agent configuration should support:

- `stopWhen` conditions.
- `prepareStep` for per-step settings.
- `activeTools`.
- `toolChoice`.
- `repairToolCall`.
- Token and cost budgets.
- Per-step model selection.
- Context pruning and summarization.
- Resumable approval and tool-result flows.
- Persistent run identifiers.

Lifecycle callbacks:

- `onStart`.
- `onStepStart`.
- `onToolExecutionStart`.
- `onToolExecutionEnd`.
- `onStepEnd`.
- `onFinish`.
- `onError`.
- `onRetry`.

Callback failures must not be misclassified as provider failures.

## Error Architecture

Introduce dedicated error classes:

- `AuthenticationError`.
- `RateLimitError`.
- `InvalidRequestError`.
- `ModelResponseError`.
- `StreamProtocolError`.
- `NetworkError`.
- `TimeoutError`.
- `AbortError`.
- `UnsupportedFeatureError`.
- `ToolInputError`.
- `ToolExecutionError`.
- `ToolApprovalRequiredError`.
- `OutputValidationError`.

Errors should expose safe, structured metadata:

```ts
{
  code,
  provider,
  modelId,
  requestId,
  statusCode,
  retryable,
  retryAfter,
  safeMessage,
  cause,
}
```

Requirements:

- Serializable `toJSON()` output.
- Cross-package-safe error identification.
- Sanitized public messages.
- Redacted credentials and headers.
- Partial result and usage metadata where applicable.
- Stable error codes across minor releases.

## Middleware

Support provider-neutral model wrapping:

```ts
const model = wrapLanguageModel({
  model: openai("model-id"),
  middleware: [
    loggingMiddleware(),
    cacheMiddleware(),
    retryMiddleware(),
  ],
});
```

Initial middleware capabilities:

- Logging with redaction.
- Caching.
- Default model settings.
- Rate limiting.
- Request and response transformation.
- Prompt sanitization.
- JSON cleanup.
- Reasoning extraction.
- Stream simulation for non-streaming models.
- Cost and token limits.
- Safety and moderation hooks.
- Fallback model routing.

Middleware must have consistent semantics for generation and streaming.

## Observability

Provide optional OpenTelemetry integration with GenAI semantic conventions.

Capture:

- Root agent span.
- Model step spans.
- Tool execution spans.
- Retry events.
- Provider, model, and request IDs.
- Input and output token usage.
- Cached and reasoning tokens where available.
- Time to first chunk.
- Total duration.
- Per-chunk timing.
- Tool execution duration.
- Finish reasons.
- Estimated cost.
- Normalized error category.

Privacy controls must allow applications to disable recording prompts, responses, headers, runtime context, and tool data.

```ts
telemetry: {
  enabled: true,
  recordInputs: false,
  recordOutputs: false,
}
```

Sensitive content must be excluded by default.

## Context Management

Long-running agents require:

- Context-window estimation.
- Token-based message pruning.
- Conversation summarization hooks.
- Tool-output compaction.
- Maximum history limits.
- Cached token accounting.
- Context overflow errors.
- Application-controlled retention policies.

## Test Strategy

Create a dedicated testing package with deterministic utilities:

```ts
import {
  MockLanguageModel,
  simulateReadableStream,
  mockId,
} from "@open-agent/test";
```

### Required Test Categories

- Unit tests for every public API.
- Provider contract tests shared by OpenAI and Anthropic.
- Integration tests against provider-compatible fixtures.
- Type-level API tests.
- Packed-package import tests.
- Stream state-machine tests.
- Cancellation tests at every execution stage.
- Retry classification and backoff tests.
- Tool timeout, concurrency, and approval tests.
- Malformed provider response tests.
- Property and fuzz tests for stream event sequences.
- Long-stream memory regression tests.
- Performance benchmarks.

Required streaming scenarios:

- Provider methods that depend on `this`.
- Setup and read failures.
- Missing or duplicate finish events.
- Events after completion.
- Consumer cancellation.
- Backpressure.
- Delayed first and subsequent chunks.
- Multiple tool-loop steps.
- Callback failures.
- Partial output and usage on failure.

CI should enforce an agreed coverage threshold without using coverage as a substitute for behavioral tests.

## Security Requirements

- Never read provider credentials in the core package.
- Never log authorization headers by default.
- Redact secrets from public errors and telemetry.
- Require approval support for destructive tools.
- Add per-tool timeout and resource controls.
- Restrict tool output size.
- Provide prompt-injection and data-egress policy hooks.
- Maintain dependency and supply-chain scanning.
- Publish a `SECURITY.md` vulnerability reporting policy.
- Generate signed or provenance-backed release artifacts.

## Release Engineering

Add the following project files and metadata:

- `LICENSE`.
- `SECURITY.md`.
- `CONTRIBUTING.md`.
- Changelog.
- Repository, homepage, bugs, author, and keywords metadata.
- `packageManager` and `publishConfig` configuration.
- Supported Bun and TypeScript version policy.

Release pipeline:

```text
install
  -> format/lint
  -> typecheck
  -> unit tests
  -> provider contract tests
  -> build
  -> pack
  -> isolated install
  -> runtime/type smoke tests
  -> provenance-enabled publish
```

The release process should support semantic versioning, prerelease channels, generated release notes, API compatibility checks, and protected publishing credentials.

## Implementation Roadmap

### Phase 1: Correctness and Streaming

Deliverables:

- Shared option validation.
- New bounded streaming architecture.
- Preserved provider method binding.
- End-to-end cancellation.
- Request and stream timeouts.
- Stream state-machine validation.
- Retry classification and backoff policy.
- Stable abort, timeout, network, and protocol errors.
- Correct step numbering and event ordering.
- Partial output, steps, and usage on failure.

Exit criteria:

- No unbounded stream buffering.
- Consumer cancellation stops provider and tool work.
- Native and fallback streams have identical documented semantics.
- Invalid stream sequences fail deterministically.
- Retry and abort tests pass for every execution stage.

### Phase 2: Provider Contracts and Adapters

Deliverables:

- Versioned provider protocol.
- Rich message and content-part model.
- OpenAI adapter.
- Anthropic adapter.
- Shared provider contract suite.
- Provider options, metadata, warnings, and request IDs.
- Normalized provider errors and usage.

Exit criteria:

- Both adapters pass the same contract suite.
- Core source imports no vendor types.
- Generate, stream, tools, cancellation, usage, and errors work consistently across both providers.

### Phase 3: Tools and Agents

Deliverables:

- Tool input and output validation.
- Approval flows.
- Timeouts and concurrency policies.
- Safe tool registry normalization.
- Stop conditions.
- Step preparation and active tools.
- Lifecycle callbacks.
- Token and cost budgets.
- Context management hooks.

Exit criteria:

- Sensitive tools can require resumable approval.
- Tool failures preserve completed work and usage.
- Duplicate and malformed tool registrations are rejected.
- Agent loops terminate predictably under all configured limits.

### Phase 4: Structured Output

Deliverables:

- `generateObject()`.
- Object, array, enum, and JSON modes.
- Partial structured output streaming.
- Provider-native structured output support.
- Schema validation and repair callbacks.
- Structured agent final output.

Exit criteria:

- Invalid model output never reaches consumers as valid typed data.
- OpenAI and Anthropic structured output behavior passes shared tests.

### Phase 5: Middleware and Telemetry

Deliverables:

- Language model middleware contract.
- Logging, defaults, cache, and retry middleware.
- OpenTelemetry integration.
- GenAI semantic attributes.
- Redaction and privacy controls.
- Timing, token, cost, retry, and tool metrics.

Exit criteria:

- Middleware works consistently for generate and stream paths.
- Telemetry can be fully disabled.
- Sensitive inputs and outputs are not recorded by default.

### Phase 6: Release and Ecosystem Readiness

Deliverables:

- CI/CD pipeline.
- Package tarball smoke tests.
- Complete package and legal metadata.
- Security and contribution policies.
- Coverage, fuzzing, and performance gates.
- Semantic release workflow.
- Provenance-enabled publishing.
- Migration guide for pre-1.0 breaking changes.

Exit criteria:

- A clean checkout can produce and verify every package.
- Published packages can be imported by an isolated Bun/TypeScript consumer.
- Release artifacts include declarations and correct export maps.
- All production gates pass without manual intervention.

## Post-Core Roadmap

After the core production milestone:

- Embeddings and batch embeddings.
- Reranking.
- Image generation and editing.
- Speech synthesis and transcription.
- Moderation.
- Batch APIs.
- UI message protocol and framework integrations.
- Persistence and memory adapters.
- Agent handoffs and subagents.
- Workflow and graph orchestration.
- MCP integration.
- Evaluation, recording, and deterministic replay.

These capabilities should be separate packages where possible so the core remains small and stable.

## Production Definition

The SDK can be described as production-ready only when:

- Streaming uses bounded memory and honors backpressure.
- Cancellation propagates through providers, streams, retries, and tools.
- Retries occur only for classified transient failures.
- Provider responses and streams are runtime validated.
- Errors are stable, sanitized, serializable, and actionable.
- Sensitive tools support approval and policy enforcement.
- OpenAI and Anthropic pass the same provider contract suite.
- Telemetry is privacy-aware and optional.
- Partial results and usage are preserved on failure.
- A clean checkout can build, pack, install, and test all packages.
- CI enforces correctness, package integrity, security, and compatibility gates.

Phase 1 must be completed before expanding the feature surface. Building additional capabilities on the current streaming, cancellation, and retry behavior would create avoidable technical debt.
