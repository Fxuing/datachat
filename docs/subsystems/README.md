# Subsystem design references

These pages describe current responsibilities, runtime paths, state, and
contracts. Start with the subsystem your task touches, then follow its source
links to verify the implementation. Do not read every page.

| Subsystem | Reference |
| --- | --- |
| Conversation runtime, queue, Pi session, run events and SSE | [Chat runtime](chat-runtime.md) |
| SQL guard/executor, query service, artifacts, audit | [SQL and artifacts](sql-artifacts.md) |
| Login/session, roles, permissions, datasource grants, public shares | [Auth and permissions](auth-permissions.md) |
| Datasource connection, probe, introspection and schema cache | [Datasources and schema](datasources.md) |
| Chat UI, message segments, result/chart/report rendering, scrolling | [Chat UI](chat-ui.md) |
| Memory recall, `memory_save`, extraction, user/admin settings | [Memory](memory.md) |
| Scheduled tasks, sweeps, notifications, hidden conversations | [Scheduled tasks](scheduled-tasks.md) |
| Reports and public share snapshots | [Reports and shares](reports-shares.md) |

## Maintain a reference

Update the owning reference in the same commit when a change alters a documented
responsibility, interface, state transition, runtime path, compatibility rule, or
failure behavior. An internal refactor that preserves those contracts does not
need a prose change.

Keep each fact in one reference and link to it from `AGENTS.md` or another page.
Link to source files and named symbols rather than copying implementation that
changes frequently. Explain field meanings and constraints that signatures alone
do not express.

A new reference includes:

- responsibilities and boundaries;
- source of truth;
- main runtime paths;
- state transitions;
- important constraints and failure behavior;
- verification commands.

Document current behavior separately from proposed changes; a proposal belongs in
its issue/spec, not in a reference.

## Describe a change

For each affected subsystem, state the observable change, its trigger, and
before/after behavior. Include interface, state, compatibility, and failure
changes. Link the reference, implementation, and test evidence. For a refactor,
say explicitly that the documented behavior is unchanged.

## Review a change

1. Identify the affected subsystem and its actual runtime path.
2. Compare claimed before/after behavior with the base and head; trace callers and
   state transitions beyond the diff.
3. Check the owning reference is updated and its source links resolve.
4. Check the cited tests or runtime evidence exercise the claimed behavior. List
   checks that were not run.

A documentation change alone does not prove behavior; tests and runtime evidence
remain necessary.

## Verification

```bash
pnpm verify                              # lint + typecheck + server/shared + web + build
pnpm test                                # server/shared only
pnpm --filter @datachat/web test         # web only
RUN_DB_TESTS=1 pnpm exec vitest run apps/server/test  # MySQL/PG integration
```

Subsystem pages list narrower commands. Use them while iterating; finish with
`pnpm verify` or name the step that was not run.
