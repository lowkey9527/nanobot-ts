# nanobot-ts

TypeScript rewrite of the Python `nanobot` personal AI assistant runtime.

This repository is being rebuilt from the sibling Python implementation with two goals:

- Preserve user-facing runtime behavior where practical.
- Make future providers, channels, tools, templates, and skills easier to extend through typed TypeScript modules.

## Status

This project is under active rewrite. The current implementation includes:

- TypeScript project foundation and npm packaging.
- Config schema/defaults, config loading/saving, env overrides, and path helpers.
- Bundled workspace templates copied from the Python implementation.
- Non-overwriting workspace template synchronization.
- Node built-in test coverage for foundation, config, paths, and templates.

Provider runtime, agent loop, tools, channels, gateway, and full CLI behavior are planned in later tasks.

## Requirements

- Node.js 20+
- npm

## Development

Install dependencies:

```bash
npm install
```

Run the full verification suite:

```bash
npm run verify
```

Individual commands:

```bash
npm run typecheck
npm run build
npm run test
```

## CLI

The package exposes a `nanobot` binary after build:

```bash
npm run build
node dist/src/cli/main.js --version
```

The current CLI entry is a foundation placeholder. Full commands such as onboarding, agent execution, gateway startup, provider login, and channel status are scheduled for later rewrite tasks.

## Project Layout

```text
src/
  cli/          CLI entry surface
  config/       Config schema, loader, and path helpers
  internal/     Internal package metadata
  templates/    Workspace template sync
templates/      Bundled workspace templates
tests/          Node built-in test suites
openspec/       OpenSpec change artifacts
docs/           Parity notes, design docs, plans, and rationale logs
```

## Implementation Notes

- The Python project remains the behavior oracle during the rewrite.
- Every completed OpenSpec task records implementation rationale in `docs/superpowers/implementation-rationale/rewrite-nanobot-typescript.md`.
- Runtime dependencies are intentionally kept minimal until a task requires them.
- Workspace template sync treats bundled package templates as authoritative and never overwrites user-owned files.
