# 定时任务（Phase 2）实施计划

> **执行方式：** 子代理分任务执行（每个任务由 fresh worker 完成、提交、再 review）。

**目标：** 让用户保存“自然语言问题 + 数据源 + cron”，服务端按计划自动执行，生成报告并发送站内信。

**架构：** 单进程 60 秒调度器 + SQLite 乐观锁抢占；隐藏会话复用现有 RuntimeManager；报告复用 `createReport`/`buildReportMarkdown`；通知落 `notifications` 表。

**技术栈：** TypeScript、Fastify、Drizzle/SQLite、React、TanStack Query、cron-parser。

---

## Task 1: 依赖、数据表与仓储

**Files:**
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0012_scheduled_tasks.sql`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Create: `apps/server/src/db/repositories/notifications.ts`
- Create: `apps/server/src/db/repositories/scheduled-tasks.ts`
- Test: `apps/server/test/scheduled-schema.test.ts`

**Step 1:** 添加依赖：

```bash
pnpm --filter @datachat/server add cron-parser@^5.4.0
```

**Step 2:** 在 `schema.ts` 增加 `conversations.kind` 与三张新表（字段见 spec §2），索引名与 SQL 一致。`kind` 用 `text("kind", { enum: ["chat", "scheduled"] }).notNull().default("chat")`。

**Step 3:** 写 `0012_scheduled_tasks.sql` 与 journal idx 12。迁移共 13 个（0000–0012）。

**Step 4:** `scheduled-tasks.ts` 导出：

```ts
export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;
export type ScheduledTaskRunRow = typeof scheduledTaskRuns.$inferSelect;
export function createScheduledTask(db, input): ScheduledTaskRow;
export function listScheduledTasks(db, userId): ScheduledTaskRow[];
export function findScheduledTask(db, id): ScheduledTaskRow | undefined;
export function findOwnedScheduledTask(db, id, userId): ScheduledTaskRow | undefined;
export function updateScheduledTask(db, id, patch): ScheduledTaskRow | undefined;
export function deleteScheduledTask(db, id): boolean;
export function listDueScheduledTasks(db, now): ScheduledTaskRow[];
export function claimScheduledTask(db, id, expectedNextRunAt, nextRunAt, now): boolean;
export function countScheduledTasks(db, userId): number;
export function createScheduledTaskRun(db, input): ScheduledTaskRunRow;
export function updateScheduledTaskRun(db, id, patch): void;
export function listScheduledTaskRuns(db, taskId, limit?): ScheduledTaskRunRow[];
export function failInterruptedScheduledRuns(db, now): number;
```

`claimScheduledTask` 使用 `where(and(eq(id), eq(nextRunAt, expected)))` 更新并返回 `changes === 1`。

**Step 5:** `notifications.ts` 导出 `createNotification`、`listNotifications(db,userId,limit)`、`countUnreadNotifications`、`markNotificationRead(db,id,userId)`、`markAllNotificationsRead(db,userId)`。

**Step 6:** `scheduled-schema.test.ts` 断言：迁移数 13、三张表存在、`conversations.kind` 默认 `chat`、due/claim 行为正确、通知已读幂等。

**Step 7:** `pnpm --filter @datachat/server typecheck && pnpm exec vitest run apps/server/test/scheduled-schema.test.ts`，提交 `feat(scheduled): add task, run and notification tables`。

---

## Task 2: cron 工具

**Files:**
- Create: `apps/server/src/services/schedule.ts`
- Test: `apps/server/test/schedule.test.ts`

**Step 1:** 实现：

```ts
export const MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000;
export interface ScheduleError { code: "INVALID_CRON" | "INVALID_TIMEZONE" | "TOO_FREQUENT"; message: string }
export function validateSchedule(input: { cronExpression: string; timezone: string }): ScheduleError | null;
export function nextScheduleRun(input: { cronExpression: string; timezone: string; from?: number }): number;
export function describeSchedule(cronExpression: string): string;
```

使用 `CronExpressionParser.parse(expr, { tz, currentDate: new Date(from) })`。先校验时区（`Intl.DateTimeFormat`），再解析；比较 `next()` 与再下一次的差值，`< 5 分钟` 返回 `TOO_FREQUENT`。`describeSchedule` 只处理预设形态（`M H * * *` 每天、`M H * * 1` 每周一、`M H 1 * *` 每月 1 日，其余返回原表达式）。

**Step 2:** 测试：合法每日/每周、非法 cron、非法时区、`* * * * *` 被拒、跨时区下一次时间正确、描述文案。

**Step 3:** 提交 `feat(scheduled): validate cron expressions and timezones`。

---

## Task 3: 执行服务（不含调度器）

**Files:**
- Create: `apps/server/src/services/scheduled-tasks.ts`
- Modify: `apps/server/src/services/artifacts.ts`（`listForRun(runId): ArtifactRecord[]`）
- Test: `apps/server/test/scheduled-execution.test.ts`

**Step 1:** 定义：

```ts
export class ScheduledTaskError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) { super(message); }
}
export interface ScheduledTaskServiceOptions {
  db: Db; config: AppConfig; pools: PoolRegistry; artifacts: ArtifactStore;
  runtime: RuntimeManager; now?: () => number;
}
export function createScheduledTaskService(options): ScheduledTaskService;
```

`ScheduledTaskService` 方法：`list/get/create/update/remove/runNow/sweep/shutdown`。

**Step 2:** `create/update` 校验 owner 的 `chat.use` + `report.create` + 数据源访问；计算 `nextRunAt`；同用户最多 20 个任务。`update` 支持 `name/prompt/datasourceId/cronExpression/timezone/modelId/enabled`，改调度字段时重算；`enabled=false` 保留 `nextRunAt`。

**Step 3:** `execute(task, trigger: "schedule" | "manual")`：

- `resolveUserAccess` + `canAccessDatasource`；用户禁用/不存在 → 停用，不通知；权限/数据源失效 → 停用 + `task_disabled` 通知 + run `skipped`。
- `createConversation({ kind: "scheduled", title: "定时任务：" + name, datasourceId, modelId })`；`createRun`；`runtime.getOrCreate`；订阅 `bus` 的 `run_end`；`enqueue`；10 分钟超时 abort。
- 成功：`artifacts.listForRun(runId)`；空则失败；最多 `REPORT_MAX_ARTIFACTS`；`createReport` 正文 `# name\n\n> 问题：prompt\n\n` + `buildReportMarkdown`；run `success`；重置失败计数；`task_success` 通知。
- 失败：计数 +1；≥3 停用并加 `task_disabled`；`task_failed` 通知；run `failed`。
- finally `runtime.remove(conversationId)`；若 `nextRunAt <= now` 且启用则重算。

