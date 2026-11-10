# 体验增强：失败恢复与新手引导 设计

日期：2026-11-10
状态：已确认设计，待实现

## 1. 目标

让第一次使用 DataChat 的用户不再卡在“没有 schema / 不会建会话”，让失败的问答可以一键重试，且历史、分享、报告中不出现重复问题。

验收标准：

1. `/chat` 空态可直接选择有权限的数据源，点击示例立即创建会话并提问。
2. 数据源没有 schema 缓存或缓存超过 24 小时时，首次 `db_schema` 自动刷新，普通用户无需管理员操作。
3. 失败或中止的问答下方有“重试”“换模型重试”；成功后旧失败轮次从会话详情消失，新轮次正常流式展示。
4. `pnpm verify` 全绿，新增测试覆盖服务端重试与 schema 懒刷新、前端空态与重试操作。

## 2. 非目标

- 不调整运行队列并发模型（仍为单飞 FIFO）。
- 不按 schema 动态生成示例问题。
- 不把“运行成功但回答为空/答非所问”判为失败。
- 不清理历史失败轮次的物理数据（保留用于排查，仅从会话详情隐藏）。

## 3. 新手空态

### 3.1 交互

`/chat` 无会话时展示：

- 数据源选择器：只列出 `listDatasources` 返回的、当前用户可访问的数据源；默认选中第一个。
- 3 张可点击示例卡：
  1. 这个库有哪些表？各自是做什么的？
  2. 找一张核心业务表，看看最近 10 条数据。
  3. 用最近 12 个月的数据做一个趋势分析。
- 输入框在选中数据源后立即可用；占位文案提示“选择一个数据源后直接提问”。
- 没有可用数据源时：管理员显示“去添加数据源”链接（`/admin/datasources`），普通用户显示“请联系管理员开通数据源权限”。

点击示例或发送输入框内容时：

1. `createConversation({ datasourceId })`
2. `sendMessage(conversationId, { content })`
3. 成功后 `invalidateQueries(conversations)` 并 `navigate('/chat/:id')`
4. 第 2 步失败：尽力删除刚创建的空会话，留在空态并展示错误，避免产生空会话。

创建与发送期间输入框、示例、发送按钮禁用，显示“正在创建会话…”。

### 3.2 组件边界

- `ChatPage`：持有 `newDatasourceId`、启动 mutation、错误状态；把数据源与回调传给 `MessageList`。
- `MessageList` → `EmptyChat`：接收 `datasources`、`selectedDatasourceId`、`onSelectDatasource`、`onExample`、`starting`、`disabled`。
- `Composer`：新增 `placeholder` 可选属性；空态下 `conversationReady` 改为“有会话且已加载”或“无会话但已选数据源”。

## 4. Schema 懒刷新

### 4.1 服务

新增 `apps/server/src/services/schema-refresh.ts`：

```ts
export interface SchemaRefreshDeps {
  db: Db;
  pools: PoolRegistry;
  config: AppConfig;
}

export async function refreshDatasourceSchema(
  deps: SchemaRefreshDeps,
  datasource: DatasourceRow,
): Promise<SchemaSnapshot>;
```

职责：

- 用 `deriveSecretKey(config.appSecret)` 和 `decryptSecret` 组装连接。
- `pools.get(connection)`，按 `datasource.type` 调 `introspectMysql` 或 `introspectPostgres`。
- 成功 `saveSchema`；失败 `saveSchemaError(db, id, safeErrorMessage(error, password))` 后抛出带安全信息的错误。
- 同一数据源并发调用复用同一个 Promise（模块级 `Map<datasourceId, Promise<SchemaSnapshot>>`，完成后删除）。

原 `POST /api/datasources/:id/refresh-schema` 改为调用该服务，响应与错误码保持不变（502 `DS_UNREACHABLE`）。

### 4.2 `db_schema` 行为

`apps/server/src/agent/tools/db-schema.ts`：

- 权限校验不变。
- `entry = loadSchemaEntry`：
  - 没有 `entry` 或 `entry.snapshot` 无效：等待 `refreshDatasourceSchema`，成功用新快照；失败返回 `SCHEMA_UNAVAILABLE`，message 包含安全错误和“请检查数据源连接或联系管理员”。
  - 有快照且 `Date.now() - entry.refreshedAt > SCHEMA_CACHE_TTL_MS`：先尝试刷新；刷新失败则**继续使用旧快照**（不阻塞提问），仅在 details 中带 `stale: true`。
  - 有快照且未过期：直接使用。
- 返回结构保持 `tableCount/returned/truncated`，可选 `stale`。

## 5. 失败恢复

### 5.1 数据模型

新增迁移 `0008_retry_of_run.sql`：

```sql
ALTER TABLE `runs` ADD `retry_of_run_id` text;
```

`apps/server/src/db/schema.ts` 的 `runs` 增加可空列 `retryOfRunId`，不加索引（按会话查询已有索引）。

