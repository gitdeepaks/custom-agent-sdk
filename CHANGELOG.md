# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release Please maintains this file after the initial release setup.

## [0.3.0-next.0](https://github.com/gitdeepaks/custom-agent-sdk/compare/open-agent-sdk-v0.2.1-next.0...open-agent-sdk-v0.3.0-next.0) (2026-08-02)


### Features

* add fluent agent builder API ([845d4a2](https://github.com/gitdeepaks/custom-agent-sdk/commit/845d4a2060138a9edbd67dba33733c3508eec053))
* establish production-grade agent SDK core ([2a50094](https://github.com/gitdeepaks/custom-agent-sdk/commit/2a50094edcff45e8115973be8b6609fbf812c61c))
* **observability:** add middleware and telemetry ([dbaf97a](https://github.com/gitdeepaks/custom-agent-sdk/commit/dbaf97aa9327a8c8213e8d321b6baae5d723af36))
* **phase-2:** versioned provider protocol v1 with OpenAI and Anthropic adapters ([d7f732b](https://github.com/gitdeepaks/custom-agent-sdk/commit/d7f732baf953e3c479a422d649b262639bdcae8b))
* **phase-3:** add production tool and agent policies ([03687ba](https://github.com/gitdeepaks/custom-agent-sdk/commit/03687babb3c71dcba2c1a0600093e6b072c4bc59))
* production-grade resiliency, validation, and stream protocol ([dcf3222](https://github.com/gitdeepaks/custom-agent-sdk/commit/dcf32224d63a718702d1f48718fc636939dd5c01))
* **release:** publish SDK and add production pipeline ([4c91dfd](https://github.com/gitdeepaks/custom-agent-sdk/commit/4c91dfd507defe562cb9bf9c8b6c0de3136ac4dd))
* **structured-output:** add generateObject and streamObject APIs ([8d87a32](https://github.com/gitdeepaks/custom-agent-sdk/commit/8d87a325970949f173d5dfe2d31c7a4cc5522964))

## [Unreleased]

## [0.2.1-next.0] - 2026-08-02

### Added

- Deterministic package builds and isolated tarball consumer verification.
- CI, coverage, stream fuzzing, memory, performance, and security gates.
- Release Please automation and provenance-enabled npm publishing.
- Complete package, security, contribution, and migration metadata.

## [0.2.0] - 2026-08-02

### Added

- Provider-neutral text and structured generation APIs.
- Bounded streaming with cancellation, timeout, and protocol validation.
- OpenAI Responses API and Anthropic Messages API adapters.
- Runtime-validated tools, approval flows, bounded agent loops, and budgets.
- Language model middleware and opt-in OpenTelemetry instrumentation.

[Unreleased]: https://github.com/gitdeepaks/custom-agent-sdk/compare/v0.2.1-next.0...HEAD
[0.2.1-next.0]: https://github.com/gitdeepaks/custom-agent-sdk/compare/v0.2.0...v0.2.1-next.0
[0.2.0]: https://github.com/gitdeepaks/custom-agent-sdk/releases/tag/v0.2.0
