# 定时任务

定时任务针对一个数据源运行保存的 prompt，生成报告并通知属主。定时运行和交互式聊天使用同一套运行时、SQL 守卫、artifact 和权限检查。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 表 | `scheduled_tasks`、`scheduled_task_runs`、`notifications` | [`schema.ts`](../../apps/server/src/db/schema.ts) |
| 调度解析 | 5 段 cron、IANA 时区、最小间隔、下次运行时间 | [`schedule.ts`](../../apps/server/src/services/schedule.ts) |
| 服务 | CRUD、扫描、执行、重试/失败策略、创建报告 | [`scheduled-tasks.ts`](../../apps/server/src/services/scheduled-tasks.ts) |
| 扫描器 | 60 秒间隔、不重叠扫描 | [`scheduler.ts`](../../apps/server/src/agent/scheduler.ts) |
| 路由 | 用户范围的 task/run、立即运行、通知 | [`scheduled-tasks.ts` 路由](../../apps/server/src/routes/scheduled-tasks.ts)、[`notifications.ts`](../../apps/server/src/routes/notifications.ts) |
| UI | 任务列表/编辑器、运行历史、通知铃铛 | [`ScheduledTasksPage.tsx`](../../apps/web/src/pages/ScheduledTasksPage.tsx) |

常量：每个用户 `SCHEDULED_TASK_LIMIT = 20`、`SCHEDULED_SWEEP_INTERVAL_MS = 60_000`、`SCHEDULED_RUN_TIMEOUT_MS = 10 * 60_000`、`SCHEDULED_MAX_FAILURES = 3`、`MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000`。

## 运行路径

1. 创建/更新路由校验名称/prompt/cron/时区/数据源，以及用户的 `chat.use`/`report.create` 权限，然后按 UTC 存 `nextRunAt`。
2. 扫描器每 60 秒调用一次 `sweep()`。扫描不重叠。通过 `enabled=1 AND nextRunAt <= now` 选出到期任务。
3. 执行前重新读取用户和权限：用户被禁用、权限丢失或数据源授权丢失时，把任务运行标成 `skipped`，禁用任务并发送通知。绝不能带着旧权限执行。
4. 创建隐藏会话（`kind="scheduled"`，标题 `定时任务：<name>`）、`runs` 行和 `scheduled_task_runs` 行。订阅 run 事件总线，然后通过 `RuntimeManager` 入队 prompt。
5. `run_end` 时收集本轮 artifact。没有 artifact 视为失败。否则用最多 `REPORT_MAX_ARTIFACTS` 个结果创建报告，标记成功，重置 `consecutiveFailures`，并发送带报告链接的通知。
6. 出错/超时时，中止 run、标记任务运行失败、累加连续失败数、发通知，连续 3 次后禁用。失败不删除历史。
7. 清理定时器、事件订阅和 runtime。隐藏会话保留用于追溯；它不出现在普通聊天列表里。

每个用户一个活跃 run、每个任务一个活跃 run，都在进程内强制（`activeUsers` / `activeTasks`）。手动“立即运行”走同一执行路径，也受同样的权限/超时规则约束。

## 契约

- **执行时重新检查权限**，不只在创建任务时检查。权限撤销必须跳过并禁用，而不是用旧权限继续跑。
- **定时任务必须有报告。** 模型成功但没有查询结果，视为任务运行失败；没有报告就不要通知成功。
- **Cron 是 5 段且带时区。** 下次时间按任务的 IANA 时区计算；不要用服务器本地时间。拒绝小于 5 分钟的间隔。
- **每个任务运行只发一条终止通知。** 避免超时 + 中止 + `run_end` 造成重复通知。
- **隐藏会话仍然是真实会话。** 它遵守归属、artifact、run-event 和删除规则；不要在安全检查上做特殊分支。
- **删除任务不能静默删除运行历史。** 明确并保持选定的行为，不要留下孤儿 `scheduled_task_runs`。
- **扫描是单飞的。** 慢运行不能启动重叠扫描或重复执行；使用 active map/数据库状态。

## 失败行为

| 情况 | 行为 |
| --- | --- |
| cron/时区/间隔无效 | `400` 带错误码；不保存任务 |
| 达到任务上限 | `409`/上限错误 |
| 用户被禁用 | 任务运行 `skipped`；禁用任务；通知 |
| 权限/数据源丢失 | 任务运行 `skipped`；禁用任务；通知 |
| 没有 artifact | 失败；错误“没有生成可保存的查询结果” |
| 超时 | 中止 run，任务运行失败，通知 |
| 连续 3 次失败 | 禁用任务，发送“自动停用”通知 |
| 扫描重叠 | 跳过本次；不要排重复任务 |

## 验证

```bash
pnpm exec vitest run apps/server/test/scheduled-execution.test.ts \
  apps/server/test/scheduled-routes.test.ts \
  apps/server/test/schedule.test.ts \
  apps/server/test/scheduled-schema.test.ts \
  apps/server/test/notifications-routes.test.ts
```

调度改动需要时区/夏令时或最小间隔测试。执行改动需要权限跳过测试，以及证明清理完成的超时测试。
