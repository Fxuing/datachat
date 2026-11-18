# DataChat 项目 Harness

> 这是 agent 进入仓库的**唯一入口**，不是项目全书。
> 先读完本文件；再按下面的「阅读路由」只打开与当前任务相关的一份参考文档。
> 文档与代码/测试冲突时，以代码和测试为准，并顺手修正文档。

## 项目是什么

DataChat 是一个自然语言数据查询应用：用户在聊天中提问，Pi Agent 先读取数据源 schema，再生成**只读 SQL**，在 MySQL / PostgreSQL 上执行，结果保存为 artifact，前端渲染结论、SQL、表格、图表、报告与分享页。

技术栈：pnpm workspace、Node.js ≥ 22.9、React 19 + Vite + Tailwind 3、Fastify 5、Pi Coding Agent SDK、Drizzle + SQLite（仅存应用元数据）、MySQL/PostgreSQL（用户数据源）。

## 一分钟架构

```text
浏览器 /chat
   │  HTTP + SSE
   ▼
Fastify (apps/server) ── SQLite 元数据 / artifacts 文件 / Pi session 文件
   │
   ├── routes → services → db/repositories
   └── Pi Agent runtime → tools → guardSql → 只读 SQL → 用户数据源
```

- **元数据库**：`apps/server/src/db/schema.ts` + `apps/server/drizzle/`，只存用户、会话、运行、权限、artifact 元数据等，不存业务库数据。
- **用户数据**：查询结果写入 `DATA_DIR/artifacts/`，元数据行在 SQLite；不要把大结果塞进 SQLite。
- **Agent**：`apps/server/src/agent/`。每个会话一个 Pi session，工具通过闭包绑定 `userId / conversationId / datasourceId / runId`。
- **前端**：`apps/web/src/`。服务端状态用 React Query，流式运行用 SSE，消息渲染在 `components/chat/`。

## 不可协商的约束

1. **SQL 必须走安全链路**：所有用户数据查询经过 `guardSql`（`apps/server/src/agent/sql/guard.ts`）和 `executeReadOnly`（`.../executor.ts`）；业务入口是 `runGuardedQuery`（`apps/server/src/services/query-service.ts`）。不要为了“方便”新增直连 pool 的查询旁路，也不要把写语句、系统库、加锁读放进来。
2. **权限 fail closed**：HTTP 路由用 `requirePermission` / `requireAdmin`（`apps/server/src/auth/guard.ts`），服务层在真正执行前重新解析用户、角色、数据源授权（`resolveUserAccess` / `canAccessDatasource`）。不要相信前端传来的 userId、datasourceId 或权限标记。
3. **数据源 id 由服务端绑定**：Agent 工具上下文已经包含 `datasourceId`；工具参数不允许让模型自选数据源。新增工具时保持这个边界。
4. **API 错误形状统一**：失败响应是 `{ error: { code, message, details? } }`；前端通过 `ApiError.code` 分支。不要返回裸字符串或另一种错误结构。
5. **共享协议放 `packages/shared`**：跨前后端的运行事件、权限、常量、类型先改 shared，再改两端；不要在前端复制一份事件字符串。
6. **改表必须走迁移**：修改 `schema.ts` 后用 `apps/server/drizzle.config.ts` 生成迁移，提交 SQL 与 `meta/_journal.json`；同时更新 `apps/server/test/db.test.ts` 的表/索引断言。不要手改已应用的迁移文件。
7. **秘密不落地**：数据源密码、API Key、cookie、token 不得写日志、prompt、审计正文、测试快照或提交。测试用假值；`.env`、`data/`、`data-test/` 不提交。
8. **Prompt / Skill 是产品行为**：`agent/prompts/system.md` 面向所有会话；`agent/skills/*` 是内置技能模板。改 prompt 要同步检查相关测试与前端占位符协议（`[[artifact:]]`、`[[chart:]]`、`[[result:]]`）。
9. **前端沿用现有设计系统**：Radix 包装组件在 `apps/web/src/components/ui/`；按钮、输入、Sheet、Dialog、Tooltip 优先复用。不要引入第二套 UI 库；不要用原生 `title` 代替可访问的 Tooltip。
10. **依赖从简**：新增运行时依赖前先确认标准库/现有依赖无法完成；不要把 `dist/`、生成报告或运行数据加入版本控制。

## 阅读路由（渐进披露）

只读当前任务需要的那一行；跨层任务先读 `architecture.md`。

