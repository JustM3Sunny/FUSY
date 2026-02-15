# FUSY

FUSY is a monorepo for an AI-assisted engineering CLI with provider routing, policy-gated tool execution, memory, and observability.

## Install

Requires Node.js 22+ (for built-in `node:sqlite` support).

```bash
corepack enable
pnpm install
pnpm build
```

## Configure

Copy `.env.example` and configure provider keys as needed:

- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `FUSY_LOG_FORMAT=json|pretty`
- `FUSY_MEMORY_KEY` (optional memory encryption key)

## Usage

```bash
pnpm --filter @fusy/cli dev --help
pnpm --filter @fusy/cli dev pair "refactor provider routing"
pnpm --filter @fusy/cli dev run "pnpm test"
pnpm --filter @fusy/cli dev sessions
pnpm --filter @fusy/cli dev memory list
```

Enable debug tracing export to `.fusy/trace.jsonl`:

```bash
pnpm --filter @fusy/cli dev run "pnpm lint" --trace true
```

## Testing

- Unit tests cover:
  - provider adapters (`packages/providers/src/index.test.ts`)
  - router logic (`packages/core/src/index.test.ts`)
  - policy engine and diff application (`packages/tools/src/index.test.ts`)
- Integration tests cover CLI flows with mocked/local command execution (`apps/cli/src/index.test.ts`).
- Cross-platform smoke tests run in CI (`.github/workflows/ci.yml`).

## Observability

- Structured logs in JSON or pretty mode via `@fusy/telemetry` logger.
- Request IDs attached to log records.
- Token/cost accounting via `logger.usage(...)` records.
- Debug trace export to `.jsonl` via `exportDebugTrace(...)`.

## Troubleshooting

- **`pnpm` bootstrap errors behind restricted network**: pre-install pnpm and dependencies in your environment/cache.
- **SQLite errors**: ensure Node.js >=22 with `node:sqlite` support.
- **Provider auth errors**: verify env keys and shell scope.

## Documentation

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)

## Release

- Semantic versioning: `MAJOR.MINOR.PATCH`.
- Changelog automation: Changesets (`.changeset/`).
- CLI binary packaging/distribution guidance: `docs/operations.md`.
