# 运行治理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为 DataChat 增加可控的会话/审计保留、管理员运行指标页、以及可校验的 CLI 备份/恢复。

**Architecture:** 复用现有 SQLite、`settings` 与 admin 路由模式。保留与指标逻辑放在 `apps/server/src/services/ops-*.ts`，路由只做鉴权/校验；备份/恢复是独立 CLI，不经过 HTTP。前端新增 `/admin/ops`，复用现有卡片、Dialog、Select 与 react-query 模式。

**Tech Stack:** TypeScript ESM、Fastify 5、Drizzle + better-sqlite3、Vitest、React 19 + TanStack Query、Tailwind、Radix Dialog。

**Spec:** `docs/superpowers/specs/2026-11-11-operations-governance-design.md`

---

## File Map

| 文件 | 责任 |
| --- | --- |
| `apps/server/src/services/app-settings.ts` | 新增保留天数设置 key/schema/default |
| `apps/server/src/db/schema.ts` | `query_audit.action` 增加 `ops` |
| `apps/server/src/services/audit.ts` | `AuditAction` 增加 `ops` |
| `apps/server/src/services/ops-retention.ts` | 预览、执行、重入锁、审计记录 |
| `apps/server/src/services/ops-metrics.ts` | 指标聚合 |
| `apps/server/src/services/ops-backup.ts` | 备份/恢复/清单校验 |
| `apps/server/src/routes/ops.ts` | `/api/admin/ops/*` |
| `apps/server/scripts/ops-backup.ts` | `pnpm ops:backup` |
| `apps/server/scripts/ops-restore.ts` | `pnpm ops:restore` |
| `apps/server/src/app.ts` | 注册 ops 路由 |
| `apps/server/src/index.ts` | 创建 retention service、可选定时器 |
| `apps/server/src/config.ts` | `RETENTION_SWEEP_HOURS` |
| `apps/web/src/lib/api.ts` | API 类型与请求 |
| `apps/web/src/pages/admin/OpsPage.tsx` | 运维页 |
| `apps/web/src/App.tsx` / `components/AppShell.tsx` | 路由与导航 |
| `apps/web/src/components/admin/AuditDetailDrawer.tsx` | `ops` 标签 |
| `README.md` / `docs/roadmap.md` | 使用说明与状态 |

---

### Task 1: 保留设置与 ops 审计类型

**Files:**
- Modify: `apps/server/src/services/app-settings.ts`
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/services/audit.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/components/admin/AuditDetailDrawer.tsx`
- Test: `apps/server/test/ops-settings.test.ts`

- [x] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { effectiveSettings, saveSettings } from "../src/services/app-settings.js";
import { testConfig } from "./helpers/config.js";

describe("retention settings", () => {
  it("defaults to disabled and persists overrides", () => {
    const handle = createDb(":memory:");
    migrateDb(handle.db);
    expect(effectiveSettings(handle.db, testConfig).retentionConversationDays).toBe(0);
    saveSettings(handle.db, { retentionConversationDays: 90, retentionAuditDays: 180 });
    const saved = effectiveSettings(handle.db, testConfig);
    expect(saved.retentionConversationDays).toBe(90);
    expect(saved.retentionAuditDays).toBe(180);
    handle.sqlite.close();
  });
});
```

- [x] **Step 2: 运行并确认失败**

Run: `pnpm vitest run apps/server/test/ops-settings.test.ts`
Expected: FAIL，`retentionConversationDays` 不存在。

- [x] **Step 3: 实现设置**

在 `SETTING_KEYS` 追加两个 key；在 `settingValueSchemas` 增加：

```ts
retentionConversationDays: z.number().int().min(0).max(3650),
retentionAuditDays: z.number().int().min(0).max(3650),
```

在 `AppSettings`/`defaultSettings`/`effectiveSettings` 增加同名字段（默认 0）。

- [x] **Step 4: 增加 ops 审计动作**

- `apps/server/src/db/schema.ts` 的 `queryAudit.action.enum` 追加 `"ops"`。
- `apps/server/src/services/audit.ts` 的 `AuditAction` 追加 `"ops"`。
- `apps/web/src/lib/api.ts` 的 `AuditActionValue` 追加 `"ops"`。
- `AuditDetailDrawer.tsx` 的 `AUDIT_ACTION_LABELS` 增加 `ops: "运维操作"`。

无需 migration：`action` 列为 text，没有 DB CHECK。

- [x] **Step 5: 验证并提交**

