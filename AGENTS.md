# 编码 agent 须知

DataChat 把自然语言问题转换成对 MySQL / PostgreSQL 的只读 SQL。服务端使用 Fastify + SQLite（元数据）+ Pi Agent；前端使用 React 19 + Vite。

## 子系统设计与评审

修改已有文档的子系统之前，先读
[docs/subsystems/README.md](docs/subsystems/README.md) 中的对应参考，并核对它链接的源码。

如果改动会影响职责、接口、状态转换、运行路径、兼容规则或失败行为，必须在同一个
commit 里更新对应的参考文档。描述可观察的前后行为，不要只列改了哪些文件。

## 代码规范

编写和评审改动时遵循 [docs/code-standards.md](docs/code-standards.md)。

## 教训

改代码前先读 [LESSONS.md](LESSONS.md)：这里记录本仓库发生过的回归和险情，以及本可提前发现它们的规则。

## 高风险路径

以下位置最容易出现“看起来合理、实际是错的”改动：

- **SQL 安全。** 绝不能在 `runGuardedQuery` / `guardSql` / `executeReadOnly` 之外执行模型生成的 SQL。不要直接 `pool.query`，不要直接访问数据源，也不要因为“查询很简单”就绕过守卫。见 [SQL 与 artifact](docs/subsystems/sql-artifacts.md)。
- **权限。** 每次都要从数据库重新解析访问权；不要信任请求体里的 user id、datasource id、角色或权限。资源查询必须带 `userId` 作用域；agent 工具在执行时还要重新检查授权。见 [认证与权限](docs/subsystems/auth-permissions.md)。
- **行级数据范围。** 受控数据源必须在 `guardSql` 之后、建立连接之前解析部门范围；未分类表、缺失映射、过期策略一律拒绝，绝不 fail-open。改写只能通过 `applyScopeToSql` / `rewriteSqlForScope`，不要手工拼过滤条件；历史结果必须校验 run 快照。见 [部门与行级数据权限](docs/subsystems/data-scope.md)。
- **元数据与数据。** SQLite 只存元数据；完整查询行存在 artifact 文件里。不要把完整结果集放进 SQLite、run events、prompt 或浏览器包。见 [SQL 与 artifact](docs/subsystems/sql-artifacts.md)。
- **运行事件。** 实时 SSE 走 `RunEventBus`；回放走持久化的 `run_events`。新增一种事件会同时影响共享联合类型、bridge、持久化、回放和 Web 消费端。`run_end` 必须始终是终止事件。见 [聊天运行时](docs/subsystems/chat-runtime.md)。
- **Prompt 与技能。** `[[artifact:]]`、`[[chart:]]`、`[[result:]]` 和 Mermaid 代码块在不止一个地方被解析。`seedSkills` 不会按名称更新已有技能。见 [聊天界面](docs/subsystems/chat-ui.md) 和 [教训](LESSONS.md)。
- **秘密。** 数据源密码和模型服务 API key 在存储时加密；绝不能写进 prompt、日志、错误、URL、分享页或前端。公开分享是属主数据的只读投影，不是新的认证路径。见 [认证与权限](docs/subsystems/auth-permissions.md)。
- **迁移。** 只能追加新迁移，不能修改已经执行过的迁移。schema 变化时同步更新 `apps/server/test/db.test.ts` 里的 `APP_TABLES`、`INTEGRITY_INDEXES`。见 [代码规范](docs/code-standards.md#迁移)。

## 验证

默认门禁是 `pnpm verify`，它会跑 lint、typecheck、服务端/共享测试、Web 测试和构建。根目录的 `pnpm test` **不包含** Web 测试。

各子系统参考里写了针对性的命令。如果有步骤没有运行，要明确说出来。
