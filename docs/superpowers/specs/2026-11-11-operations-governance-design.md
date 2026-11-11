# 运行治理：数据保留、运行指标与备份恢复

- 日期：2026-11-11
- 状态：设计已确认，待实现
- 相关计划：`docs/superpowers/plans/2026-11-11-operations-governance.md`

## 1. 问题

DataChat 已经把会话、运行事件、查询结果 artifact、审计和报告都落在 `DATA_DIR`，但缺少日常运维能力：

- 历史会话与 artifact 只增不减，SQLite 与磁盘会持续增长；
- 管理员看不到运行成功率、耗时、token 趋势，也看不出哪些数据源在失败；
- 备份/恢复没有标准命令，升级或迁移时只能手工拷贝，且容易漏掉 WAL、artifact 或 Pi session。

本次补齐三件事：**可控的数据保留**、**只读运行指标**、**CLI 备份/恢复**。

## 2. 目标与非目标

### 目标

- 管理员可以预览“超过保留天数会被删除什么”，确认后再执行；默认不自动删除。
- 有未过期分享链接的会话不会被清理；运行中的会话跳过。
- 管理员可查看最近 7/30/90 天的运行、失败、耗时、token、数据源维度指标。
- 提供可重复、可校验的备份/恢复命令，覆盖 DB 与运行所需文件。
- 不新增外部服务、不新增数据库表；沿用 SQLite/settings/CLI 模式。

### 非目标

- 不做对象存储、增量备份、异地备份、自动上传。
- 不做金额成本估算（需要维护每个模型的价格）。
- 不做容量阈值清理；只按天数。
- 不做 Prometheus/Grafana 集成。
- 不改变现有会话删除、分享、报告的产品语义。

## 3. 关键决策

| 决策 | 结论 |
| --- | --- |
| 默认保留行为 | 会话/审计保留天数默认 `0`（关闭），只手动预览后执行 |
| 分享冲突 | 有未过期、未撤销分享的会话跳过，等分享过期后再清理 |
| 指标范围 | 运行与查询指标，不含成本 |
| 备份形式 | CLI + 文档；运维页只展示命令与最近备份，不提供下载 |
| 调度 | 可选 `RETENTION_SWEEP_HOURS`，默认 0 关闭 |
| 新增表 | 无；保留天数存 `settings`，运维动作记 `query_audit` |

## 4. 架构

```
apps/server/src/
  services/ops-retention.ts   # 预览/执行/定时调度
  services/ops-metrics.ts     # 指标聚合
  services/ops-backup.ts      # 备份/恢复/清单校验
  routes/ops.ts               # /api/admin/ops/*
  scripts/ops-backup.ts       # pnpm ops:backup
  scripts/ops-restore.ts      # pnpm ops:restore
apps/web/src/
  pages/admin/OpsPage.tsx     # /admin/ops
  lib/api.ts                  # 类型与请求
```

- 路由只做鉴权、参数校验和调用服务；删除/统计逻辑集中在 service，便于单测。
- 备份/恢复不经过 HTTP，避免在浏览器传输包含加密密钥的完整数据。
- 定时任务在 `index.ts` 启动，复用同一个 retention service 实例，`app.onClose` 清理 interval。

## 5. 数据保留

### 5.1 设置

新增两个 `settings` key（复用 `app-settings.ts` 的 schema/save/effective 模式）：

| key | 类型 | 默认 | 范围 |
| --- | --- | --- | --- |
| `retentionConversationDays` | integer | 0 | 0–3650，0=关闭 |
| `retentionAuditDays` | integer | 0 | 0–3650，0=关闭 |

`GET /api/admin/ops/retention` 返回当前值和 `sweepHours`；`PUT` 严格校验并保存。两个都为 0 时，预览/执行返回 400 `RETENTION_DISABLED`。

### 5.2 预览

`POST /api/admin/ops/retention/preview`（无 body，使用已保存设置）返回：

```ts
interface RetentionPreview {
  conversationDays: number;
  auditDays: number;
  conversationCutoff: number | null;
  auditCutoff: number | null;
  conversations: {
    eligible: number;        // 超过天数的会话总数（含后续会跳过的）
    willDelete: number;      // eligible - skippedActiveShares - skippedBusy
    skippedActiveShares: number;
    skippedBusy: number;
    runs: number;
    events: number;
    artifacts: number;
    artifactBytes: number;
    reports: number;
    shares: number;
  };
  auditRows: number;
  oldestEligibleAt: number | null;
  newestEligibleAt: number | null;
}
```

- 会话到期判断：`COALESCE(last_message_at, created_at) < now - days*86400000`。
- “活跃分享”：`shares.conversation_id = ? AND revoked_at IS NULL AND expires_at > now`；关联报告的分享同样算活跃。
- `skippedBusy` 通过 `runtime.isBusy(conversationId)` 统计。
- `runs/events/artifacts/reports/shares/artifactBytes` 只统计 `willDelete` 的会话。
- `artifactBytes` 对 `storage_path` 做 `stat`；文件不存在按 0。
- 预览严格只读：不删文件、不写审计、不调用 runtime。