Run: `pnpm vitest run apps/server/test/ops-settings.test.ts && pnpm --filter @datachat/server typecheck && pnpm --filter @datachat/web typecheck`
Expected: PASS。

```bash
git add apps/server/src/services/app-settings.ts apps/server/src/db/schema.ts apps/server/src/services/audit.ts apps/server/test/ops-settings.test.ts apps/web/src/lib/api.ts apps/web/src/components/admin/AuditDetailDrawer.tsx
git commit -m "feat(ops): add retention settings and ops audit action"
```

---

### Task 2: 保留预览与执行服务

**Files:**
- Create: `apps/server/src/services/ops-retention.ts`
- Test: `apps/server/test/ops-retention.test.ts`

**接口：**

```ts
export interface RetentionPreview {
  conversationDays: number;
  auditDays: number;
  conversationCutoff: number | null;
  auditCutoff: number | null;
  conversations: {
    eligible: number;
    willDelete: number;
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

export interface RetentionRunResult {
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

export interface RetentionService {
  preview(): Promise<RetentionPreview>;
  run(actorUserId: string | null): Promise<RetentionRunResult>;
  isRunning(): boolean;
}

export function createRetentionService(input: {
  db: Db;
  config: AppConfig;
  runtime: Pick<RuntimeManager, "isBusy" | "remove">;
  artifacts: ArtifactStore;
  now?: () => number;
}): RetentionService;
```

- [x] **Step 1: 写服务测试**

在 `ops-retention.test.ts` 创建内存 DB、临时 `DATA_DIR`、user/datasource、两个会话（一个 40 天前、一个今天）、run/event/artifact 文件；配置 `retentionConversationDays=30`、`retentionAuditDays=30`。至少覆盖：

```ts
it("previews without deleting and removes only expired conversations", async () => {
  const preview = await service.preview();
  expect(preview.conversations.eligible).toBe(1);
  expect(fs.existsSync(oldArtifact)).toBe(true);
  const result = await service.run(userId);
  expect(result.deletedConversations).toBe(1);
  expect(fs.existsSync(oldArtifact)).toBe(false);
  expect(db.select().from(conversations).all()).toHaveLength(1);
});

it("skips a conversation with an active share", async () => { /* share.expiresAt = now + day */ });

it("skips a busy conversation and counts it", async () => { /* runtime.isBusy -> true */ });

it("deletes reports and shares with the conversation", async () => { /* assert rows gone */ });
```

- [x] **Step 2: 运行确认失败**

Run: `pnpm vitest run apps/server/test/ops-retention.test.ts`
Expected: FAIL，模块不存在。

- [x] **Step 3: 实现预览**

1. `cutoff = now - days*86400000`；0 天返回 null 并跳过该类。
2. 查 `conversations`：`coalesce(lastMessageAt, createdAt) < cutoff`。
3. 对每个会话查活跃分享：
   ```ts
   const reportIds = db.select({id: reports.id}).from(reports)
     .where(eq(reports.conversationId, id)).all().map(r => r.id);
   const active = db.select({id: shares.id}).from(shares).where(and(
     or(eq(shares.conversationId, id), reportIds.length ? inArray(shares.reportId, reportIds) : undefined),
     isNull(shares.revokedAt),
     gt(shares.expiresAt, now),
   )).all();
   ```
4. `runtime.isBusy(id)` 统计 busy；仅对 `willDelete` 统计 runs/events/artifacts/reports/shares。
5. `artifactBytes`：`path.resolve(path.join(config.dataDir, "artifacts"), storagePath)`，必须在 root 内，`stat` 失败按 0。

- [x] **Step 4: 实现执行**

```ts
async run(actorUserId) {
  if (running) throw new OpsError("RETENTION_RUNNING", "清理任务正在执行");
  running = true;
  try {
    const preview = await this.preview();
    // 重新读取候选会话，逐条删除
    for (const conversation of candidates) {
      if (await hasActiveShare(...)) { skippedActiveShares++; continue; }
      if (runtime.isBusy(id)) { skippedBusy++; continue; }
      await runtime.remove(id);
      await deleteConversationFiles(artifacts, conversation);
      await rm(piSessionFile, {force:true}); // 校验在 DATA_DIR 内
      await rm(path.join(config.dataDir, "skills", id), {recursive:true, force:true});
      db.transaction(tx => {
        tx.delete(shares).where(or(eq(shares.conversationId,id), reportIds.length ? inArray(shares.reportId,reportIds) : undefined)).run();
        tx.delete(reports).where(eq(reports.conversationId,id)).run();
      });
      deleteConversation(db, id);
    }
    // audit cleanup + recordAudit(action:"ops", sqlText:"retention", detail:{...})
    return result;
  } finally { running = false; }
}
```

