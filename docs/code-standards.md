# Code standards

These are review rules, not a tutorial. A reviewer checks each rule that applies;
a change that misses one gets a comment naming it. When a rule is broken by a real
bug, add the incident and the rule to [LESSONS.md](../LESSONS.md).

## What a change contains

| Rule | What a reviewer looks at |
| --- | --- |
| A change does only what its goal needs. | Unrelated refactors, extra features, formatting churn, and policy changes belong in a separate commit. |
| A fix covers every sibling. | Grep the parser, predicate, permission gate, or route name. Chat/report/share, HTTP/tool, and conversation/scheduled/memory paths are common siblings. |
| A change follows the whole path. | Follow input → route → service → repository/tool → artifact/event → UI. A correct function in the middle does not make the operation correct. |
| Failures fail closed. | Unreadable config, missing permission, unknown datasource, or failed parse is not “empty” or “allow all”. Return an error and preserve old data. |
| A change re-derives what depends on it. | When a limit, schema, event, or query key changes, update every caller, test, and stored assumption. |
| No secret reaches the client, prompt, log, URL, or share. | Check error paths and debug output too. |

## Server

- Route files (`apps/server/src/routes/`) validate input, declare
  `preHandler: app.requirePermission(...)`, and map domain errors to the shared
  `{ error: { code, message, details? } }` shape.
- A resource query includes `userId` (or an explicit grant check) in SQL. Do not
  fetch by id and then compare in JavaScript.
- Services (`apps/server/src/services/`) own business orchestration and re-check
  datasource access before touching a datasource. They do not depend on
  `FastifyRequest`.
- Repositories (`apps/server/src/db/repositories/`) contain Drizzle queries only.
  Keep cursor ordering deterministic (`sortTime`, then `id`).
- New permissions update `packages/shared/src/permissions.ts`, role presets,
  route/tool gates, admin UI, and tests.
- A new background service starts in `apps/server/src/app.ts` and stops in
  `onClose`; timers are cleared and not left running in tests.
- Public routes are an explicit list. A new unauthenticated route needs a reason
  in the change body.

## Data and SQL

- User SQL goes through `runGuardedQuery` → `guardSql` → `executeReadOnly`.
  Never call `pool.query`/`db.execute` on a user datasource, even in a tool or a
  test helper.
- `guardSql` allows read-only statements only, rejects system schemas/locking/
  unsafe functions, and injects a bounded limit. Do not reimplement a “small”
  check beside it.
- A datasource must be `readOnlyVerified=1` or explicitly
  `allowWriteAccount=1`; the latter still runs only read-only statements.
- Full rows belong in artifacts (JSONL), not SQLite, run events, prompts, or
  React state. SQLite stores artifact metadata and audit rows.
- Exports/downloads require `export.data` and write an audit row after the
  stream finishes. Do not buffer a whole artifact to send it.
- Chart input is bounded (`MAX_CHART_INPUT_ROWS`); do not load an artifact fully
  to compute a series.

## Migrations

- `apps/server/src/db/schema.ts` is the schema source; migrations live in
  `apps/server/drizzle/` and are append-only. Never edit an applied migration.
- Generate with `pnpm --filter @datachat/server exec drizzle-kit generate`, then
  inspect the SQL for indexes, unique constraints, foreign keys, defaults, and
  `NOT NULL` backfills.
- Update `apps/server/test/db.test.ts`:
  `APP_TABLES` for new tables, `INTEGRITY_INDEXES` for critical indexes, and an
  upgrade/idempotency case when behavior changes.
- A new column is nullable or has a safe default; do not require a rewrite of
  existing rows without a plan.

## Frontend

- All server state goes through React Query. Add a stable key in
  `apps/web/src/lib/query.ts`; list filters belong in the key.
- All HTTP goes through `apiRequest` in `apps/web/src/lib/api.ts`; no bare
  `fetch` in components. Surface `ApiError.code` where behavior differs.
- Reuse `components/ui` (Radix wrappers) and existing chat primitives
  (`ResultTable`, `ResultDetailDialog`, `Composer`, Markdown parser). Do not add a
  second design system or a parallel table.
- Icon-only buttons need `aria-label` and the shared `Tooltip`; native `title` is
  not an accessible tooltip.
- Empty/loading/error states are explicit. A failed mutation restores or
  invalidates the affected query; do not leave optimistic data behind.
- Keep the scroll chain `min-h-0`/`overflow-y-auto`; do not add nested
  `h-screen` scroll containers.
- Message syntax changes (`[[artifact:]]`, `[[chart:]]`, `[[result:]]`, Mermaid)
  update chat, streaming, report, and share consumers together.

## Tests

- Write the failing test first when fixing a bug. A test that passes on the old
  code is not evidence for the fix.
- Server route tests use `buildApp`, in-memory SQLite, a temp `dataDir`,
  `app.inject`, and a fake runtime. Do not call a real model or network.
- Agent tests use `FakeAgentSession`/`ConversationSessionFactory`; tool tests use
  an in-memory DB, temp artifacts, and a fake pool.
- Web tests use jsdom, `MemoryRouter`, a fresh `QueryClient`, and `userEvent`;
  stub `fetch` and throw on unexpected URLs.
- Integration tests require `RUN_DB_TESTS=1` + Testcontainers. Do not point them
  at a real database.
- Test behavior and error codes, not only message text. Cover cross-user access,
  permission denial, and the failure path.
- `pnpm verify` is the full gate. Root `pnpm test` excludes web tests; see
  [testing](subsystems/README.md#verification).

## Commits

- One goal per commit. A fix found on the way is its own commit.
- Subject names the area and observable behavior; body says what was run and which
  test fails without the change. Do not write “see push” or a placeholder.
- Before pushing, read `git show --stat HEAD`; if it names a file the goal never
  touched, stop and rebuild on current `main`.
- Do not commit `.env`, credentials, generated `dist`, or a stale `data/` tree.

## Review checklist

- [ ] The subsystem reference was read and updated if a contract changed.
- [ ] Route/tool permission and ownership are enforced server-side.
- [ ] SQL goes through guard/executor; no raw pool access.
- [ ] New tables/indexes have migrations and `db.test.ts` updates.
- [ ] Shared event/type changes reach server, replay, and web.
- [ ] Prompt/placeholder change reaches chat/report/share/stream.
- [ ] Tests fail without the fix and pass with it.
- [ ] `pnpm verify` passed, or the unrun step is named.
