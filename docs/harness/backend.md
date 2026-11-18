# 后端

> 适用：`apps/server/**`、`packages/shared/**`、SQLite 迁移、API、权限、SSE。前端只看 `frontend.md`。

## 1. 启动与依赖装配

`apps/server/src/index.ts`：

1. `loadConfig()` 读取/校验环境变量（`config.ts`）。
2. `createDb(config)` 打开 SQLite，启用 WAL、外键等（`db/client.ts`）。
3. `migrateDb()` 应用 `apps/server/drizzle/`（`db/migrate.ts`）。
4. `bootstrapAdmin()` 首次创建管理员（`auth/bootstrap.ts`）。
5. `buildApp({ config, db, ...测试 seam })` 注册插件、鉴权、路由、`ArtifactStore`、`RuntimeManager`、后台 sweep。
6. `listen({ host, port })`。

`buildApp` 是测试入口：新增路由/后台服务时在 `app.ts` 注册，并确保 `onClose` 释放 timer、连接池、runtime。不要在 route 模块里创建全局连接。

## 2. 分层规则

### Route（`src/routes/`）

- 一个文件一个 Fastify plugin，签名 `async function xxxRoutes(app, opts)`。
- 参数用 zod（或已有 schema）`safeParse`；失败返回 `400 VALIDATION`。
- 每个受保护路由写 `{ preHandler: app.requirePermission("...") }`；`requirePermission` 内部已执行 `authenticate`。
- 资源归属检查在 route/service 完成；不属于当前用户统一 404。
- 不在 route 里直接 `db.select()` 写复杂查询；调 service/repository。
- 响应字段用 `packages/shared` 的类型或明确的 mapper（如 `toConversationResponse`）。

最小模板：

```ts
app.get("/api/things/:id", { preHandler: app.requirePermission("chat.use") }, async (request, reply) => {
  const params = idSchema.safeParse(request.params);
  if (!params.success) return reply.code(400).send(error("VALIDATION", "参数不合法"));
  const thing = findOwnedThing(opts.db, params.data.id, request.user!.sub);
  if (!thing) return reply.code(404).send(error("NOT_FOUND", "不存在"));
  return toThingResponse(thing);
});
```

### Service（`src/services/`）

- 业务编排、跨仓储事务、外部连接、权限再校验。
- 不要依赖 `FastifyRequest`；参数显式传入 `db/config/userId/...`，方便测试。
- 涉及数据源的操作必须先 `authorizeDatasourceAccess` 或 `canAccessDatasource`；不要信任 route 已校验过。
- 抛出领域错误（如 `MemoryValidationError`）由 route 映射为状态码；或返回 discriminated union。

### Repository（`src/db/repositories/`）

- 只做 Drizzle 查询；输入显式带 `userId`/`datasourceId`。
- 用户资源查询始终同时匹配 `userId`，例如 `findOwnedConversation`；不要先按 id 查再在 JS 判断。
- 列表游标：排序键 + id 作为复合游标，避免同一毫秒漏行（参考 `listConversations`）。
- 时间统一用 `Date.now()` 的整数毫秒；布尔用 0/1；JSON 字段用 text 存储并显式解析。

## 3. 错误与状态码

统一形状：

```json
{ "error": { "code": "VALIDATION", "message": "参数不合法", "details": {} } }
```

常用：

| 状态 | code | 场景 |
| --- | --- | --- |
| 400 | `VALIDATION` | 参数/JSON 不合法 |
| 401 | `AUTH_REQUIRED` | 未登录/会话失效 |
| 403 | `PERMISSION_DENIED` / `FORBIDDEN` | 缺功能权限 / 管理员或资源限制 |
| 404 | `NOT_FOUND` | 资源不存在或不属于当前用户 |
| 409 | `CONFLICT` / 业务码 | 重名、在用、队列满 |
| 429 | `RATE_LIMITED` | 限流/队列 |
| 500 | `INTERNAL` | 未预期错误 |

- 不要向前端返回 SQL、堆栈、连接串、密钥。
- 业务错误码要稳定；前端可能依赖 `ApiError.code` 分支（如 `MEMORY_DUPLICATE`）。

## 4. 权限

- 权限常量：`packages/shared/src/permissions.ts`；新增权限要更新 `ALL_PERMISSIONS`、角色预设、管理页和测试。
- 路由级：`app.requirePermission("chat.use")`；管理员路由 `app.requireAdmin`。
- 资源级：`request.access` 是每请求由 `resolveUserAccess` 计算；数据源还要看 `datasource_grants` / 角色授权。
- 管理员：`role === "admin"` 时全权限、全数据源；不要用“角色名”判断。
- **执行前再查**：排队/定时任务可能在入队后失去权限；`runGuardedQuery`、scheduled service、memory 写入都要重新校验。
- 公开路由只有登录、健康检查、公开分享等显式例外；新增公开路由必须在 code review 中说明原因。