单个会话异常 push 到 `errors` 后继续；审计记录用 `recordAudit`。

- [x] **Step 5: 运行测试并提交**

Run: `pnpm vitest run apps/server/test/ops-retention.test.ts`
Expected: PASS。

```bash
git add apps/server/src/services/ops-retention.ts apps/server/test/ops-retention.test.ts
git commit -m "feat(ops): preview and run retention cleanup"
```

---

### Task 3: ops 路由与可选定时清理

**Files:**
- Create: `apps/server/src/routes/ops.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/config.ts`
- Test: `apps/server/test/ops-api.test.ts`

**接口：**

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/admin/ops/metrics?days=30` | 指标（Task 4） |
| GET | `/api/admin/ops/retention` | `{settings, sweepHours}` |
| PUT | `/api/admin/ops/retention` | body `{conversationDays,auditDays}` |
| POST | `/api/admin/ops/retention/preview` | 预览 |
| POST | `/api/admin/ops/retention/run` | body `{confirm:true}` |
| GET | `/api/admin/ops/backups` | 备份列表 |

- [x] **Step 1: 写路由测试**

使用 `buildApp` + admin/user cookie；断言：非管理员 403；PUT 非法值 400；两个天数都为 0 时 preview 400 `RETENTION_DISABLED`；`run` 缺 `confirm` 400；正常 preview 200；执行后审计出现 `action="ops"`。

- [x] **Step 2: 实现路由**

```ts
export interface OpsRoutesOptions {
  db: Db;
  config: AppConfig;
  retention: RetentionService;
}

export async function opsRoutes(app: FastifyInstance, opts: OpsRoutesOptions) {
  app.get("/api/admin/ops/retention", { preHandler: app.requireAdmin }, async () => ({
    settings: {
      conversationDays: effectiveSettings(opts.db, opts.config).retentionConversationDays,
      auditDays: effectiveSettings(opts.db, opts.config).retentionAuditDays,
    },
    sweepHours: opts.config.retentionSweepHours,
  }));

  app.put("/api/admin/ops/retention", { preHandler: app.requireAdmin }, async (request, reply) => {
    /* zod strict 0..3650 -> saveSettings */
  });

  app.post("/api/admin/ops/retention/preview", { preHandler: app.requireAdmin }, async (request, reply) => {
    /* 两个都 0 -> 400 RETENTION_DISABLED；否则 opts.retention.preview() */
  });

  app.post("/api/admin/ops/retention/run", { preHandler: app.requireAdmin }, async (request, reply) => {
    /* confirm === true；running -> 409 */
  });
}
```

- [x] **Step 3: 接入 app/index**

- `BuildAppOptions` 增加 `retention?: RetentionService`；`buildApp` 默认用传入的 `agentRuntime`/`artifacts` 创建。
- `index.ts` 创建 `retention`，传给 `buildApp`。
- 若 `config.retentionSweepHours > 0`：
  ```ts
  const timer = setInterval(() => {
    void retention.run(null).catch((error) => app.log.error({ err: error }, "retention sweep failed"));
  }, config.retentionSweepHours * 3_600_000);
  timer.unref();
  app.addHook("onClose", () => clearInterval(timer));
  ```
- `config.ts` 增加 `retentionSweepHours`，从 `RETENTION_SWEEP_HOURS` 读取，默认 0。

- [x] **Step 4: 验证并提交**

Run: `pnpm vitest run apps/server/test/ops-api.test.ts && pnpm --filter @datachat/server typecheck`
Expected: PASS。

```bash
git add apps/server/src/routes/ops.ts apps/server/src/app.ts apps/server/src/index.ts apps/server/src/config.ts apps/server/test/ops-api.test.ts
git commit -m "feat(ops): expose retention api and optional sweep"
```

---

### Task 4: 运行指标服务与 API

**Files:**
- Create: `apps/server/src/services/ops-metrics.ts`
- Modify: `apps/server/src/routes/ops.ts`
- Test: `apps/server/test/ops-metrics.test.ts`

- [x] **Step 1: 写测试**

Seeded 3 runs：ok（1000ms，10/5 token）、error（3000ms）、aborted（2000ms），跨两天；断言 `runs=3`、`successRate=1/3`、`p50Ms=2000`、`p95Ms=3000`、token 汇总、daily 补零、top datasource。空 DB 断言 successRate 0、p50/p95 0。

- [x] **Step 2: 实现 `getOpsMetrics(db, days, now)`**

按 spec 第 6 节返回结构；日桶用 UTC：

```ts
const day = new Date(run.createdAt).toISOString().slice(0, 10);
```

耗时排序后 `Math.ceil(p * n) - 1`；`queries.averageRows` 仅 `status === "ok"` 且 `rowCount != null`。

- [x] **Step 3: 路由**

`GET /api/admin/ops/metrics` 用 zod 校验 `days` 1–365，默认 30；返回 `{metrics: getOpsMetrics(...)}`。

- [x] **Step 4: 验证并提交**

Run: `pnpm vitest run apps/server/test/ops-metrics.test.ts apps/server/test/ops-api.test.ts`
Expected: PASS。

```bash
git add apps/server/src/services/ops-metrics.ts apps/server/src/routes/ops.ts apps/server/test/ops-metrics.test.ts
git commit -m "feat(ops): aggregate run and query metrics"
```

---

### Task 5: 备份/恢复库与 CLI

**Files:**
- Create: `apps/server/src/services/ops-backup.ts`
- Create: `apps/server/scripts/ops-backup.ts`
- Create: `apps/server/scripts/ops-restore.ts`
- Modify: `package.json`、`apps/server/package.json`
- Test: `apps/server/test/ops-backup.test.ts`

**接口：**

```ts
export interface BackupManifest {
  version: 1;
  createdAt: number;
  appVersion: string;
  files: number;
  bytes: number;
  dbSha256: string;
  entries: string[];
}