**Step 4:** `sweep(now)`：取 due 任务；全局 2 / 单用户 1；`claimScheduledTask` 成功才 `void execute`；被并发限制的任务跳过（`nextRunAt` 已推进，下一轮仍会看到？——**必须只在真正开始执行时 claim**，并发不足时不要 claim）。

**Step 5:** 测试用 FakeAgentSession/RunEventBus：成功生成报告与通知；空 artifact 失败；连续 3 次停用；权限撤销跳过并停用；手动运行不改变 `nextRunAt`；并发限制。

**Step 6:** 提交 `feat(scheduled): execute tasks into reports and notifications`。

---

## Task 4: 路由与 app 接线

**Files:**
- Create: `apps/server/src/routes/scheduled-tasks.ts`
- Create: `apps/server/src/routes/notifications.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/scheduled-routes.test.ts`
- Test: `apps/server/test/notifications-routes.test.ts`

**Step 1:** 路由使用 `app.requirePermission("chat.use")`；创建/更新额外在 handler 中校验 `report.create`。

- `GET/POST /api/scheduled-tasks`
- `PATCH/DELETE /api/scheduled-tasks/:id`
- `POST /api/scheduled-tasks/:id/run`（409 `TASK_RUNNING`）
- `GET /api/scheduled-tasks/:id/runs`
- `GET /api/notifications`、`POST /api/notifications/:id/read`、`POST /api/notifications/read-all`

Zod schema 限制长度；错误映射 `ScheduledTaskError.statusCode`。

**Step 2:** `app.ts` 增加 `scheduledTasks?: ScheduledTaskService` 注入；构造服务并注册路由。`index.ts` 启动 60 秒 `setInterval` 调 `sweep()`，`unref()`，`onClose` 清理；启动时 `failInterruptedScheduledRuns(db, Date.now())`。

**Step 3:** 路由测试：普通用户 CRUD、owner 隔离、非法 cron 400、无 `report.create` 403、run now 409、通知未读数/已读、admin 不能读他人任务。

**Step 4:** 提交 `feat(scheduled): expose task and notification apis`。

---