### 5.3 执行

`POST /api/admin/ops/retention/run`，body `{ "confirm": true }`。执行时**重新计算**到期集合，避免预览后数据变化。

单个会话删除顺序：

1. 再次检查活跃分享、runtime busy；命中则跳过并计数。
2. `runtime.remove(conversationId)`。
3. `deleteConversationFiles(artifacts, conversation)` 删除 artifact 文件。
4. 安全删除 `piSessionFile`（必须在 `DATA_DIR` 内）与 `DATA_DIR/skills/<conversationId>`。
5. 事务删除：`run_events` → `runs` → `artifacts` → 关联 `shares`（含 report 分享）→ `reports` → `conversations`。

审计清理：删除 `query_audit.created_at < auditCutoff` 的行。若保留天数很小，本次新增的 `ops` 审计也可能在下次被清理，这是预期行为。

返回：

```ts
interface RetentionRunResult {
  deletedConversations: number;
  deletedRuns: number;
  deletedEvents: number;
  deletedArtifacts: number;
  deletedReports: number;
  deletedShares: number;
  deletedAuditRows: number;
  skippedActiveShares: number;
  skippedBusy: number;
  errors: Array<{ conversationId: string; message: string }>;
  durationMs: number;
}
```

- 单个会话失败不中断整体，错误写入 `errors`，其余继续；有错误时仍返回 200，但写一条 `status=error` 的 ops 审计。
- 服务内 `running` 标志防重入；并发执行返回 409 `RETENTION_RUNNING`。
- 写一条 `query_audit`：`action="ops"`、`status="ok"|"error"`、`sql_text="retention"`、`detail_json` 保存参数与结果摘要、`duration_ms`。

### 5.4 自动清理

`RETENTION_SWEEP_HOURS`（config，默认 0）：

- `>0` 时启动 `setInterval(hours*3600000)`，interval `.unref()`；服务关闭时 `clearInterval`。
- 每次执行读取最新设置；任一保留天数为 0 时跳过对应类别。
- 结果写日志 + ops 审计；失败只记日志，不影响服务。

## 6. 运行指标

`GET /api/admin/ops/metrics?days=7|30|90`（也允许 1–365）。只读，不缓存。

```ts
interface OpsMetrics {
  range: { days: number; from: number; to: number };
  totals: {
    runs: number;
    ok: number;
    error: number;
    aborted: number;
    queuedOrRunning: number;
    successRate: number;       // ok / (ok+error+aborted)，无终态时为 0
    p50Ms: number;
    p95Ms: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    activeUsers: number;
  };
  daily: Array<{
    date: string;              // UTC YYYY-MM-DD
    runs: number;
    ok: number;
    error: number;
    aborted: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  datasources: Array<{
    datasourceId: string;
    name: string;
    runs: number;
    failed: number;
  }>;                          // 按 runs 降序，最多 8 个
  queries: {
    total: number;
    rejected: number;
    error: number;
    timeout: number;
    averageRows: number | null; // 仅 status=ok
  };
}
```

口径：

- 运行按 `runs.created_at` 落在范围内；状态统计全部状态。
- 耗时只取 `started_at != null && ended_at != null && ended_at >= started_at` 的 `ended_at-started_at`。
- P50/P95：排序后取 `ceil(p*n)-1`，空数组为 0。
- 成功率为 0 时前端显示 `—`，不显示误导的 0%。
- 日序列补齐范围内每一天（无数据为 0），日期按 UTC；前端按本地日期展示。
- 数据源维度 join `conversations.datasource_id`，已删除数据源显示 `已删除的数据源`。
- 查询统计来自 `query_audit`，`averageRows` 仅 `status=ok AND row_count IS NOT NULL`。

## 7. 备份与恢复

### 7.1 备份

`pnpm ops:backup [--output <dir>]`：

- 源：`config.dataDir`；目标默认 `DATA_DIR/backups/backup-YYYYMMDD-HHmmss`。
- DB：通过 better-sqlite3 `.backup(destination)` 生成一致性副本（包含 WAL 内容）。
- 文件：复制 `artifacts/`、`pi-sessions/`、`skills/`、`agent/`（存在才复制）。
- 不复制：`.env`、日志、`backups/` 自身。
- 写 `manifest.json`：

```json
{
  "version": 1,
  "createdAt": 1760000000000,
  "appVersion": "0.1.0",
  "files": 123,
  "bytes": 4567890,
  "dbSha256": "…",
  "entries": ["datachat.db", "artifacts", "pi-sessions", "skills", "agent"]
}
```

- 输出目标必须不存在或为空；拒绝把目标放在 `artifacts/` 等被复制目录内。
- 服务运行时允许执行；DB 一致，文件采用尽力复制，文档建议低峰/停写。

### 7.2 恢复

`pnpm ops:restore --from <backup-dir> --yes`：

1. 校验 `manifest.json` 的 `version===1`、必需条目存在，且 `dbSha256` 与备份 DB 一致。
2. 对备份 `datachat.db` 执行 `PRAGMA integrity_check`，失败即中止。

