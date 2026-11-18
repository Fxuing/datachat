# Scheduled tasks

A scheduled task runs a saved prompt against one datasource, produces a report, and
notifies its owner. Scheduled runs use the same runtime, SQL guard, artifacts, and
permission checks as interactive chat.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Tables | `scheduled_tasks`, `scheduled_task_runs`, `notifications` | [`schema.ts`](../../apps/server/src/db/schema.ts) |
| Schedule parser | 5-field cron, IANA timezone, minimum interval, next run | [`schedule.ts`](../../apps/server/src/services/schedule.ts) |
| Service | CRUD, sweep, execute, retry/failure policy, report creation | [`scheduled-tasks.ts`](../../apps/server/src/services/scheduled-tasks.ts) |
| Sweeper | 60s interval, non-overlapping sweeps | [`scheduler.ts`](../../apps/server/src/agent/scheduler.ts) |
| Routes | User-scoped tasks/runs, run-now, notifications | [`scheduled-tasks.ts` route](../../apps/server/src/routes/scheduled-tasks.ts), [`notifications.ts`](../../apps/server/src/routes/notifications.ts) |
| UI | Task list/editor, run history, notification bell | [`ScheduledTasksPage.tsx`](../../apps/web/src/pages/ScheduledTasksPage.tsx) |

Constants: `SCHEDULED_TASK_LIMIT = 20` per user, `SCHEDULED_SWEEP_INTERVAL_MS =
60_000`, `SCHEDULED_RUN_TIMEOUT_MS = 10 * 60_000`, `SCHEDULED_MAX_FAILURES = 3`,
`MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000`.

## Runtime path

1. The create/update route validates name/prompt/cron/timezone/datasource and the
   user’s `chat.use`/`report.create` permissions, then stores `nextRunAt` in UTC.
2. The sweeper calls `sweep()` every 60 seconds. A sweep does not overlap a previous
   one. Due tasks are selected by `enabled=1 AND nextRunAt <= now`.
3. Before execution, re-read the user and access: disabled user, lost permission, or
   lost datasource grant marks the task run `skipped`, disables the task, and sends a
   notification. Never execute with stale permission.
4. Create a hidden conversation (`kind="scheduled"`, title `定时任务：<name>`), a
   `runs` row, and a `scheduled_task_runs` row. Subscribe to the run event bus, then
   enqueue the prompt through `RuntimeManager`.
5. On `run_end`, collect the run’s artifacts. No artifact is a failure. Otherwise
   create a report with up to `REPORT_MAX_ARTIFACTS` results, mark success, reset
   `consecutiveFailures`, and notify with a link to the report.
6. On error/timeout, abort the run, mark the task run failed, increment consecutive
   failures, notify, and disable after 3. Failures do not delete history.
7. Clean up the timer, event subscription and runtime. The hidden conversation
   remains for traceability; it is not shown in the normal chat list.

One active run per user and one per task are enforced in-process (`activeUsers` /
`activeTasks`). A manual “run now” uses the same execute path and is subject to the
same permission/timeout rules.

## Contracts

- **Recheck permissions at execution time**, not only when the task is created.
  Revocation must skip and disable, not run with the old access.
- **A scheduled task needs a report.** A successful model turn with no query result
  is a failed task run; do not notify success without a report.
- **Cron is 5 fields and timezone-aware.** The next time is computed from the task’s
  IANA timezone; do not use server-local time. Reject intervals under 5 minutes.
- **Exactly one terminal notification per task run.** Avoid double notifications
  from timeout + abort + run_end.
- **Hidden conversations are still real conversations.** They follow ownership,
  artifact, run-event and deletion rules; do not special-case security checks.
- **Task deletion does not delete run history silently.** Define/keep the chosen
  behavior and test it; do not orphan `scheduled_task_runs`.
- **Sweep is single-flight.** A slow run must not start overlapping sweeps or
  duplicate executions; use the active maps/DB state.

## Failure behavior

| Case | Behavior |
| --- | --- |
| Invalid cron/timezone/interval | `400` with code; no task saved |
| Task limit reached | `409`/limit error |
| User disabled | Task run `skipped`; task disabled; notification |
| Lost permission/datasource | Task run `skipped`; task disabled; notification |
| No artifacts | Failed run; error “没有生成可保存的查询结果” |
| Timeout | Abort run, fail task run, notify |
| 3 consecutive failures | Disable task, send “自动停用” notification |
| Overlapping sweep | Skip this sweep; do not queue duplicates |

## Verification

```bash
pnpm exec vitest run apps/server/test/scheduled-execution.test.ts \
  apps/server/test/scheduled-routes.test.ts \
  apps/server/test/schedule.test.ts \
  apps/server/test/scheduled-schema.test.ts \
  apps/server/test/notifications-routes.test.ts
```

A scheduling change needs a timezone/DST or minimum-interval test. An execution
change needs a skipped-permission test and a timeout test proving cleanup.
