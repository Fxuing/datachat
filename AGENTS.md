# Notes for coding agents

DataChat turns natural-language questions into read-only SQL over MySQL / PostgreSQL. Fastify + SQLite (metadata) + Pi Agent on the server; React 19 + Vite on the web.

## Subsystem design and review

Before changing a documented subsystem, read its reference in
[docs/subsystems/README.md](docs/subsystems/README.md) and verify the linked source.

When a change alters a responsibility, interface, state transition, runtime path,
compatibility rule, or failure behavior, update the owning reference in the same
commit. Describe the observable before/after behavior, not only the files changed.

## Code standards

Write and review changes against [docs/code-standards.md](docs/code-standards.md).

## Lessons

Before changing code, read [LESSONS.md](LESSONS.md): regressions and near-misses in
this repo, and the rule that would have caught them.

## High-risk paths

These are the places where a plausible-looking change is most likely to be wrong:

- **SQL safety.** Never execute model-authored SQL outside `runGuardedQuery` /
  `guardSql` / `executeReadOnly`. No direct `pool.query`, no raw datasource access,
  no bypass for "simple" queries. See [SQL and artifacts](docs/subsystems/sql-artifacts.md).
- **Permissions.** Re-resolve access from the database; never trust a user id,
  datasource id, role, or permission from the request body. Resource queries are
  scoped by `userId`; agent tools re-check grants at execution time. See
  [Auth and permissions](docs/subsystems/auth-permissions.md).
- **Metadata vs data.** SQLite stores metadata; full query rows live in artifact
  files. Do not put full result sets in SQLite, run events, prompts, or the browser
  bundle. See [SQL and artifacts](docs/subsystems/sql-artifacts.md).
- **Run events.** Live SSE uses `RunEventBus`; replay uses persisted `run_events`.
  A new event type changes the shared union, the bridge, persistence, replay, and
  the web consumer. `run_end` must always be terminal. See
  [Chat runtime](docs/subsystems/chat-runtime.md).
- **Prompt and skills.** `[[artifact:]]`, `[[chart:]]`, `[[result:]]`, and Mermaid
  fences are parsed in more than one place. `seedSkills` does not update an
  existing skill by name. See [Chat UI](docs/subsystems/chat-ui.md) and
  [Lessons](LESSONS.md).
- **Secrets.** Datasource passwords and provider API keys are encrypted at rest;
  never put them in prompts, logs, errors, URLs, shares, or the frontend. Public
  shares are read-only projections of owner-scoped data, not a new auth path. See
  [Auth and permissions](docs/subsystems/auth-permissions.md).
- **Migrations.** Append a new migration; never edit an applied one. Update
  `apps/server/test/db.test.ts` (`APP_TABLES`, `INTEGRITY_INDEXES`) with schema
  changes. See [Code standards](docs/code-standards.md#migrations).

## Verification

`pnpm verify` is the default gate. It runs lint, typecheck, server/shared tests,
web tests, and builds. The root `pnpm test` does **not** include web tests.

Targeted commands live in each subsystem reference. If a step was not run, say so.
