# 定时任务（Phase 2）设计

## 1. 目标

让登录用户把“自然语言问题 + 数据源”保存为定时任务，按日/周/月或自定义 cron 自动执行；每次执行生成一份分析报告，并通过站内信通知 owner。第一版只做“报告 + 站内信”，不做 IM 推送、不做多人订阅、不做行列级权限。

已确认的产品决策：

- 所有拥有 `chat.use` 且能访问目标数据源的用户都可以创建任务。
- 任务只属于创建者，不支持共享或转交。
- 支持预设（每天/每周一/每月 1 日）+ 自定义 5 段 cron + IANA 时区。
- 执行失败通知 owner；连续失败 3 次自动停用。
- 任务运行使用隐藏会话（`conversations.kind = "scheduled"`），不出现在聊天历史里。
- 执行时重新校验用户状态、`chat.use`、`report.create` 与数据源访问；权限失效立即停用任务并通知。
- 调度轮询间隔 60 秒；全局并发 2，同一用户并发 1；单次超时 10 分钟。

## 2. 数据模型

新增迁移 `0012_scheduled_tasks.sql`：

```sql
ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
CREATE INDEX conversations_user_kind_idx ON conversations (user_id, kind);

CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  datasource_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL,
  model_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX scheduled_tasks_user_idx ON scheduled_tasks (user_id);
CREATE INDEX scheduled_tasks_due_idx ON scheduled_tasks (enabled, next_run_at);

CREATE TABLE scheduled_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  conversation_id TEXT,
  run_id TEXT,
  report_id TEXT,
  status TEXT NOT NULL,
  error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX scheduled_task_runs_task_created_idx
  ON scheduled_task_runs (task_id, created_at DESC);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  href TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC);
```

`kind` 取值 `chat | scheduled`，默认 `chat`。`listConversations` 只返回 `chat`。定时任务的会话标题为 `定时任务：<name>`，`modelId` 取任务配置；为空时跟随当前默认模型。

任务运行状态：`queued | running | success | failed | skipped`。`skipped` 用于用户被禁用/权限失效/数据源不可用；权限失效会同时停用任务。

通知类型：`task_success | task_failed | task_disabled`。

## 3. 调度

- 只接受标准 5 段 cron（分 时 日 月 周），使用 IANA 时区；`cron-parser` 计算下一次执行时间。
- 相邻两次执行间隔不得小于 5 分钟，避免误填 `* * * * *`。
- 预设映射：
  - 每天：`M H * * *`
  - 每周：`M H * * 1`
  - 每月：`M H 1 * *`
- 创建/修改时计算 `next_run_at`；恢复启用、改 cron/时区也重算。
- 调度器每 60 秒查询 `enabled=1 AND next_run_at <= now`：
  1. 事务内把 `next_run_at` 更新为下一个未来时间（乐观锁，条件为旧值），抢到才执行。
  2. 受全局/用户并发限制；超限时保留到下一轮（不丢任务）。
  3. 超过 10 分钟未结束则 abort，并记为失败。
- 服务重启时把遗留的 `running` 运行记录标记为失败（“服务重启中断”），避免永远转圈。

## 4. 执行流程

1. 校验任务存在且启用；用户存在且 `status="active"`。
2. `resolveUserAccess` 校验 `chat.use`、`report.create`，并用 `canAccessDatasource` 校验数据源。
   - 用户不存在/被禁用：停用任务，不发送通知。
   - 权限或数据源失效：停用任务，写 `task_disabled` 通知，运行记 `skipped`。
3. 新建隐藏会话（`kind="scheduled"`）和 `runs` 行；`runtime.enqueue({content: prompt, displayContent: prompt})`，等待 `run_end`。
4. 成功：
   - 查询该 run 的 artifacts；为空则视为失败（“执行完成但没有查询结果”）。
   - 最多取 `REPORT_MAX_ARTIFACTS` 个，生成标题 `<name> · YYYY-MM-DD HH:mm`。
   - 正文：`# <name>` + `> 问题：<prompt>` + 每个 artifact 的确定性 Markdown（复用 `buildReportMarkdown`）。
   - `createReport` 写入 `reports`，运行记录 `success`，任务 `consecutive_failures=0`。
   - 通知 `task_success`，`href=/reports/<id>`。
5. 失败/中止/超时：
   - `consecutive_failures += 1`；达到 3 时 `enabled=0` 并加 `task_disabled` 通知。
   - 运行记录 `failed`，通知 `task_failed`，`href=/scheduled`。
6. 结束释放该隐藏会话的 runtime（不删除会话与报告）。

## 5. API

所有接口要求登录 + `chat.use`；任务按 owner 隔离。创建/更新另需 `report.create` 与目标数据源访问；`admin` 不绕过 owner 隔离。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/scheduled-tasks` | 当前用户任务列表（含数据源名、下次执行、最近一次运行） |
| POST | `/api/scheduled-tasks` | 创建 |
| PATCH | `/api/scheduled-tasks/:id` | 改名、问题、数据源、cron、时区、模型、启用/停用 |
| DELETE | `/api/scheduled-tasks/:id` | 删除任务及其运行记录（保留已生成报告） |
| POST | `/api/scheduled-tasks/:id/run` | 立即执行一次 |
| GET | `/api/scheduled-tasks/:id/runs` | 最近 20 次运行 |
| GET | `/api/notifications` | 最近 20 条 + 未读数 |
| POST | `/api/notifications/:id/read` | 标记已读 |
| POST | `/api/notifications/read-all` | 全部已读 |

校验：

- name 1–80 字符；prompt 1–2000 字符。
- cron 合法、时区合法、最小间隔 5 分钟。
- 数据源必须存在且当前用户可访问。
- 同一用户最多 20 个任务；同一任务同时只能有一个运行。
- 立即执行时若任务正在运行返回 409 `TASK_RUNNING`。

## 6. 前端

- 新增 `/scheduled` 页面（导航“定时任务”，仅 `chat.use` 可见）：
  - 列表：名称、数据源、频率（人类可读）、下次执行、最近状态、启用开关。
  - 操作：立即执行、编辑、删除、查看最近运行/报告。
  - 新建/编辑 Dialog：名称、数据源、问题、频率（每天/每周/每月/自定义 cron）、时间、时区、模型（可选）。
  - 运行历史：状态、时间、耗时、报告链接或错误。
- AppShell 顶栏增加通知铃铛：未读数 badge、下拉最近通知、点击跳转、全部已读；每 30 秒轮询。
- 权限：无 `chat.use` 不显示入口；无 `report.create` 不允许创建任务；无 `export.data` 不影响任务报告。
- 通知与任务页面只对 owner 展示。

## 7. 非目标

- 不做 IM / 邮件 / Webhook 推送。
- 不做任务共享、多人订阅、审批。
- 不做行列级数据权限。
- 不做分布式调度/多实例抢占（单机 SQLite 部署）。
- 不自动清理历史任务运行与隐藏会话；沿用现有保留策略。

## 8. 验收

- 创建“每天 09:00”任务后 `next_run_at` 正确；非法 cron/时区/过短间隔被拒绝。
- 手动“立即执行”生成隐藏会话、run、报告、成功通知；报告可在 `/reports/:id` 打开。
- 模型失败时运行记 `failed` 并通知；连续 3 次后任务自动停用。
- 撤销 `report.create`/数据源权限后，下一次执行被跳过并停用任务，发送停用通知。
- 并发限制生效；单任务不重入；服务重启后遗留 running 标记失败。
- `pnpm verify` 通过；新增服务端/前端测试覆盖上述关键路径。