`CreateRunInput` 增加 `retryOfRunId?: string | null`，`createRun` 写入。

### 5.2 重试接口

`POST /api/runs/:id/retry`，需登录，返回 202：

```json
{ "runId": "新运行 id", "position": 1 }
```

校验顺序：

1. `id` 非 UUID → 400 `VALIDATION`。
2. `findOwnedRun` 不存在 → 404 `NOT_FOUND`。
3. 状态不是 `error`/`aborted` → 409 `RUN_NOT_RETRYABLE`。
4. 已存在 `retryOfRunId = 旧 id` 的运行 → 409 `RETRY_EXISTS`（防止双击/并发）。
5. 旧运行没有 `user_message` 事件 → 409 `RUN_NOT_RETRYABLE`。
6. 旧事件带 `skill`，但该技能已被删除/禁用 → 409 `SKILL_UNAVAILABLE`。
7. 队列长度 ≥ 5 → 429 `RATE_LIMITED`。

通过后：

- 取旧 `user_message` 的 `content`、`skill`；技能存在则 `composeSkillInstruction` 重新生成 prompt。
- 使用会话当前 `modelId`（支持“换模型重试”：前端先 PATCH 会话）。
- `createRun({ conversationId, userId, modelId, retryOfRunId: old.id })`。
- `runtime.enqueue({ runId, content: promptContent, displayContent: content, skill })`。
- 入队失败与原发送接口一致：run 标记 error，写 `run_end` 事件并发布。

抽取共用的入队 helper（`apps/server/src/services/message-service.ts`），消息发送与重试共用“建 run → 入队 → 入队失败兜底”逻辑；发送接口的标题生成只保留在原路径。

### 5.3 历史过滤

`apps/server/src/db/repositories/runs.ts` 增加：

```ts
export function listRetriedRunIds(db: Db, conversationId: string): Set<string>;
```

查询该会话所有非空 `retryOfRunId`。

`getConversationDetail`：

- 跳过 `retriedRunIds.has(group.runId)` 的消息组。
- 过滤 `artifacts` 中 `runId` 属于该集合的记录。
- `activeRun` 仍取新 run（queued/running）。

旧 run 行与事件保留，审计与排查仍可查。

### 5.4 前端

`apps/web/src/lib/api.ts` 增加 `retryRun(runId): Promise<{ runId: string; position: number }>`。

`MessageItem`：

- `status === "error"` 或 `"aborted"` 时显示操作条；即使已有部分 assistant 文本也显示错误信息。
- “重试”按钮：`onRetry(runId)`。
- “换模型重试”：模型下拉（仅当 `models.length > 0`），选中后 `onRetry(runId, modelId)`。
- `retryingRunId` 匹配时两个按钮禁用并显示“重试中…”。

`ChatPage`：

- `retryMutation`：如需换模型先 `updateConversation(conversationId, { modelId })`，再 `retryRun(runId)`。
- 成功后把旧消息的 `user.content/skill` 设为 `optimisticText/optimisticSkill`，`setActiveRunId(新 runId)`，并 invalidate 会话详情。
- 失败在操作条附近展示错误，不清空输入。

发送接口失败横幅增加“重试”按钮：复用上次 `content/skill` 再次调用 `sendMutation`。

## 6. 错误处理

- 重试失败按错误码显示中文：`RUN_NOT_RETRYABLE`“该轮对话无法重试”、`RETRY_EXISTS`“已在重试中”、`RATE_LIMITED`“排队消息过多，请稍后再试”。
- Schema 刷新失败不抛到 Fastify 全局处理器；`db_schema` 返回 `isError` 工具结果，模型可向用户解释。
- 空态创建成功但发送失败时删除会话失败不阻塞错误提示，仅记录日志。

## 7. 测试

服务端：

- `retry` 路由：成功创建新 run 且带 `retryOfRunId`、旧 run 在详情中被隐藏、旧 artifact 被过滤；非 error/aborted 409；他人 run 404；重复重试 409；技能重组；队列满 429。
- schema 懒刷新：无缓存时刷新后返回表；刷新失败返回 `SCHEMA_UNAVAILABLE`；过期但刷新失败回退旧快照；并发请求只 introspect 一次。
- 迁移测试更新到 8 条。

前端：

- `EmptyChat`：无数据源提示；选择数据源后示例可点击；点击示例回调内容。
- `MessageItem`：error/aborted 显示操作条；点击重试/换模型回调参数正确；重试中禁用。
- `ChatPage`：空态启动调用 create → send → navigate；发送失败删除会话。
- `pnpm verify` 全绿。

## 8. 交付顺序

1. Schema 刷新服务 + `db_schema` 懒刷新 + 测试。
2. 迁移、重试接口、历史过滤 + 测试。
3. 前端空态、重试操作条、发送失败重试 + 测试。
4. 全量验证、真实场景手测、文档更新。
