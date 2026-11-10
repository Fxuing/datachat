# 体验增强（失败恢复与新手引导）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让空态可直接选数据源开始提问、schema 缺失自动刷新、失败轮次可原地重试并支持换模型。

**Architecture:** 新增 schema 刷新服务供路由与 `db_schema` 工具复用；重试通过 `runs.retry_of_run_id` 关联新 run，会话详情过滤被替换的旧 run；前端空态新增数据源选择与启动流程，错误消息新增重试操作条。

**Tech Stack:** Fastify 5、Drizzle/SQLite、Pi SDK、React 19、TanStack Query、Vitest、Testing Library。

**Spec:** `docs/superpowers/specs/2026-11-10-experience-recovery-onboarding-design.md`

---

### Task 1: Schema 刷新服务

**Files:**
- Create: `apps/server/src/services/schema-refresh.ts`
- Modify: `apps/server/src/routes/datasource-schema.ts`
- Test: `apps/server/test/schema-refresh.test.ts`

- [x] **Step 1: 写失败测试**：用假的 `pools.get` 返回 `{ introspect: ... }` 不现实；改为对服务暴露 `introspect` 注入点，测试并发去重与成功写缓存。
- [x] **Step 2: 实现服务**：

```ts
const inFlight = new Map<string, Promise<SchemaSnapshot>>();

export interface SchemaRefreshDeps {
  db: Db;
  pools: PoolRegistry;
  config: AppConfig;
  /** Test seam; defaults to the real MySQL/PostgreSQL introspection. */
  introspect?: (datasource: DatasourceRow, connection: ConnectionConfig) => Promise<SchemaSnapshot>;
}

export async function refreshDatasourceSchema(
  deps: SchemaRefreshDeps,
  datasource: DatasourceRow,
): Promise<SchemaSnapshot> {
  const running = inFlight.get(datasource.id);
  if (running) return running;
  const task = (async () => {
    const key = deriveSecretKey(deps.config.appSecret);
    const connection = {...};
    try {
      const snapshot = deps.introspect
        ? await deps.introspect(datasource, connection)
        : datasource.type === "mysql"
          ? await introspectMysql(deps.pools.get(connection).mysql!, datasource.database)
          : await introspectPostgres(deps.pools.get(connection).pg!);
      saveSchema(deps.db, datasource.id, snapshot);
      return snapshot;
    } catch (error) {
      saveSchemaError(deps.db, datasource.id, safeErrorMessage(error, connection.password));
      throw error;
    }
  })().finally(() => inFlight.delete(datasource.id));
  inFlight.set(datasource.id, task);
  return task;
}
```

- [x] **Step 3: 路由改为调用服务**，保持 502/`DS_UNREACHABLE` 响应。
- [x] **Step 4: 跑测试** `pnpm vitest run apps/server/test/schema-refresh.test.ts apps/server/test/datasource-schema-api.test.ts`。
- [x] **Step 5: Commit** `feat(server): add reusable datasource schema refresh service`。

### Task 2: `db_schema` 懒刷新

**Files:**
- Modify: `apps/server/src/agent/tools/db-schema.ts`
- Test: `apps/server/test/db-schema-tool.test.ts`

- [x] **Step 1: 写失败测试**：无缓存时工具返回表；刷新抛错时 `isError` 且 code `SCHEMA_UNAVAILABLE`；过期快照刷新失败仍返回旧表并 `stale: true`。
- [x] **Step 2: 实现**：

```ts
let entry = loadSchemaEntry(ctx.db, ctx.datasourceId);
const expired = entry ? Date.now() - entry.refreshedAt > SCHEMA_CACHE_TTL_MS : false;
if (!entry || expired) {
  try {
    const snapshot = await refreshDatasourceSchema(ctx, datasource);
    entry = loadSchemaEntry(ctx.db, ctx.datasourceId) ?? { snapshot, ... };
    stale = expired;
  } catch (error) {
    if (!entry) return errorResult("SCHEMA_UNAVAILABLE", ...);
    stale = true;
  }
}
```

需要按 id 查 datasource；`authorizeDatasourceAccess` 已保证存在，但服务签名要 `DatasourceRow`，用 `findDatasource`。
- [x] **Step 3: 扩展 `DbSchemaDetails` 增加 `stale?: boolean`，返回 details 同步。**
- [x] **Step 4: 跑测试并 Commit** `feat(server): refresh schema lazily from db_schema`。

### Task 3: 重试数据模型与历史过滤

**Files:**
- Create: `apps/server/drizzle/0008_retry_of_run.sql`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/repositories/runs.ts`
- Modify: `apps/server/src/services/conversation-service.ts`
- Test: `apps/server/test/db.test.ts`、`apps/server/test/conversation-detail.test.ts`（新建）

- [x] **Step 1: 添加迁移与列**：

```sql
ALTER TABLE `runs` ADD `retry_of_run_id` text;
```

journal 追加 `{ idx: 8, version: "6", when: 1793945000000, tag: "0008_retry_of_run", breakpoints: true }`。
- [x] **Step 2: `runs` schema 增加 `retryOfRunId: text("retry_of_run_id")`；`CreateRunInput`/`createRun` 透传。**
- [x] **Step 3: 添加 `listRetriedRunIds(db, conversationId): Set<string>`（`isNotNull(runs.retryOfRunId)`）。**
- [x] **Step 4: `getConversationDetail` 跳过被重试的 group 与 artifacts。**
- [x] **Step 5: 测试迁移数量 8、旧 run 隐藏、artifact 过滤。**
- [x] **Step 6: Commit** `feat(server): link retried runs and hide replaced turns`。

### Task 4: 共用入队与重试接口

**Files:**
- Create: `apps/server/src/services/message-service.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Modify: `apps/server/src/routes/runs.ts`
- Test: `apps/server/test/retry-api.test.ts`