## Task 5: 前端 API 与查询键

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/query.ts`

**Step 1:** 类型：

```ts
export interface ScheduledTaskSummary {
  id: string; name: string; prompt: string; datasourceId: string; datasourceName: string;
  cronExpression: string; timezone: string; modelId: string | null; enabled: boolean;
  nextRunAt: number; lastRunAt: number | null; consecutiveFailures: number;
  lastRun: { status: string; error: string | null; reportId: string | null; finishedAt: number | null } | null;
}
export interface ScheduledTaskRun { id: string; status: string; error: string | null; reportId: string | null; startedAt: number | null; finishedAt: number | null; createdAt: number }
export interface NotificationItem { id: string; type: string; title: string; body: string; href: string | null; readAt: number | null; createdAt: number }
```

函数：`listScheduledTasks/createScheduledTask/updateScheduledTask/deleteScheduledTask/runScheduledTask/listScheduledTaskRuns`、`listNotifications/markNotificationRead/markAllNotificationsRead`。

**Step 2:** `queryKeys` 增 `scheduledTasks`、`scheduledRuns(id)`、`notifications`。

**Step 3:** 提交 `feat(web): add scheduled task api types`。

---

## Task 6: 定时任务页面

**Files:**
- Create: `apps/web/src/pages/ScheduledTasksPage.tsx`
- Create: `apps/web/src/components/scheduled/TaskDialog.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Test: `apps/web/src/pages/ScheduledTasksPage.test.tsx`

**Step 1:** 页面列出任务：名称、数据源、`describeSchedule`、下次执行、最近状态、启用 Switch；行内“立即执行/编辑/删除/历史”。空态引导创建。

**Step 2:** Dialog 表单：名称、数据源（来自 `/api/datasources`）、问题、频率（每天/每周/每月/自定义）、时间（`HH:mm`）、时区（默认 `Intl.DateTimeFormat().resolvedOptions().timeZone`，下拉常用时区 + 保留输入）、模型（可选，默认跟随设置）。预设转 cron：每天 `m h * * *`、每周 `m h * * 1`、每月 `m h 1 * *`；自定义直接输入 5 段表达式。

**Step 3:** AppShell 增“定时任务”链接（`Clock` 图标），用 `useCan("chat.use")` 控制；App 加 `/scheduled` 路由。

**Step 4:** 测试：列表渲染、创建提交 payload、非法自定义 cron 前端提示、立即执行调用、历史展开。

**Step 5:** 提交 `feat(web): add scheduled tasks page`。

---

## Task 7: 通知铃铛与导航

**Files:**
- Create: `apps/web/src/components/NotificationBell.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Test: `apps/web/src/components/NotificationBell.test.tsx`

**Step 1:** 铃铛按钮显示未读 badge；Popover 列最近通知（标题、正文、时间、未读点），点击标记已读并跳转 `href`；底部“全部已读”。`refetchInterval: 30_000`。

**Step 2:** AppShell 顶栏右侧渲染铃铛（无 topbar 的页面也在侧栏底部保留入口？——顶栏已有则放顶栏；否则放侧栏用户区上方）。

**Step 3:** 测试：未读数、点击标记已读/跳转、全部已读。

**Step 4:** 提交 `feat(web): add in-app notifications`。

---

## Task 8: 文档、全量验证与推送

**Files:**
- Modify: `README.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/superpowers/specs/2026-11-13-scheduled-tasks-design.md`（状态）
- Modify: `docs/superpowers/plans/2026-11-13-scheduled-tasks.md`（勾选）

**Step 1:** README 增“定时任务与通知”章节：创建、cron/时区、最小间隔、隐藏会话、报告、通知、失败 3 次停用、并发/超时、权限失效行为；验收清单加一项；已知限制加“单机调度，不做分布式锁/IM”。

**Step 2:** roadmap 加 Phase 2 交付行，下一步候选改为 Playwright / 产品扩展 / 行列权限。

**Step 3:** `pnpm lint && pnpm verify`；修复所有问题。

**Step 4:** 勾选 plan，提交 `docs: document scheduled tasks`，`git push origin main`。

---

## 验收清单

- [x] 迁移 0012 应用成功，`conversations.kind` 默认 `chat`，旧会话不受影响。
- [x] cron/时区/最小间隔校验正确，预设映射正确。
- [x] 手动运行生成隐藏会话、run、报告、成功通知。
- [x] 失败/超时通知 owner，连续 3 次自动停用。
- [x] 权限/数据源失效时跳过并停用。
- [x] 任务/通知 owner 隔离；admin 不能读他人任务。
- [x] 列表不显示 `kind="scheduled"` 的会话。
- [x] UI 创建/编辑/暂停/删除/立即执行/历史/铃铛可用。
- [x] `pnpm verify` 通过并推送。