export async function createBackup(input: {
  dataDir: string;
  sqlite: Database.Database;
  outputDir?: string;
  now?: number;
}): Promise<{ dir: string; manifest: BackupManifest }>;

export async function listBackups(backupsDir: string): Promise<
  Array<{ name: string; createdAt: number; files: number; bytes: number }>
>;

export async function restoreBackup(input: {
  dataDir: string;
  from: string;
  now?: number;
}): Promise<{ rollbackDir: string }>;
```

- [x] **Step 1: 写测试**

在临时目录创建 `datachat.db`（migrate + 插入 user）、`artifacts/a.txt`；`createBackup` 后断言 manifest/DB/文件存在；修改源 DB 和文件后 `restoreBackup`，断言恢复原值、源文件不存在；篡改 manifest hash 断言抛错；非空输出目录断言拒绝。

- [x] **Step 2: 实现备份**

```ts
const dir = outputDir ?? path.join(dataDir, "backups", stamp);
await fs.mkdir(dir, { recursive: false }); // 已存在则失败
await sqlite.backup(path.join(dir, "datachat.db"));
for (const entry of ["artifacts", "pi-sessions", "skills", "agent"]) {
  const source = path.join(dataDir, entry);
  if (await exists(source)) await fs.cp(source, path.join(dir, entry), { recursive: true });
}
const dbSha256 = await sha256File(path.join(dir, "datachat.db"));
// 统计文件/字节，写 manifest.json
```

- [x] **Step 3: 实现恢复**

按 spec：校验 manifest/hash → `new Database(from/datachat.db,{readonly:true}).pragma("integrity_check")` → staging 到 `os.tmpdir()` → 当前内容移到同级 `restore-rollback-*` → 复制白名单 → 失败回滚。只复制白名单条目，路径必须位于 `from` 内。

- [x] **Step 4: CLI**

`apps/server/scripts/ops-backup.ts`：解析 `--output`，`loadConfig`、`createDb`、`createBackup`、关闭、打印路径。
`apps/server/scripts/ops-restore.ts`：必须 `--from` 与 `--yes`，否则退出 1；调用 restore。
根 scripts：

```json
"ops:backup": "pnpm --filter @datachat/server ops:backup",
"ops:restore": "pnpm --filter @datachat/server ops:restore"
```

server scripts：

```json
"ops:backup": "tsx --env-file-if-exists=../../.env scripts/ops-backup.ts",
"ops:restore": "tsx --env-file-if-exists=../../.env scripts/ops-restore.ts"
```

- [x] **Step 5: 验证并提交**

Run: `pnpm vitest run apps/server/test/ops-backup.test.ts`
Expected: PASS。

```bash
git add apps/server/src/services/ops-backup.ts apps/server/scripts/ops-backup.ts apps/server/scripts/ops-restore.ts apps/server/test/ops-backup.test.ts package.json apps/server/package.json
git commit -m "feat(ops): add verified backup and restore commands"
```

---

### Task 6: 运维页与导航

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/pages/admin/OpsPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Test: `apps/web/src/pages/admin/OpsPage.test.tsx`

- [x] **Step 1: 写 API 类型/函数**

```ts
export interface OpsMetrics { /* 与 spec 第 6 节一致 */ }
export interface RetentionPreview { /* 与 spec 5.2 一致 */ }
export interface RetentionRunResult { /* 与 spec 5.3 一致 */ }
export interface BackupInfo { name: string; createdAt: number; files: number; bytes: number }