| 任务 | 先读 | 继续深入 |
| --- | --- | --- |
| 第一次接触项目、跨层改动、找不到代码 | [`docs/harness/architecture.md`](docs/harness/architecture.md) | 对应层的文档 |
| Fastify 路由、服务、SQLite、迁移、权限、SQL 安全 | [`docs/harness/backend.md`](docs/harness/backend.md) | `apps/server/src/routes`、`services`、`db` |
| React 页面、聊天渲染、React Query、组件测试 | [`docs/harness/frontend.md`](docs/harness/frontend.md) | `apps/web/src/pages`、`components/chat` |
| Pi session、工具、prompt、skill、模型、MCP、记忆 | [`docs/harness/agent.md`](docs/harness/agent.md) | `apps/server/src/agent`、`memory`、`agent/` |
| 写测试、跑集成测试、eval、CI | [`docs/harness/testing.md`](docs/harness/testing.md) | 同目录测试文件 |
| 产品状态、已交付能力、已知缺口 | [`docs/roadmap.md`](docs/roadmap.md) | 对应 spec/plan |
| 需求设计、实施计划 | [`docs/superpowers/specs/`](docs/superpowers/specs/) / [`plans/`](docs/superpowers/plans/) | 先写/更新设计，再拆任务 |
| 安装、环境变量、部署、运维 | [`README.md`](README.md) | `.env.example`、`deploy/` |

**不要预加载全部 `docs/harness/`。** 需要细节时再打开；读完一层就回到任务。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 安装 | `pnpm install` |
| 同时启动 API + Web | `pnpm dev` |
| 全量验证（提交前默认） | `pnpm verify` |
| lint / 类型检查 | `pnpm lint` / `pnpm typecheck` |
| 服务端 + shared 测试 | `pnpm test` |
| Web 组件测试 | `pnpm --filter @datachat/web test` |
| 单个服务端测试 | `pnpm exec vitest run apps/server/test/<name>.test.ts` |
| 单个 Web 测试 | `pnpm --filter @datachat/web exec vitest run src/<path>.test.tsx` |
| 真库集成测试 | `RUN_DB_TESTS=1 pnpm --filter @datachat/server test`（需 Docker/可达数据库） |
| NL2SQL 金标集 | `pnpm eval:nl2sql`（默认 Testcontainers，见 README） |

注意：根目录 `pnpm test` **不包含** web 测试；`pnpm verify` 才包含 lint、typecheck、两端测试和构建。

## 默认工作流

1. **定位既有模式**：用 `rg` 找同类路由/服务/组件/测试；先读相邻实现，不要凭空发明结构。
2. **写清影响面**：涉及新表、权限、API 协议、prompt 行为、跨层重构时，先在回复中列出改动面；需要设计时放 `docs/superpowers/specs/`，多步实施再拆 plan。
3. **先写失败测试**：行为变化至少覆盖最靠近边界的测试（repo → route/service → component）；纯文案/样式可只补组件测试或说明不适用。
4. **小步实现**：保持现有分层和命名；不要顺手重构无关代码。
5. **验证**：先跑目标测试，再跑 `pnpm verify`；不能跑或失败时明确说明，不要声称“已通过”。
6. **收尾**：更新受影响的 README/roadmap/spec；检查 `git diff` 无秘密、无生成物；用 `feat|fix|docs|test|refactor(scope): ...` 提交。

## 完成定义

- 新行为有测试，且测试不依赖真实模型/真实数据库（集成测试除外）。
- `pnpm typecheck` 通过；提交前 `pnpm verify` 通过，或明确记录未跑原因。
- 新表/索引有迁移，`apps/server/test/db.test.ts` 同步。
- 新 API 有权限校验、错误码和前端 `ApiError` 处理。
- 新 prompt/skill 行为有对应测试或至少手工验证记录；占位符协议在前后端一致。
- 没有提交 `.env`、`data/`、密钥、真实用户数据或 `dist/` 构建产物。

## 常见坑

- **Web 测试不在根 vitest include 里**：必须用 `pnpm --filter @datachat/web test` 或带 filter 的 `exec vitest`。
- **共享包有 `dist/`**：`pnpm typecheck` 会先构建 shared；不要手改 `packages/shared/dist`。
- **SQLite 是元数据库**：不要在 SQLite 里模拟 MySQL/PostgreSQL 方言；方言逻辑放 `guard`/`executor` 和技能文档。
- **会话/运行状态是事件溯源**：run 事件追加到 `run_events`，前端 SSE 消费；不要只改内存状态而不写事件。
- **权限修改对已打开会话不一定即时**：Agent 资源在**新建会话**时解析；HTTP 接口是每请求解析。改权限行为时想清楚作用域。
- **前端占位符不是普通 Markdown**：`[[artifact:]]`、`[[chart:]]`、`[[result:]]` 由 `report-markdown.ts` 解析；改语法要同时改聊天、报告、分享和流式分支。
- **部署 origin**：`APP_ORIGIN` 要含端口；HTTP 部署的 cookie `Secure` 由协议推导，不要硬编码。

## 文档维护

| 变化 | 更新 |
| --- | --- |
| 已交付能力、已知缺口、下一步 | `docs/roadmap.md` |
| 新功能设计/取舍 | `docs/superpowers/specs/` |
| 多步实施拆解 | `docs/superpowers/plans/` |
| 安装、环境变量、部署、运维命令 | `README.md` |
| 分层约定、代码地图、测试方式 | `docs/harness/*` |

如果发现本文档与实际代码不一致，优先修正文档或代码中的一处，不要留下第三种说法。
