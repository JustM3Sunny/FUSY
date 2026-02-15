# Architecture

## Components

- `apps/cli`: command entrypoint and workflows.
- `packages/core`: routing, workflow state machine, context indexing/retrieval.
- `packages/providers`: Gemini/Groq adapters and error normalization.
- `packages/tools`: policy-gated shell/filesystem/git tooling.
- `packages/memory`: sqlite-backed session and memory store.
- `packages/telemetry`: structured logging and trace export.

## Runtime flow

1. CLI parses command and creates a request ID for logging.
2. Core indexes repo and packs context for pair sessions.
3. Router selects provider by budget/task and applies fallback policy.
4. Tools execute commands under policy controls.
5. Memory persists sessions and artifacts.
6. Telemetry emits logs and optional `.jsonl` debug trace.