- [x] **Step 1: 抽取 `enqueueRun`**：

```ts
export interface EnqueueRunInput {
  conversation: ConversationRow;
  userId: string;
  content: string;      // display content
  promptContent: string;
  skill?: string;
  retryOfRunId?: string;
}

export function enqueueRun(
  deps: { db: Db; runtime: RuntimeManager },
  input: EnqueueRunInput,
): { ok: true; runId: string; position: number } | { ok: false; code: "RATE_LIMITED"; message: string } {
  if (deps.runtime...queueLength >= 5) return ...;
  const run = createRun(...);
  ...
  try { position = runtime.enqueue(...) } catch { markRun error; append run_end; publish; return {ok:true,...} }
}
```

注意：现有发送路径 `await opts.runtime.getOrCreate` 之后才检查队列；helper 保留该顺序。入队失败时仍返回 runId（run 已标记 error）。
- [x] **Step 2: 会话路由改用 helper，行为不变。**
- [x] **Step 3: 重试路由**：

```ts
app.post("/api/runs/:id/retry", { preHandler: app.authenticate }, async (request, reply) => {
  const run = findOwnedRun(...);
  if (!run) return 404;
  if (run.status !== "error" && run.status !== "aborted") return 409 RUN_NOT_RETRYABLE;
  if (findRetryOf(db, run.id)) return 409 RETRY_EXISTS;
  const old = findUserMessageEvent(db, run.id);
  const conversation = findOwnedConversation(...);
  ...
  const skill = old.payload.skill ? findApplicableSkill(...) : undefined;
  if (old.payload.skill && !skill) return 409 SKILL_UNAVAILABLE;
  const outcome = enqueueRun(...);
  if (!outcome.ok) return 429;
  return reply.code(202).send({ runId: outcome.runId, position: outcome.position });
});
```

需要新增 `findUserMessageEvent(db, runId)` / `findRetryOf(db, runId)` 到 runs/run-events 仓库。
- [x] **Step 4: 测试**：成功、404、409 状态、409 重复、技能重组、旧轮次隐藏。
- [x] **Step 5: Commit** `feat(server): add retry endpoint for failed runs`。

### Task 5: 前端重试操作条

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/components/chat/RetryActions.tsx`
- Modify: `apps/web/src/components/chat/MessageItem.tsx`
- Modify: `apps/web/src/components/chat/MessageList.tsx`
- Modify: `apps/web/src/pages/ChatPage.tsx`
- Test: `apps/web/src/components/chat/RetryActions.test.tsx`、`MessageItem.test.tsx`

- [x] **Step 1: api 增加 `retryRun(runId)`。**
- [x] **Step 2: `RetryActions`**：重试按钮 + 模型选择（`Select` 或 Popover），`retrying` 禁用。
- [x] **Step 3: `MessageItem`** 在 error/aborted 时渲染操作条，即使有部分文本；传递 `models/onRetry/retrying`。
- [x] **Step 4: `MessageList` 透传新 props。**
- [x] **Step 5: `ChatPage` retryMutation**：可选先 PATCH 模型，再 retry；成功设置乐观消息与新 `activeRunId`，invalidate 详情；错误显示。
- [x] **Step 6: 测试并 Commit** `feat(web): add retry and model-switch actions`。

### Task 6: 空态新手引导与发送失败重试

**Files:**
- Modify: `apps/web/src/components/chat/MessageList.tsx`
- Modify: `apps/web/src/components/chat/Composer.tsx`
- Modify: `apps/web/src/pages/ChatPage.tsx`
- Test: `apps/web/src/components/chat/MessageList.test.tsx`、`apps/web/src/pages/ChatPage.test.tsx`（新建）

- [x] **Step 1: `EmptyChat` 接收数据源/回调**，示例改成 3 个通用问题并可点击，无数据源时展示角色化引导。
- [x] **Step 2: `Composer` 支持 `placeholder`；空态 `conversationReady` 逻辑调整。**
- [x] **Step 3: `ChatPage` 启动流程**：`createConversation` → `sendMessage` → navigate；失败时尽力 `deleteConversation`；期间禁用并显示状态。
- [x] **Step 4: 发送失败横幅加重试**：保存 `lastSend`（content/skill），按钮再次 `sendMutation`。
- [x] **Step 5: 测试空态选择/示例、启动失败清理。**
- [x] **Step 6: Commit** `feat(web): start chats from the empty state`。

### Task 7: 全量验证与手测

- [x] **Step 1:** `pnpm verify`（typecheck + 全部测试）。
- [x] **Step 2:** 构建并启动 dev server，手测：
  - 无会话选数据源 → 点示例 → 自动建会话并回答。
  - 禁用模型制造失败 → 重试 → 旧轮次消失、新轮次成功。
  - 换模型重试。
  - 新数据源不刷新 schema 直接提问。
- [x] **Step 3:** 更新 README 功能说明（如涉及）。
- [x] **Step 4:** Commit 并 push。