## 5. SQLite、Schema 与迁移

- Schema：`apps/server/src/db/schema.ts`；Drizzle 配置：`apps/server/drizzle.config.ts`（`out: ./drizzle`）。
- 迁移是**追加式**：不要改已应用的 `000x_*.sql`；新迁移放下一序号，并更新 `drizzle/meta/_journal.json`（由 drizzle-kit 生成）。
- 生成命令（在 `apps/server` 包上下文）：

```bash
pnpm --filter @datachat/server exec drizzle-kit generate
```

- 生成后人工检查 SQL：索引、唯一约束、外键、默认值、`NOT NULL` 回填。
- 更新 `apps/server/test/db.test.ts`：
  - `APP_TABLES` 增加新表；
  - `INTEGRITY_INDEXES` 增加关键索引；
  - 迁移幂等/旧版本升级测试如涉及行为变化。
- 常用字段约定：主键 UUID text；时间整数毫秒；布尔 integer 0/1；金额/大数不要用 float；JSON 用 text + 明确 parser。
- 迁移失败要可诊断：`migrateDb` 会给出路径上下文；不要吞掉。

## 6. SQL 安全链路

任何用户数据查询必须：

```text
route/service/tool
  → authorizeDatasourceAccess (user + grant + active)
  → guardSql({ sql, dialect, maxRows })
  → executeReadOnly(...)
  → ArtifactStore (JSONL + meta)
  → recordAudit
```

- `guardSql`：只允许 `select/show/desc/explain`；拒绝写、DDL、系统库、锁、危险函数、过多表；注入安全 `LIMIT`。
- `executeReadOnly`：使用数据源只读连接；流式写 artifact；超时/取消；不把全量行放内存。
- 数据源必须 `readOnlyVerified=1`，或管理员显式 `allowWriteAccount=1` 且仍只执行只读语句。
- 审计 `query_audit` 记录成功/拒绝/错误；拒绝也不能创建连接池。
- **禁止**新增 `pool.query(modelSql)`、`db.execute` 直连用户数据源、或在工具外执行模型 SQL。
- 设置项（最大行数、预览行数、超时）通过 `resolveQueryLimits` 读取，管理员改动下一次运行生效。

## 7. SSE 与运行事件

- 事件类型：`packages/shared/src/run-events.ts`；前后端共用，不要自造字符串。
- 追加：`appendRunEvent` 写 `run_events`（`seq` 连续），再 `runtime.bus.publish` 给实时订阅者。
- 流：`GET /api/runs/:id/stream`，支持 `Last-Event-ID` / `?after=`；先回放持久化事件，再订阅实时事件，避免断线丢事件。
- 新增事件时的检查单：
  1. shared 类型 + 可序列化 payload；
  2. `event-bridge.ts` 从 Pi 事件映射；
  3. 持久化 + 广播；
  4. 前端 `useRunStream` 合并；
  5. 历史回放（`listRunEventsAfter`）和组件测试。

## 8. Artifact 与文件

- `ArtifactStore` 管 `DATA_DIR/artifacts/`：结果 JSONL、图表 spec、元数据行。
- 结果行只存文件；SQLite 只存 `rowCount/columns/truncated/storagePath` 等。
- 下载/导出：`routes/artifacts.ts`，要求 `export.data`，流式响应并在完成后写审计。
- 删除会话/用户时清理关联 artifact 文件与 Pi session；不要只删数据库行。
- 图表输入最多 `MAX_CHART_INPUT_ROWS`（50k），不要全量载入内存。

## 9. 后台任务

- 定时任务 sweep、保留策略、备份恢复都在 `app.ts` 启动，`onClose` 停止。
- 定时任务执行前重新检查用户状态、功能权限、数据源授权；任务失效要停用并通知。
- 后台任务不要复用请求级 `request.access`；自己重新 `resolveUserAccess`。
- 任何定时器都要 `unref()` 或在 `onClose` 清理，避免测试进程挂起。

## 10. 提交前检查

- [ ] route 有参数校验、权限、错误码。
- [ ] 用户资源查询带 `userId`；跨用户测试通过。
- [ ] 数据源操作走 `runGuardedQuery`/guard，无直连。
- [ ] 新表/索引有迁移，`db.test.ts` 更新。
- [ ] 新 shared 类型两端同步。
- [ ] 目标测试 + `pnpm verify` 通过。