只复制白名单条目（`datachat.db`、`artifacts`、`pi-sessions`、`skills`、`agent`），不按 manifest 数组做任意路径拼接。
3. 先把备份内容复制到系统临时目录的 staging 目录，避免备份本身位于 `DATA_DIR/backups` 时被后续移动。
4. 确认目标 `DATA_DIR` 当前内容整体移动到**同级**的 `restore-rollback-YYYYMMDD-HHmmss`（不能放在 `DATA_DIR` 内，否则会被再次备份/恢复）。
5. 把 staging 内容复制到 `DATA_DIR`；任一步失败则回滚移动并保留现场。
6. 成功打印回滚目录与服务重启提示，清理 staging。

`DATA_DIR` 内已有的 `backups/` 也会随当前内容一起移动到回滚目录，不会丢失；恢复完成后如需保留旧备份，可从回滚目录取回。

约束：恢复必须使用与备份时相同的 `APP_SECRET`，否则数据源密码/模型 Key 无法解密；恢复前必须停止服务（Windows 上 DB 被占用会失败并提示）。恢复只覆盖数据文件，不包含 `.env`/`APP_SECRET`，部署方需自行保证环境变量一致。

### 7.3 备份列表

`GET /api/admin/ops/backups` 读取 `DATA_DIR/backups/*/manifest.json`，返回：

```ts
Array<{ name: string; createdAt: number; files: number; bytes: number }>
```

- 只返回通过 manifest 校验的目录，按时间倒序，最多 20 条。
- 不返回文件内容，不接受任意路径参数。

## 8. 管理界面

新增 `/admin/ops`，左侧“管理”导航增加“运维”，仅管理员可见。页面分三块：

1. **运行指标**：7/30/90 切换；卡片（总运行、成功率、P95、token、活跃用户）；按天 CSS 柱状条；Top 数据源表；查询审计摘要。
2. **数据保留**：两个天数输入（0=关闭）；“预览影响”后展示会话/run/artifact/字节/审计/跳过数；确认对话框后“执行清理”；显示最近一次结果。
3. **备份**：展示 `pnpm ops:backup` / `pnpm ops:restore` 命令与最近备份列表（名称、时间、大小）。

交互要求：

- 预览/执行/保存按钮有 loading 与错误提示；执行按钮在预览前禁用。
- 所有危险操作使用现有 Dialog 二次确认；文案明确“不可撤销”。
- 空数据、加载失败有独立状态，不把失败显示成 0。

## 9. 审计

- `query_audit.action` 增加 `ops`，shared/web 类型与 `AUDIT_ACTION_LABELS` 增加“运维操作”。
- 保留操作记录参数、删除计数、跳过原因摘要；不记录文件内容。
- 备份/恢复是 CLI，不写 `query_audit`；由 shell 历史/运维文档承担，避免 CLI 直接写库造成锁竞争。

## 10. 错误处理

| 场景 | 行为 |
| --- | --- |
| 保留关闭 | 400 `RETENTION_DISABLED` |
| 正在执行 | 409 `RETENTION_RUNNING` |
| 参数非法 | 400 `VALIDATION` |
| 单个会话删除失败 | 继续，汇总到 `errors` |
| 指标范围非法 | 400 `VALIDATION`（days 1–365） |
| 备份目录已存在/非空 | CLI 退出 1，不覆盖 |
| 恢复校验失败 | 退出 1，目标数据不变 |
| 恢复中途失败 | 回滚已移动的当前数据，退出 1 |

## 11. 测试

- `ops-retention.test.ts`：预览只读；过期会话被删；活跃分享跳过；busy 跳过；报告/分享清理；审计按天删除；重入 409；单会话错误继续。
- `ops-metrics.test.ts`：状态计数、成功率、P50/P95、token 汇总、日序列补零、Top 数据源、查询审计统计、空数据。
- `ops-backup.test.ts`：备份 DB+artifact、manifest、恢复后数据一致、完整性校验失败、非空目标拒绝、路径越界拒绝。
- `routes/ops.test.ts`：管理员鉴权、参数校验、预览/执行/指标/备份列表。
- `OpsPage.test.tsx`：加载/空态/预览/确认执行/指标渲染。
- 回归：`pnpm verify`；备份/恢复在临时目录实测。

## 12. 验收标准

- [ ] 默认设置下不会自动删除任何数据。
- [ ] 预览数字与实际执行一致；活跃分享、运行中会话明确跳过。
- [ ] 清理后分享/报告无孤儿；审计可按天数清理。
- [ ] 指标页数字与手工 SQL 一致；空数据不显示 0%。
- [ ] 备份可在服务运行时完成；恢复到空目录后 DB、会话、artifact 可读。
- [ ] 恢复缺少相同 `APP_SECRET` 的限制在文档中明确。
- [ ] `pnpm verify` 全绿，新增测试覆盖上述路径。

## 13. 工作量

- 保留服务/接口/页面：约 1 天
- 指标聚合/页面：约 0.5 天
- 备份/恢复与测试：约 0.5 天
- 合计约 2 天（含验证与文档）。
