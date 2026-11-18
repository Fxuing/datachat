# SQL、artifact 与审计

所有面向用户的查询都必须经过同一条受守卫的路径。本文覆盖 SQL 边界和保存结果的文件；prompt 写法和聊天渲染见 [聊天界面](chat-ui.md)。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 守卫 | 解析/白名单校验语句、拒绝写入/系统访问、注入带上限的 limit | [`guard.ts`](../../apps/server/src/agent/sql/guard.ts) |
| 执行器 | 在只读 pool 上执行一条语句、流式返回行、执行超时/中止 | [`executor.ts`](../../apps/server/src/agent/sql/executor.ts) |
| 查询服务 | 授权、读取设置、守卫、范围改写、执行、写 snapshot/artifact、记审计 | [`query-service.ts`](../../apps/server/src/services/query-service.ts) |
| 范围改写 | 按部门策略包派生表并绑定过滤参数 | [`scope.ts`](../../apps/server/src/agent/sql/scope.ts)、[`data-scope.ts` 服务](../../apps/server/src/services/data-scope.ts) |
| Artifact 存储 | JSONL 行 + 元数据；图表 spec；读取/预览/导出 | [`artifacts.ts`](../../apps/server/src/services/artifacts.ts) |
| 审计 | 为 ok/rejected/error 写 `query_audit` | [`audit.ts`](../../apps/server/src/services/audit.ts) |
| 导出 HTTP | 授权、流式发送、完成后审计 | [`artifacts.ts` 路由](../../apps/server/src/routes/artifacts.ts) |
| 图表工具 | 从结果 artifact 构建图表 spec | [`make-chart.ts`](../../apps/server/src/agent/tools/make-chart.ts) |

限制（`maxRows`、`previewRows`、`timeoutMs`）来自应用设置，通过 `resolveQueryLimits` 解析；每次查询读一次，这样设置修改会在下一轮生效。数据源连接在存储时加密，只在查询路径内解密。

## 运行路径

```text
tool/route
  → authorizeDatasourceAccess(user, datasource)
  → resolveQueryLimits()
  → guardSql({ sql, dialect, maxRows })
      ├─ rejected → audit(rejected) → errorResult（不建连接、不访问 pool）
      └─ ok
  → applyScopeToSql({ datasourceId, mode, userId, sql, dialect })
      ├─ scope 错误 → audit(rejected, scopeReason) → errorResult（不建连接）
      └─ ok → { sql: executableSql, params, snapshot }
  → saveRunScopeSnapshot(db, runId, snapshot)
  → ArtifactStore.openResult()
  → executeReadOnly(pool, executableSql, limits, signal, onRow, params)
  → writer.finish({ columns, rowCount, truncated })
  → audit(ok, duration, rowCount)
  → { artifactId, columns, previewRows, rowCount, truncated, guardedSql }
```

- `guardSql` 只允许只读语句类型；拒绝写入/DDL、系统 schema、锁、hint、危险函数和过多表。它返回实际发送的 SQL，包括注入的 limit。
- `executeReadOnly` 使用数据源的只读 pool，把每一行流式写给 artifact writer，内存只保留预览窗口。`rowCount` 统计所有返回行；`truncated` 表示是否碰到上限。
- 被拒绝的查询会带原因写审计，并且从不建立连接。行级范围错误同样在取连接前返回，审计的 `scope_reason` 记录具体错误码；成功查询若发生改写，`scope_reason = "SCOPED"`。
- artifact 落盘完成后才写审计。审计失败不能删除或作废已经成功的结果。

## Artifact 契约

- `artifacts.kind` 为 `result` 或 `chart`。结果行保存在 `DATA_DIR/artifacts/*.jsonl`（视情况 gzip）；SQLite 存 id、属主、会话/run、列、行数、截断标记、相对存储路径和时间戳。
- 值会针对 BigInt、Date、Buffer、Decimal 和非有限数字做编码/解码（`encodeValue`/`decodeValue`）。不要直接对驱动返回的行做 `JSON.stringify`。
- 预览行是给 UI 的有界切片。完整行通过 artifact API 分页读取；导出直接流式发送文件。
- artifact 按 `userId` 作用域，并可选按会话/run 作用域。下载或图表必须校验访问权；绝不能接受任意文件路径。
- 图表输入有上限（`MAX_CHART_INPUT_ROWS = 50_000`），且只读取结果 artifact。图表 spec 作为 `kind=chart` 的 artifact 保存，不存成 SQLite 行数据。
- 删除会话/用户时清理 artifact 文件和记录；不要留下孤儿文件。

## 审计契约

`query_audit` 记录用户、数据源、会话/run、动作（`query`/`explain` 等）、SQL 文本、状态（`ok`/`rejected`/`error`）、行数、耗时、错误信息，以及可空的 `scope_reason`（错误码或 `SCOPED`）。审计行只追加；不要把成功记录改成拒绝。管理端审计页/分页读取这些行；索引和筛选条件要保持稳定。

## 失败行为

- 守卫拒绝：稳定错误码（如 `SQL_NOT_ALLOWED`）、可读原因、审计行、不建立连接。
- 数据源未验证/非只读：默认拒绝，除非显式 `allowWriteAccount`；即便如此也只执行只读语句。
- 超时/中止：执行器抛类型化错误；artifact writer 被中止，部分文件按一致规则删除或收尾。
- 导出断线：流清理会执行，并且只写一条 `ok` 或 `error` 审计。
- artifact JSON/列格式损坏：返回受控错误；不要让详情页崩溃。

## 验证

```bash
pnpm exec vitest run apps/server/test/query-service.test.ts \
  apps/server/test/query-service.artifacts.test.ts \
  apps/server/test/sql/guard.test.ts \
  apps/server/test/artifacts.test.ts \
  apps/server/test/artifacts-api.test.ts \
  apps/server/test/charts.test.ts \
  apps/server/test/make-chart-tool.test.ts
RUN_DB_TESTS=1 pnpm exec vitest run apps/server/test/query-service.integration.test.ts \
  apps/server/test/sql/executor.integration.test.ts
```

新增方言/语句形态时，要加守卫测试和真实数据库集成用例。新增 artifact 消费端时，要测跨用户/导出拒绝路径。
