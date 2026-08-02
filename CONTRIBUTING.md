# Contributing

## Requirements

- Bun 1.2 or newer
- TypeScript 7

## Setup

```bash
bun install --frozen-lockfile
bun run check
bun run build
bun run verify:package
```

Live provider tests are optional and require the corresponding credentials:

```bash
bun run test:live
```

Never commit `.env` files or provider credentials.

## Pull Requests

- Keep changes focused and include behavioral tests for public API changes.
- Use Conventional Commit subjects such as `feat:`, `fix:`, `docs:`, or
  `chore:`. Release Please uses these commits to calculate versions and release
  notes.
- Update documentation for public behavior changes.
- Describe breaking changes and migration steps explicitly.
- Ensure `bun run check` and `bun run verify:package` pass.

By contributing, you agree that your contribution is licensed under the MIT
License included in this repository.
