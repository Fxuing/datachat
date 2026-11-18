# 数据源与 schema 缓存

数据源是一条加密的 MySQL/PostgreSQL 连接，加上一份缓存的 schema 快照。管理员管理连接；用户只能看到授权给自己的数据源。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 输入校验 | 共享 schema、host/port/database 规则 | [`index.ts`](../../packages/shared/src/index.ts) |
| 探测 | 连接、测试只读状态、收集安全警告 | [`probe.ts`](../../apps/server/src/agent/datasource/probe.ts) |
| 内省 | MySQL/PostgreSQL 表、列、键 | [`introspect.ts`](../../apps/server/src/agent/datasource/introspect.ts) |
| 凭据 | 用 `APP_SECRET` 做 AES-GCM 加解密 | [`crypto.ts`](../../apps/server/src/agent/datasource/crypto.ts) |
| 连接池 | 复用连接；配置变化时关闭 | [`pool.ts`](../../apps/server/src/agent/datasource/pool.ts) |
| Schema 缓存 | 持久化快照/错误、24h TTL、并发去重、过期回退 | [`schema-refresh.ts`](../../apps/server/src/services/schema-refresh.ts)、[`schema-cache.ts`](../../apps/server/src/db/repositories/schema-cache.ts) |
| 管理路由 | CRUD、测试、schema 刷新、权限检查 | [`datasources.ts`](../../apps/server/src/routes/datasources.ts)、[`datasource-schema.ts`](../../apps/server/src/routes/datasource-schema.ts) |
| 授权检查 | 用户/角色/直接数据源访问 | [`access.ts`](../../apps/server/src/auth/access.ts) |

`datasources.password_cipher` 是唯一保存的秘密。绝不记录或返回明文密码；探测错误通过 `safeErrorMessage` 传递，并抹掉密码。

## 运行路径

### 创建 / 更新

1. 管理员提交 `datasourceInputSchema`（名称、类型、host、port、database、username、password、SSL 模式、`allowWriteAccount`）。
2. 连接前拒绝 link-local/元数据地址（`isBlockedDatasourceHost`）和重名。
3. `probeDatasource` 建立短连接并检查只读状态。探测使用提交的密码，但绝不记录。
4. 保存加密后的密码；只有探测证明确实只读时才设 `readOnlyVerified=1`。设置 `allowWriteAccount` 时保留标志，但执行时仍然只允许只读语句。修改 host/database/凭据会把 `readOnlyVerified` 重置为 0。
5. 写 `datasource_create`/`datasource_update` 审计；让旧连接的 pool 失效。

### 读取 schema（`db_schema` 或 schema API）

1. 检查用户仍有该数据源权限。
2. 读取缓存快照。如果不存在或超过 `SCHEMA_CACHE_TTL_MS`（24h），调用 `refreshDatasourceSchema`。
3. 同一数据源的并发刷新共享一个内省 promise。
4. 内省成功保存新快照；失败时保存错误，但保留旧快照。
5. 刷新失败且存在快照时，带 `stale=true` 返回旧快照；没有快照时返回 `SCHEMA_UNAVAILABLE` 和用户可读原因。
6. 工具可以按 `table` 或 `search` 过滤；截断要显式标记，让模型知道 schema 不完整。

schema 端点读取同一份缓存；不暴露凭据或查询数据。

## 契约

- 数据源 id 是 UUID；**归属不是表里的列**——访问权来自授权。每个路由/工具都必须调用授权检查；模型给的 datasource id 必须和当前 run 的用户核对后才能用。
- 只读 pool 是执行边界。`allowWriteAccount` 只是抑制“账号可写”警告；SQL 守卫仍然拒绝写入。
- 新增方言不能只在 UI 分支。守卫解析、执行器、内省、占位符语法和测试都要支持。
- 删除仍被会话引用的数据源必须返回 `409`；成功后清理 schema 缓存/pool/授权。
- schema 快照是元数据，不是安全边界：表名/列名可以出现在 prompt 里，但行数据仍然必须走 `db_query`。
- DDL 或连接修改后要显式失效缓存。管理员可以立即刷新，不能只依赖 TTL。

## 失败行为

| 情况 | 行为 |
| --- | --- |
| 凭据/host 错误 | 受控探测错误；创建时不留下数据源行 |
| link-local/元数据地址 | `400 HOST_NOT_ALLOWED` |
| 重名 | `409 CONFLICT` |
| 探测成功但账号可写 | 保存并告警，除非 `allowWriteAccount` |
| 刷新失败，旧快照存在 | 返回 stale 快照 + 警告 |
| 刷新失败，无快照 | `SCHEMA_UNAVAILABLE`；不要伪造 schema |
| 用户没有授权 | `403` / 工具返回 `DATASOURCE_FORBIDDEN`；不建立连接 |
| 删除正在使用的数据源 | `409`；不要静默级联 |

## 验证

```bash
pnpm exec vitest run apps/server/test/datasource.test.ts \
  apps/server/test/datasource-schema.test.ts \
  apps/server/test/schema-refresh.test.ts \
  apps/server/test/db-schema-lazy.test.ts \
  apps/server/test/probe.test.ts \
  apps/server/test/introspect.test.ts
RUN_DB_TESTS=1 pnpm exec vitest run apps/server/test/introspect.integration.test.ts
```

连接/安全改动需要真实的 MySQL/PostgreSQL 探测测试。缓存改动需要 stale 回退测试，证明旧快照不会被删除。
