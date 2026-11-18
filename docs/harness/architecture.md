# 架构

> 读完根目录 `AGENTS.md` 后再打开本文件。这里只描述稳定边界和主链路；具体字段以 `apps/server/src/db/schema.ts` 与 `packages/shared/src/` 为准。

## 1. 运行时拓扑

```text
┌──────────────────────────── 浏览器 ────────────────────────────┐
│ React 19 + Vite + Tailwind                                      │
│ /chat  /reports/:id  /s/:token  /admin/*  /memory  /scheduled    │
└───────────────┬────────────────────────────────────────────────┘
                │ HTTP / SSE（同源，cookie session）
                ▼
┌──────────────────────── Fastify (apps/server) ─────────────────┐
│ auth/guard → routes → services → db/repositories                │
│                                                               │
│ RuntimeManager ── ConversationRuntime ── Pi AgentSession       │
│       │                    │                    │              │
│       │                    ├── RunEventBus ─────┘              │
│       │                    └── tools → guardSql → executor     │
│       ├── ArtifactStore（DATA_DIR/artifacts）                   │
│       ├── SQLite（DATA_DIR/datachat.db）                        │
│       └── 用户数据源 MySQL / PostgreSQL（只读连接）              │
└───────────────────────────────────────────────────────────────┘
```

- 开发时 `pnpm dev` 同时启动 API（`PORT`，默认 9527）和 Vite（`WEB_PORT`，默认 9528），Vite 代理 `/api`。
- 生产由 Fastify 托管 `apps/web/dist` 静态文件；`APP_ORIGIN` 必须包含协议、主机和端口。
- 每个会话有一个持久化 Pi session 文件：`DATA_DIR/pi-sessions/<userId>/...`；会话重建会恢复同一 transcript。
- SQLite 是**应用元数据库**；业务数据始终留在 MySQL/PostgreSQL，查询结果落 artifact 文件。

## 2. 分层与代码地图

| 层 | 位置 | 职责 | 不该做什么 |
| --- | --- | --- | --- |
| HTTP | `apps/server/src/routes/` | 路由、参数校验、鉴权、状态码、错误形状 | 直接写复杂 SQL、直接读数据源 |
| 服务 | `apps/server/src/services/` | 业务编排、权限再校验、事务边界 | 解析 HTTP、依赖 React |
| 仓储 | `apps/server/src/db/repositories/` | Drizzle 查询、用户/数据源范围过滤 | 做 HTTP 状态码、拼 prompt |
| Agent | `apps/server/src/agent/` | Pi session、工具、SQL 安全、事件桥接 | 绕过服务层直接改业务表 |
| 共享 | `packages/shared/src/` | API 类型、权限、运行事件、常量 | 依赖 Node/浏览器专有 API |
| Web | `apps/web/src/` | 页面、组件、React Query、SSE | 直接信任前端权限判断 |

前端入口：`apps/web/src/main.tsx` → `App.tsx`（路由与 lazy import）→ `AppShell` / `AdminShell` → `pages/*`。
后端入口：`apps/server/src/index.ts` → `loadConfig` → `createDb` + `migrateDb` → `bootstrapAdmin` → `buildApp`。

## 3. HTTP 请求主链路

以 `GET /api/conversations?q=...` 为例：

1. `app.ts` 注册 cookie、CSRF、rate limit 与 `authenticate` 装饰器。
2. 路由的 `preHandler: app.requirePermission("chat.use")` 校验登录与权限。
3. zod/TypeBox 校验 query/body；失败返回 `400 VALIDATION`。
4. route 调 service/repository，repository 始终带 `userId` 条件。
5. 资源不存在或不属于当前用户统一返回 `404`，避免泄露存在性。
6. 成功返回 JSON；失败统一 `{ error: { code, message, details? } }`。

认证与授权：

- `apps/server/src/auth/guard.ts`：`authenticate`、`requirePermission`、`requireAdmin`。
- `apps/server/src/auth/access.ts`：`resolveUserAccess` 合并角色权限、直授数据源；管理员为全权限 + 全数据源。
- 权限字符串在 `packages/shared/src/permissions.ts`；新增权限必须同时更新角色预设、前端权限判断和后端 guard。

## 4. 一次聊天运行

