# 代码规范

这里是评审规则，不是教程。评审者逐条检查适用的规则；漏掉一条，就要在评论里点名。某条规则被真实 bug 打破时，把事故和规则补进 [LESSONS.md](../LESSONS.md)。

## 一个改动应该包含什么

| 规则 | 评审者看什么 |
| --- | --- |
| 只做目标需要的事。 | 无关重构、顺手加的功能、格式化噪音、策略变更，放到单独 commit。 |
| 修复覆盖所有同类位置。 | 全局搜索解析器、谓词、权限门禁或路由名。聊天/报告/分享、HTTP/工具、会话/定时/记忆是常见同类路径。 |
| 沿整条路径检查。 | 跟着输入 → 路由 → 服务 → 仓储/工具 → artifact/事件 → UI 走一遍。中间某个函数正确，不代表整个操作正确。 |
| 失败时默认拒绝。 | 配置读不出、权限缺失、数据源未知、解析失败，都不能当成“空”或“全部允许”。返回错误并保留旧数据。 |
| 依赖变化时重新推导。 | 限制、schema、事件或 query key 变了，所有调用方、测试和已有假设都要更新。 |
| 秘密不能进入客户端、prompt、日志、URL 或分享。 | 错误路径和调试输出也要检查。 |

## 服务端

- 路由文件（`apps/server/src/routes/`）负责校验输入、声明 `preHandler: app.requirePermission(...)`，并把领域错误映射成共享的 `{ error: { code, message, details? } }` 结构。
- 资源查询必须在 SQL 里带 `userId`（或显式的授权检查）。不要先按 id 查出来，再在 JavaScript 里比较。
- 服务层（`apps/server/src/services/`）负责业务编排，访问数据源前重新检查数据源权限；不要依赖 `FastifyRequest`。
- 仓储层（`apps/server/src/db/repositories/`）只放 Drizzle 查询。游标排序必须确定（先 `sortTime`，再 `id`）。
- 新增权限要同时更新 `packages/shared/src/permissions.ts`、角色预设、路由/工具门禁、管理界面和测试。
- 新后台服务在 `apps/server/src/app.ts` 启动，并在 `onClose` 停止；测试里不能留下运行中的定时器。
- 公开路由是显式列表。新增未认证路由，必须在改动说明里给出理由。

## 数据与 SQL

- 用户 SQL 必须走 `runGuardedQuery` → `guardSql` → `executeReadOnly`。绝不要在用户数据源上直接调 `pool.query`/`db.execute`，工具和测试辅助函数也不行。
- `guardSql` 只允许只读语句，拒绝系统 schema、锁、危险函数，并注入带上限的 limit。不要在它旁边重新实现一个“很小的”检查。
- 数据源必须是 `readOnlyVerified=1`，或显式 `allowWriteAccount=1`；后者也仍然只执行只读语句。
- 完整行数据属于 artifact（JSONL），不属于 SQLite、run events、prompt 或 React state。SQLite 只存 artifact 元数据和审计行。
- 导出/下载需要 `export.data`，并在流结束后写审计行。不要把整个 artifact 缓存在内存里再发送。
- 图表输入有上限（`MAX_CHART_INPUT_ROWS`）；不要为了算一个序列而完整加载 artifact。

## 迁移

- `apps/server/src/db/schema.ts` 是 schema 的事实来源；迁移在 `apps/server/drizzle/`，只能追加。绝不能修改已经执行过的迁移。
- 用 `pnpm --filter @datachat/server exec drizzle-kit generate` 生成，然后检查 SQL 里的索引、唯一约束、外键、默认值和 `NOT NULL` 回填。
- 更新 `apps/server/test/db.test.ts`：新表加进 `APP_TABLES`，关键索引加进 `INTEGRITY_INDEXES`；行为变化时补升级/幂等用例。
- 新列要么可空，要么有安全默认值；没有方案时，不要要求重写已有行。

## 前端

- 所有服务端状态走 React Query。在 `apps/web/src/lib/query.ts` 加稳定 key；列表筛选条件要进 key。
- 所有 HTTP 请求走 `apps/web/src/lib/api.ts` 的 `apiRequest`；组件里不要裸用 `fetch`。行为有差异的地方要暴露 `ApiError.code`。
- 复用 `components/ui`（Radix 包装）和现有聊天原语（`ResultTable`、`ResultDetailDialog`、`Composer`、Markdown 解析器）。不要新增第二套设计系统或另一张表格。
- 纯图标按钮需要 `aria-label` 和共享的 `Tooltip`；原生 `title` 不是无障碍 tooltip。
- 空态、加载态、错误态要明确。mutation 失败后要恢复或失效受影响的 query；不要留下乐观数据。
- 保持滚动链 `min-h-0`/`overflow-y-auto`；不要新增嵌套的 `h-screen` 滚动容器。
- 消息语法（`[[artifact:]]`、`[[chart:]]`、`[[result:]]`、Mermaid）变化时，聊天、流式、报告和分享消费端要一起改。

## 测试

- 修 bug 时先写会失败的测试。能在旧代码上通过的测试，不能作为修复证据。
- 服务端路由测试用 `buildApp`、内存 SQLite、临时 `dataDir`、`app.inject` 和假 runtime。不要调用真实模型或网络。
- Agent 测试用 `FakeAgentSession`/`ConversationSessionFactory`；工具测试用内存数据库、临时 artifact 和假 pool。
- Web 测试用 jsdom、`MemoryRouter`、新的 `QueryClient` 和 `userEvent`；stub `fetch`，遇到意外 URL 要抛错。
- 集成测试需要 `RUN_DB_TESTS=1` + Testcontainers。不要指向真实数据库。
- 测行为和错误码，不要只测提示文案。覆盖跨用户访问、权限拒绝和失败路径。
- `pnpm verify` 是完整门禁。根目录 `pnpm test` 不含 Web 测试；见 [验证](subsystems/README.md#验证)。

## 提交

- 一个 commit 只做一个目标。路上发现的修复单独提交。
- 标题写清区域和可观察行为；正文写跑了什么、哪个测试在改动前会失败。不要写“见推送”或占位符。
- push 前读 `git show --stat HEAD`；如果出现目标之外的文件，停下来，基于当前 `main` 重建。
- 不要提交 `.env`、凭据、生成的 `dist` 或过期的 `data/` 树。

## 评审清单

- [ ] 读过子系统参考；契约变化时已更新。
- [ ] 路由/工具的权限和归属在服务端强制执行。
- [ ] SQL 走守卫/执行器；没有裸 pool 访问。
- [ ] 新表/索引有迁移，并更新了 `db.test.ts`。
- [ ] 共享事件/类型变化覆盖服务端、回放和 Web。
- [ ] Prompt/占位符变化覆盖聊天、报告、分享、流式。
- [ ] 测试在修复前失败，修复后通过。
- [ ] `pnpm verify` 通过；未跑的步骤已说明。
