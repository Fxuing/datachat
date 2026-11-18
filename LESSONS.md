# Lessons

Real regressions and near-misses in DataChat. Before changing code, find the rule
that matches the area. Add an entry when a bug ships or is caught in review; name
the rule that would have caught it, not only the symptom.

## Prompt and skills

**A built-in skill edit does not reach an existing database.**
`seedSkills` imports `agent/skills/<name>/SKILL.md` only when that name is absent
([skills.ts](apps/server/src/agent/skills.ts)); existing rows are skipped, including
datasource overrides. Editing the source file changes new installs only.
Rule: update existing deployments through `/admin/skills`, a migration, or a
versioned sync; do not claim a built-in skill changed until one of those ran.

**A prompt rule can be made false by a capability added beside it.**
The prompt used to say “only `[[chart:<id>]]` puts a chart in the body”; adding
Mermaid fences made that sentence misleading. The fix separated data charts
(`make_chart`) from structural diagrams (Mermaid) and re-read every “only/always”
near the change ([system.md](agent/prompts/system.md), commits `91485e0`, `43b5773`).
Rule: when adding a rendering channel or placeholder, grep the prompt for absolute
claims and merge them instead of appending a new paragraph.

**An inline placeholder has four consumers, not one.**
A chat-only `[[result:<id>]]` must be parsed by chat text, streaming text, reports,
and public shares; reports keep it literal while chat resolves it
([report-markdown.ts](apps/web/src/lib/report-markdown.ts),
[MessageItem.tsx](apps/web/src/components/chat/MessageItem.tsx),
[MessageList.tsx](apps/web/src/components/chat/MessageList.tsx)). Missing one
shows raw syntax or drops content.
Rule: change the parser and every consumer together; add a streaming half-marker
test.

**A skill is not in the prompt just because its file exists.**
Skills are materialized per conversation from the DB only with `skill.use`, and
the model reads them with the sandboxed `read` tool. An explicit `/skill` also
injects the body via `composeSkillInstruction`.
Rule: verify the permission, the materialized directory, and the explicit
injection path before debugging model behavior ([resources.ts](apps/server/src/agent/resources.ts),
[skills.ts](apps/server/src/agent/skills.ts)).

## Tests and verification

**The root test command is not the whole test suite.**
`pnpm test` runs `apps/*/test` and `packages/**/test` only; web tests live under
`apps/web/src/**/*.test.tsx`. A green root run can leave the web broken.
Rule: use `pnpm verify`, or run the web command separately
([vitest.config.ts](vitest.config.ts), [web vitest config](apps/web/vitest.config.ts)).

**A new table or index is not done until `db.test.ts` knows it.**
`APP_TABLES` and `INTEGRITY_INDEXES` are schema guards, not documentation. A
migration without updating them leaves the guard passing against an incomplete
picture ([db.test.ts](apps/server/test/db.test.ts)).
Rule: update both lists and add an upgrade/idempotency case when behavior changes.

**A frontend mutation callback receives `(variables, context)`.**
React Query v5 passes a second argument; tests that assert a single argument fail
or, worse, miss a call shape. The memory-page test had to use
`toHaveBeenCalledWith(false, expect.anything())`.
Rule: assert the variables you care about and allow the context argument.

## Runtime and data

**Results are files, not rows.**
`db_query` streams rows into an artifact (JSONL + metadata); SQLite stores the
artifact row, not the full result. Putting thousands of rows in SQLite, `run_events`,
or the prompt defeats pagination, export, and share projections
([artifacts.ts](apps/server/src/services/artifacts.ts)).
Rule: keep the data path artifact-first; use the result dialog/table for rows.

**SSE is two paths.**
Live events go through `RunEventBus`; reconnects replay `run_events` by `seq`.
A new event that only publishes live disappears on reload; one that only persists
freezes the open page ([event-bridge.ts](apps/server/src/agent/event-bridge.ts),
[runs.ts](apps/server/src/routes/runs.ts)).
Rule: append + publish + replay + consume, and end every terminal path with
`run_end`.

**A run’s `runId` is execution state, not a constructor argument.**
The tool context is shared across runs in a conversation; the runtime updates
`toolContext.runId` before each prompt so artifacts and audit rows belong to the
current run ([runtime.ts](apps/server/src/agent/runtime.ts)).
Rule: never capture `runId` once in a tool factory and reuse it across prompts.

**Permissions are re-read per request, but session resources are a snapshot.**
`resolveUserAccess` runs on each HTTP request and queued/scheduled work re-checks
the database. Skills/MCP/report tools, however, are built into a session when it
is created; revoking a role does not rewrite an already-open session.
Rule: enforce at execution where possible; when a permission change must take
effect immediately, recreate the session/runtime instead of assuming the old tool
set changed.

## Deployment and UI

**`APP_ORIGIN` must include the public port.**
CSRF/cookie checks compare the browser origin; an origin without `:9528` (or the
deployed port) rejects login. `COOKIE_SECURE` follows the origin protocol unless
explicitly overridden. The HTTP + IP deployment failed login until `21cc5d5`
fixed the derivation.
Rule: test the actual public URL, not only `localhost`; keep compose/env examples
in sync.

**A filter over the loaded page is not a filter over the conversation list.**
The sidebar loads 30 rows; filtering only that array hides conversations the user
cannot see. The list API now takes `q` and the repo uses `instr(lower(...))` so
`%`/`_` stay literal ([conversations.ts](apps/server/src/db/repositories/conversations.ts)).
Rule: put list filters in the query key and the server query, not only in component
state.

**An empty filter that loses focus should not keep a dead input.**
Replacing “新建对话” with a filter input is only usable if an empty, unfocused
filter restores the primary action; a non-empty filter stays open. This is a
state-machine detail, not a styling detail
([ConversationSidebar.tsx](apps/web/src/components/chat/ConversationSidebar.tsx)).
Rule: define open/empty/querying/closed states and test blur, Escape, and clear.

## Change discipline

**A fix reaches every sibling.**
The same placeholder is parsed in chat/report/share; the same permission gate is
needed on HTTP and tools; the same model resolution is used by conversation,
scheduled task, and memory extraction. Fixing one call site leaves the others
lying ([architecture references](docs/subsystems/README.md)).
Rule: grep for the predicate/parser/gate name and change every caller in the same
commit.

**A commit’s file list is checked against its goal.**
Before pushing, read `git show --stat HEAD`. A file the change never meant to
touch, or a stale tree, means stop and rebase rather than pushing unrelated work.
Rule: one goal per commit; name what was run in the body.