```text
POST /api/conversations/:id/messages
  → conversations route 校验 skill / 队列
  → RuntimeManager.enqueue
  → ConversationRuntime（每会话串行队列）
  → createConversationSession（模型、prompt、skills、MCP、memory、tools）
  → Pi session.prompt()
      → 模型调用工具
      → db_schema / db_query / db_explain / make_chart / create_report
      → guardSql → executeReadOnly → artifact
      → EventBridge 把 Pi 事件转成 shared RunEvent，追加 run_events 并广播
  → run_end
      → 更新 runs / conversation.lastMessageAt
      → 异步提取用户记忆（若开启）
```

关键点：

- **一会话一队列**：同一会话的 run 串行；不同会话由 `RuntimeManager` 控制并发。不要绕过 runtime 直接 `session.prompt()`。
- **runId 是运行上下文**：`AgentToolContext.runId` 在每次 prompt 前由 runtime 改写；工具产生的 artifact、审计、事件必须绑定它。
- **事件双写**：`RunEventBus` 负责实时 SSE；`run_events` 负责断线重放/历史。新增事件类型先改 `packages/shared/src/run-events.ts`。
- **失败可重试**：失败 run 可通过 `runs.retry_of_run_id` 被替换；历史接口只展示最新有效轮次。改 run 状态时考虑重试与队列。
- **权限在入队与执行时都要看**：HTTP 入口校验一次；执行前 service/tool 再校验数据源与功能权限，防止排队期间权限被撤销。

SSE：`GET /api/runs/:id/stream`，支持 `Last-Event-ID`/`?after=` 从 `run_events.seq` 续传。前端 `useRunStream` 负责重连与合并。

## 5. 结果、图表、报告、分享

| 产物 | 产生 | 存储 | 展示 |
| --- | --- | --- | --- |
| 查询结果 | `db_query` / `runGuardedQuery` | `artifacts` 行 + `DATA_DIR/artifacts/*.jsonl` | `ResultTable` / `ResultCard` / 内联 `[[result:]]` |
| 图表 | `make_chart` | chart artifact（JSON spec） | `ChartCard` + ECharts，正文 `[[chart:]]` |
| 报告 | `create_report` | `reports` + markdown 内容 | `/reports/:id`，正文 `[[artifact:]]` 引用结果 |
| 分享 | 分享接口 | `shares` token + 快照 | `/s/:token` 只读页 |

- artifact 行只存元数据和预览，不把全量行塞进 SQLite。
- 前端占位符解析在 `apps/web/src/lib/report-markdown.ts`：`parseReportMarkdown` 处理报告，`parseChatMarkdown` 额外处理 `[[result:]]`；聊天、报告、分享、流式四处的分支必须同步。
- 导出/下载走 `routes/artifacts.ts`，需要 `export.data` 且写审计；不要在组件里直接拼文件。
- 公开分享绕过登录，但仍受分享 token、过期、数据源授权快照约束；不要把敏感字段写进分享快照。

## 6. 定时任务与记忆

- **定时任务**：`services/scheduled-task-service.ts` + 60s sweep。任务以隐藏会话 `kind=scheduled` 执行；执行前重新检查用户/数据源权限；失败/成功都写 `scheduled_task_runs` 与通知。并发上限：全局 2、单用户 1、10 分钟超时。
- **用户记忆**：`apps/server/src/memory/`。召回在每轮 prompt 前注入（全局 + 数据源相关，字符预算 3500）；`memory_save` 工具写 `user_memories`；成功 run 后异步提取（最多 3 条）。记忆只属于用户，管理员只能全局禁用/管理，不能读取他人记忆正文。

## 7. 信任边界

1. 浏览器输入全部不可信：参数校验、SQL guard、Markdown 清洗/React 转义。
2. 模型输出不可信：不得直接执行模型给的 SQL/命令；工具内部仍要 guard。
3. 数据源凭据只在服务端解密使用；不返回前端、不写 prompt、不写日志。
4. 数据源返回的内容可能包含 prompt injection；工具结果只作为数据，不提升为系统指令。
5. 公开分享是匿名边界：只返回快照允许的字段。

## 8. 扩展点

- 新数据源类型：`agent/datasource/`、`services/datasource-service.ts`、schema 缓存/表单、guard 方言分支、测试 fixture。
- 新 Agent 工具：`agent/tools/` + `buildAgentTools` + `AgentToolContext` + 事件桥接映射 + 权限/审计 + 测试。
- 新页面：`pages/` + `App.tsx` lazy route + `AppShell` 导航 + Query key + API 类型。
- 新运行事件：`packages/shared/src/run-events.ts` → server EventBridge → frontend `useRunStream`/`MessageList` → 测试。
