# Pre-1.0 Migration Guide

Minor releases may contain breaking changes until 1.0. Every breaking release
will document affected imports, behavior changes, and replacement APIs here and
in the changelog.

## Migrating To 0.2

- Import core APIs from `@deepaksankhyan91/open-agent-sdk`.
- Import provider factories from `@deepaksankhyan91/open-agent-sdk/openai` or
  `@deepaksankhyan91/open-agent-sdk/anthropic`.
- Provide exactly one of `prompt` or `messages` to generation APIs.
- Treat `fullStream` and `textStream` as alternative views of one bounded
  stream session. Consume one view, then await `result`.
- Provider adapters must implement protocol `v1` and emit one terminal
  `finish` event.
- Configure request, first-chunk, chunk, and tool timeouts through `timeouts`.
- Use `stopWhen` and explicit budgets for bounded agent execution.