export function getOpsMetrics(days: number): Promise<{ metrics: OpsMetrics }>;
export function getRetentionSettings(): Promise<{ settings: { conversationDays: number; auditDays: number }; sweepHours: number }>;
export function updateRetentionSettings(input: { conversationDays: number; auditDays: number }): Promise<void>;
export function previewRetention(): Promise<RetentionPreview>;
export function runRetention(): Promise<RetentionRunResult>;
export function listBackups(): Promise<{ backups: BackupInfo[] }>;
```

- [x] **Step 2: 写页面测试**

mock `../lib/api`；断言：渲染指标卡片；切换到 90 天调用 `getOpsMetrics(90)`；输入天数后“预览影响”显示会话/artifact/跳过数；“执行清理”先弹确认框，确认后调用 `runRetention`；备份列表展示最近备份；失败态显示错误而非 0。

- [x] **Step 3: 实现页面**

区块：

1. 指标：`useQuery(["ops-metrics", days])`；7/30/90 按钮；卡片 + daily CSS 柱状条 + 数据源表。
2. 保留：`useQuery(["ops-retention"])`；两个 number 输入；保存 mutation；预览 mutation；确认 Dialog；结果摘要。
3. 备份：`useQuery(["ops-backups"])`；代码块展示 `pnpm ops:backup` / `pnpm ops:restore --from <dir> --yes`；列表展示名称/时间/大小。

- [x] **Step 4: 路由与导航**

- `App.tsx` 懒加载 `OpsPage`，增加 `/admin/ops` + `RequireAdmin`。
- `AppShell.tsx` adminLinks 增加 `{ to: "/admin/ops", label: "运维", icon: Wrench }`（`Wrench` 从 lucide-react 导入）。

- [x] **Step 5: 验证并提交**

Run: `pnpm --filter @datachat/web test -- OpsPage && pnpm --filter @datachat/web typecheck`
Expected: PASS。

```bash
git add apps/web/src/lib/api.ts apps/web/src/pages/admin/OpsPage.tsx apps/web/src/pages/admin/OpsPage.test.tsx apps/web/src/App.tsx apps/web/src/components/AppShell.tsx
git commit -m "feat(web): add operations dashboard"
```

---

### Task 7: 文档、端到端验证与推送

**Files:**
- Modify: `README.md`
- Modify: `docs/roadmap.md`
- Modify: `.env.example`

- [x] **Step 1: 文档**

README 增加：
- 环境变量 `RETENTION_SWEEP_HOURS`（默认 0）。
- “运维”章节：保留策略、指标、`pnpm ops:backup`/`ops:restore`、`APP_SECRET` 约束、停服恢复。
- 已知限制更新：备份为本地全量、不是增量；恢复要求同密钥。

`.env.example` 增加：
```dotenv
RETENTION_SWEEP_HOURS=0
```

roadmap 把“运行治理”勾为完成，记录测试与命令。

- [x] **Step 2: 全量验证**

Run: `pnpm verify`
Expected: typecheck/build 通过，server + web 测试全绿。

- [x] **Step 3: 手工冒烟**

- 启动 dev，登录 `/admin/ops`：指标加载；设置保留天数并预览；不执行（避免删除真实数据）。
- 在临时 `DATA_DIR` 上执行 `pnpm ops:backup`，检查 manifest；在另一个临时目录恢复并启动确认。
- 验证非管理员访问 `/admin/ops` 跳转 `/chat`。

- [x] **Step 4: 提交与推送**

```bash
git add README.md docs/roadmap.md .env.example
git commit -m "docs: document operations governance"
git push origin main
```

---

## Self-Review

- Spec 覆盖：保留（Task 1–3）、指标（Task 4）、备份恢复（Task 5）、页面（Task 6）、文档/验收（Task 7）。
- 无 TBD/TODO；所有新增类型都在任务中定义。
- 关键一致性：`RetentionPreview.conversations.willDelete`、`RetentionService.run(actorUserId)`、`OpsMetrics.range.days` 在路由与页面中保持一致。
- 风险点：retention 删除报告/分享的事务顺序；备份恢复的 staging/回滚；`ops` 审计无 migration。实现时用测试锁定。
