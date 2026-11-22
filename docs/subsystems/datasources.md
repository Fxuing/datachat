# 数据源与 schema 缓存

数据源是一条加密的数据库连接（内置 MySQL / PostgreSQL，并支持通过 `@datachat/datasource-sdk` 插件扩展其他方言），加上一份缓存的 schema 快照。管理员管理连接；用户只能看到授权给自己的数据源。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 驱动插件 SDK | 协议版本、清单/方言校验、类型归一化、脱敏与一致性检查套件 | [`packages/datasource-sdk`](../../packages/datasource-sdk/src/index.ts) |
| 驱动注册与加载 | 注册内置 MySQL/PostgreSQL 驱动；按 `DATASOURCE_PLUGINS` 白名单或管理后台离线上传（`.mjs`/`.zip`/`.tgz`）热加载插件；`options_json` 按字段加密 | [`registry.ts`](../../apps/server/src/drivers/registry.ts)、[`archive.ts`](../../apps/server/src/drivers/archive.ts)、[`datasource-plugins.ts`](../../apps/server/src/services/datasource-plugins.ts)、[`admin-datasource-plugins.ts`](../../apps/server/src/routes/admin-datasource-plugins.ts)、[`options.ts`](../../apps/server/src/drivers/options.ts) |
| 输入校验 | 共享 schema、驱动类型格式、`options`、host/port/database 规则 | [`index.ts`](../../packages/shared/src/index.ts) |
| 探测 | 通过 `DriverRegistry` 分发探测、测试只读状态、收集安全警告 | [`probe.ts`](../../apps/server/src/agent/datasource/probe.ts) |
| 内省 | MySQL/PostgreSQL 表、列、键（自定义驱动走 `pool.introspect()`） | [`introspect.ts`](../../apps/server/src/agent/datasource/introspect.ts) |
| 凭据 | 用 `APP_SECRET` 做 AES-GCM 加解密（密码与 `secret: true` 扩展参数） | [`crypto.ts`](../../apps/server/src/agent/datasource/crypto.ts) |
| 连接池 | 复用内置与自定义驱动连接池；配置变化时关闭 | [`pool.ts`](../../apps/server/src/agent/datasource/pool.ts) |
| Schema 缓存 | 持久化快照/错误、24h TTL、并发去重、过期回退 | [`schema-refresh.ts`](../../apps/server/src/services/schema-refresh.ts)、[`schema-cache.ts`](../../apps/server/src/db/repositories/schema-cache.ts) |
| 管理路由 | 驱动列表（`GET /api/datasources/drivers`）、CRUD、测试、schema 刷新、权限检查 | [`datasources.ts`](../../apps/server/src/routes/datasources.ts)、[`datasource-schema.ts`](../../apps/server/src/routes/datasource-schema.ts) |
| 轻量语义层与 Few-Shot 知识库 | 按数据源管理业务指标口径、同义词、标准表关联、Few-Shot SQL 示例库与用户问答反馈沉淀，并在每轮对话按需召回注入 | [`semantic-layer.ts` 服务](../../apps/server/src/services/semantic-layer.ts)、[`semantic-layer.ts` 仓储](../../apps/server/src/db/repositories/semantic-layer.ts)、[`sql-examples.ts` 仓储](../../apps/server/src/db/repositories/sql-examples.ts)、[`admin-semantic.ts`](../../apps/server/src/routes/admin-semantic.ts)、[`DatasourceSemanticPage.tsx`](../../apps/web/src/pages/admin/DatasourceSemanticPage.tsx) |
| 授权检查 | 用户/角色/直接数据源访问 | [`access.ts`](../../apps/server/src/auth/access.ts) |

`datasources.password_cipher` 与 `datasources.options_json` 中带 `__enc` 标记的 `secret: true` 扩展字段保存加密秘密。绝不记录或返回明文密码与敏感选项；列表响应仅返回公开 `options` 与 `secretOptionKeys`（已配置密钥键名列表）；探测错误通过 `safeErrorMessage` 传递并抹掉秘密。

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
- 新增方言通过 `@datachat/datasource-sdk` 插件接入，由 `DriverRegistry` 注册并统一驱动守卫解析（`guardSql` 合并 `extraForbiddenFunctions` / `extraSystemSchemas`）、行级权限改写（按 `capabilities.rowScope` 开关与 `placeholderStyle`）、执行器、内省、Prompt 提示与前端动态表单。外部插件可通过 `DATASOURCE_PLUGINS` 环境变量或管理员界面离线上传（持久化在 `DATA_DIR/plugins/datasources/` 与 `datasource_plugins` 表，可由 `ALLOW_PLUGIN_UPLOAD=false` 关闭界面上传），均不得覆盖内置驱动或环境变量驱动 id；停用/升级/卸载时必须同步关闭该驱动的活跃连接池。
- 若已保存的数据源所依赖的外部驱动在重启后未加载，查询/测试/刷新/行级权限必须 fail-closed 返回 `DRIVER_NOT_INSTALLED`；前端列表仍正常展示并标记「驱动未安装」。
- 若驱动声明 `capabilities.rowScope: false`，管理员尝试启用或预览行级权限时必须返回 `400 SCOPE_UNSUPPORTED_BY_DRIVER`，运行时亦会拒绝未支持行级权限的受控查询。
- 删除仍被会话引用的数据源必须返回 `409`；成功后清理 schema 缓存/pool/授权。
- schema 快照是元数据，不是安全边界：表名/列名可以出现在 prompt 里，但行数据仍然必须走 `db_query`。
- 轻量语义层与 Few-Shot 示例库通过 `createSemanticExtension` 在 `before_agent_start` 钩子按当前提问召回启用中的指标、关联与最多 3 条验证 SQL 示例（并记录命中次数）。每条入库的 SQL 示例在保存时必须通过对应驱动方言的 `guardSql` 只读校验并提取引用表；当数据源启用行级数据权限时，为非管理员过滤掉任何涉及未开放/拒绝表或未识别出表名的示例、指标与关联，绝不借语义层或 Few-Shot 泄露受限表名。
- 管理员可在语义层页面查看该数据源下用户的点赞/点踩反馈及对应 SQL，支持一键纠错并沉淀为 SQL 示例（自动将关联反馈标为 `promoted`）或直接标记忽略。
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
| 驱动插件未安装/已卸载 | 列表返回 `driverAvailable: false`；测试返回 `503 DRIVER_NOT_INSTALLED`，查询/刷新 fail-closed 拒绝 |
| 驱动不支持行级权限 | 启用/预览返回 `400 SCOPE_UNSUPPORTED_BY_DRIVER`，受控查询 fail-closed 拒绝 |
| 删除正在使用的数据源 | `409`；不要静默级联 |

## 验证

```bash
pnpm exec vitest run packages/datasource-sdk/test/sdk.test.ts \
  apps/server/test/datasource-plugins.test.ts \
  apps/server/test/datasource.test.ts \
  apps/server/test/datasource-schema.test.ts \
  apps/server/test/schema-refresh.test.ts \
  apps/server/test/db-schema-lazy.test.ts \
  apps/server/test/probe.test.ts \
  apps/server/test/introspect.test.ts
RUN_DB_TESTS=1 pnpm exec vitest run apps/server/test/introspect.integration.test.ts
```

连接/安全改动需要真实的 MySQL/PostgreSQL 探测测试。缓存改动需要 stale 回退测试，证明旧快照不会被删除。
