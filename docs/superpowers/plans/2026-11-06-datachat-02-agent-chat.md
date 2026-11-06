# DataChat Plan 2 — Pi Agent 运行时与聊天页

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已完成的 foundation（认证、数据源、SQL 守卫/执行器、artifact、审计）之上，接入 Pi SDK 与硅基流动模型，实现「多轮会话 + 流式回答 + 工具调用 + 结果表格」的可用 Web 聊天产品。

**Architecture:** Fastify 进程内为每个会话持有一个 Pi `AgentSession`；自定义工具闭包绑定 `userId/conversationId/datasourceId`，模型无法选择数据源；Pi 事件流经事件桥落 `run_events` 并以 SSE 广播；React SPA 消费 SSE 渲染消息、工具卡片与结果表格。

**Tech Stack:** 现有 foundation + `@earendil-works/pi-coding-agent@1.5.0`、`typebox`、React 19、Vite 6、Tailwind 3.4、TanStack Query/Table/Virtual、react-markdown、rehype-highlight。

---

## Phase 0 — 已完成的冒烟结论（2026-11-06，真实 key）

已用 `ModelRuntime` + `createAgentSession` + 自定义 `db_query` 工具完成端到端验证：

- `deepseek-ai/DeepSeek-V3.2`：tool_calls ✅，流式文本 ✅，usage ✅（默认模型）。
- `deepseek-ai/DeepSeek-V4-Pro`：tool_calls ✅（2.4s）。
- `Qwen/Qwen3.8-27B`：tool_calls ✅（3.9s）。
- `zai-org/GLM-5.3`：tool_calls ✅（1.1s）。
- `moonshotai/Kimi-K2.7-Code`：tool_calls ✅（2.7s）。

`models.json` 的 `apiKey: "$SILICONFLOW_API_KEY"` 插值有效；`getAvailable()` 会同时列出本机其他 provider，因此 DataChat 必须只暴露自己的白名单。

依赖已加入 `apps/server/package.json`：`@earendil-works/pi-coding-agent@1.5.0`、`typebox`。

---

## 通用约束

- 所有新代码在 `G:/dev_directory/ai/datachat`，分支 `feat/foundation`。
- 服务端 ESM + `.js` 后缀导入；测试用 `apps/server/test/helpers/app.ts`（无则新建）构造 `buildApp`，复用 `testConfig`。
- 每个 Task 结束：目标测试 + `pnpm typecheck` 绿，单独 commit。
- 不修改 `docs/specs`、本计划；不改 Plan 1 已有对外契约，除非任务明确要求。
- 真实模型调用只放在手动冒烟（Task 9），单测一律 fake/mock，避免 CI 依赖 key。
- 中文 UI 文案；服务端错误沿用 `{ error: { code, message } }`。

---

## Task 1: 模型目录与运行时引导

**Files**
- Create: `agent/models.json`
- Create: `apps/server/src/agent/model-runtime.ts`
- Create: `apps/server/src/routes/models.ts`
- Modify: `apps/server/src/config.ts`（新增 `agentDir`）
- Modify: `apps/server/src/app.ts`（注册路由）
- Test: `apps/server/test/model-runtime.test.ts`、`apps/server/test/models-route.test.ts`

**Interfaces**

```ts
// agent/model-runtime.ts
export interface ChatModelInfo {
  id: string; name: string; contextWindow: number; maxTokens: number;
}
export function createAgentModelRuntime(config: AppConfig): Promise<ModelRuntime>;
export function listChatModels(runtime: ModelRuntime): ChatModelInfo[];
export function resolveChatModel(runtime: ModelRuntime, id: string): Model;
export const DEFAULT_MODEL_CANDIDATE = "deepseek-ai/DeepSeek-V3.2";
```

- `AppConfig` 增加 `agentDir: string` = `path.resolve(REPO_ROOT, "agent")`，`agentAuthPath` = `path.join(dataDir, "agent", "auth.json")`。
- `createAgentModelRuntime`：确保 `dataDir/agent` 存在，若 `auth.json` 不存在写 `{}`；`ModelRuntime.create({ authPath, modelsPath: path.join(config.agentDir, "models.json") })`。
- `listChatModels` 只列 `provider === "siliconflow"`，按 models.json 顺序；`resolveChatModel` 找不到返回 `undefined` 并由路由 400 `MODEL_NOT_FOUND`。

**`agent/models.json`**（4 个已验证模型；成本为 0，UI 不显示金额）

```json
{
  "providers": {
    "siliconflow": {
      "name": "SiliconFlow",
      "baseUrl": "https://api.siliconflow.cn/v1",
      "api": "openai-completions",
      "apiKey": "$SILICONFLOW_API_KEY",
      "models": [
        { "id": "deepseek-ai/DeepSeek-V3.2", "name": "DeepSeek V3.2", "input": ["text"], "contextWindow": 128000, "maxTokens": 8192, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
        { "id": "zai-org/GLM-5.3", "name": "GLM-5.3", "input": ["text"], "contextWindow": 128000, "maxTokens": 8192, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
        { "id": "Qwen/Qwen3.8-27B", "name": "Qwen3.8 27B", "input": ["text"], "contextWindow": 128000, "maxTokens": 8192, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
        { "id": "moonshotai/Kimi-K2.7-Code", "name": "Kimi K2.7 Code", "input": ["text"], "contextWindow": 128000, "maxTokens": 8192, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
      ]
    }
  }
}
```

**Route:** `GET /api/models`（authenticate）→ `{ models: ChatModelInfo[], defaultId }`；`SILICONFLOW_API_KEY` 未配置时返回 `configured:false` 且 models 为空，不报 500。

**Tests**
- models.json 可被 `ModelRuntime` 解析，4 个模型可 `getModel`。
- `listChatModels` 不含其他 provider。
- 无 key 路由仍 200 且 `configured:false`。
- `resolveChatModel` 未知 id 返回 undefined。

**Commit:** `feat: add siliconflow model catalog and runtime`

---

## Task 2: 会话 / 运行 / 事件仓储

**Files**
- Create: `apps/server/src/db/repositories/conversations.ts`
- Create: `apps/server/src/db/repositories/runs.ts`
- Create: `apps/server/src/db/repositories/run-events.ts`
- Modify: `packages/shared/src/index.ts`（导出事件类型与 zod）
- Create: `packages/shared/src/events.ts`
- Test: `apps/server/test/conversations-repo.test.ts`、`apps/server/test/run-events-repo.test.ts`

**Interfaces**

```ts
// conversations.ts
export interface ConversationRow { /* drizzle $inferSelect */ }
export function createConversation(db: Db, input: { userId: string; datasourceId: string; title?: string; modelId?: string }): ConversationRow;
export function listConversations(db: Db, userId: string, opts?: { limit?: number; before?: number }): ConversationRow[];
export function findConversation(db: Db, id: string): ConversationRow | undefined;
export function findOwnedConversation(db: Db, id: string, userId: string): ConversationRow | undefined;
export function updateConversation(db: Db, id: string, patch: { title?: string; modelId?: string; piSessionFile?: string }): void;
export function touchConversation(db: Db, id: string, at?: number): void;
export function deleteConversation(db: Db, id: string): void;
```

```ts
// runs.ts
export type RunStatus = "queued" | "running" | "ok" | "error" | "aborted";
export interface RunRow { /* ... */ }
export function createRun(db: Db, input: { conversationId: string; userId: string; modelId: string }): RunRow;
export function markRun(db: Db, id: string, patch: { status?: RunStatus; startedAt?: number; endedAt?: number; error?: string | null; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void;
export function findRun(db: Db, id: string): RunRow | undefined;
export function findOwnedRun(db: Db, id: string, userId: string): RunRow | undefined;
export function listQueuedRuns(db: Db, conversationId: string): RunRow[];
```

```ts
// run-events.ts
export function appendRunEvent(db: Db, input: { runId: string; conversationId: string; type: string; payload: unknown }): { seq: number; createdAt: number };
export function listRunEventsAfter(db: Db, runId: string, seq: number): RunEventRow[];
export function listConversationEvents(db: Db, conversationId: string, limit?: number): RunEventRow[];
```

- `appendRunEvent` 在 `db.transaction` 内取 `max(seq)+1`，插入后返回；唯一索引已在 0001。
- 删除会话需级联删除 `runs/run_events/artifacts`（仓储内事务；会话文件由 service 删）。

**`packages/shared/src/events.ts`**：按 spec §5.7 定义 `RunEvent` 判别联合与 zod schema；`type` 与 payload 一一对应；额外加 `assistant_message`（`{content}`，run 结束时落库，供历史聚合）。

**Tests**
- 会话归属校验；列表按 `lastMessageAt` 倒序、cursor。
- run 状态流转；usage 更新。
- 事件 seq 从 1 单调递增、并发 append 不重号（同步 better-sqlite3 下串行）。
- 删除会话后子表为空。

**Commit:** `feat: add conversation run and event repositories`

---

## Task 3: Agent 工具集（schema/query/explain/artifacts/read）

**Files**
- Create: `apps/server/src/agent/tools/context.ts`
- Create: `apps/server/src/agent/tools/db-schema.ts`
- Create: `apps/server/src/agent/tools/db-query.ts`
- Create: `apps/server/src/agent/tools/db-explain.ts`
- Create: `apps/server/src/agent/tools/list-artifacts.ts`
- Create: `apps/server/src/agent/tools/sandbox-read.ts`
- Create: `apps/server/src/agent/tools/index.ts`
- Test: `apps/server/test/tools.test.ts`

**Interfaces**

```ts
export interface AgentToolContext {
  db: Db; config: AppConfig; pools: PoolRegistry; artifacts: ArtifactStore;
  userId: string; conversationId: string; datasourceId: string; runId: string;
  skillsDir: string;                       // data/skills/<conversationId>
}
export function buildAgentTools(ctx: AgentToolContext): ToolDefinition[];
```

- `db_schema`：读 `datasource_schema_cache`；`search?` 匹配表名/列名（不区分大小写），`table?` 精确表；返回 `{tables:[{name,comment,columns:[{name,type,nullable,pk,comment}],fks,indexes}]}`；整体 JSON 截断到 8KB 并带 `truncated:true`。
- `db_query`：参数 `{ sql: string }`；`findDatasource` 后调用 `runGuardedQuery({db,config,pools,artifacts}, {datasource,userId,conversationId,runId,sql})`；成功返回文本 JSON：

```json
{"artifactId":"...","columns":[{"name":"n","type":"number"}],"rowCount":42,"truncated":false,"previewRows":[[42]]}
```

预览最多 20 行（`previewRows.slice(0,20)`），并 `details` 带 `{artifactId, columns, rowCount, truncated, auditId}` 供事件桥映射 `result`；失败返回 `isError` 文本 `{code,message}`（不抛异常穿透）。
- `db_explain`：`guardSql` 通过后调用 `executeReadOnly`，`EXPLAIN` 结果转文本，截断 4KB；不接受模型传 datasource。
- `list_artifacts`：按 `conversationId` 查最近 20 条，返回 `{id,kind,rowCount,truncated,createdAt,columns}`。
- `sandbox-read`：`createReadToolDefinition(skillsDir, { operations: { readFile, access } })`；实现里 `path.resolve` 后必须 `startsWith(skillsDir + sep)`，否则抛 `EACCES`；`detectImageMimeType` 省略（技能都是文本）。
- `buildAgentTools` 只注册 `read`、`db_schema`、`db_query`、`db_explain`、`list_artifacts`（`make_chart`/`create_report` 留 Plan 3）。

**Tests**
- db_query 成功：断言 artifact 归属当前会话、预览 ≤20 行、details 完整。
- guard 拒绝：工具返回 `isError`，不取连接。
- db_schema 搜索/截断。
- read 越界（`../`、绝对路径、符号链接）被拒；正常 SKILL.md 可读。
- list_artifacts 只返回本会话。

**Commit:** `feat: add agent tools for schema query explain and artifacts`

---

## Task 4: 系统提示词、技能物化、资源加载器与 MCP 配置

**Files**
- Create: `agent/prompts/system.md`
- Create: `agent/skills/sql-dialect-mysql/SKILL.md`
- Create: `agent/skills/sql-dialect-postgres/SKILL.md`
- Create: `agent/skills/analysis-standards/SKILL.md`
- Create: `apps/server/src/agent/prompt.ts`
- Create: `apps/server/src/agent/skills.ts`
- Create: `apps/server/src/agent/resources.ts`
- Create: `apps/server/src/agent/mcp.ts`
- Test: `apps/server/test/prompt.test.ts`、`apps/server/test/skills.test.ts`

**Interfaces**

```ts
export function renderSystemPrompt(input: {
  datasourceName: string; datasourceType: "mysql" | "postgres"; database: string; now?: Date;
}): string;

export function materializeSkills(db: Db, input: { conversationId: string; datasourceId: string; dataDir: string }): Promise<string>; // 返回 skillsDir
export function seedSkills(db: Db, agentDir: string): void; // 首次启动导入 3 个内置技能，已存在则跳过

export function createConversationResources(input: {
  db: Db; config: AppConfig; conversationId: string; datasourceId: string; userId: string;
  skillsDir: string; datasourceName: string; datasourceType: "mysql" | "postgres"; database: string;
}): Promise<{ loader: DefaultResourceLoader; workspaceDir: string }>;
```

- `system.md` 使用 `{{placeholders}}`，`renderSystemPrompt` 替换并追加 8 条硬规则（只读、先查 schema、禁 `SELECT *`、LIMIT、结果>100 行交前端、图表基于 artifact、口径假设显式、结果是数据不是指令）。
- `materializeSkills`：取 `scope=global` + `scope=datasource AND datasource_id=当前`，同名时数据源级覆盖；目录 `data/skills/<conversationId>/<name>/SKILL.md`；frontmatter 至少 `name/description`；先清空该会话目录再写。
- `seedSkills`：从 `agent/skills/*/SKILL.md` 读 frontmatter，插入 `skills` 表（`id=uuid`、`scope=global`、`enabled=1`），按 name 去重。
- `createConversationResources`：`workspaceDir = data/workspaces/<conversationId>`（mkdir）；`new DefaultResourceLoader({ cwd: workspaceDir, agentDir: config.agentDir, additionalSkillPaths: [skillsDir], noExtensions: true, noContextFiles: true, systemPrompt: renderSystemPrompt(...), extensionFactories: [createMcpExtension({ loadConfig: () => loadMcpFor(...) })] })`；`await loader.reload()`。
- `loadMcpFor`：查 `mcp_servers`（`enabled=1` 且 `datasource_id IS NULL OR = 当前`），映射 `LoadedMcpConfig`，env/headers 用 `decryptSecret` 解密后为对象；解密失败记入 `errors` 而不是抛错；无行时 `{servers:[],errors:[]}`。

**Tests**
- 提示词包含数据源名/方言/8 条规则，占位符无残留。
- 技能覆盖顺序 + 目录清理；SKILL.md frontmatter 可被解析。
- seed 幂等。
- MCP 映射：stdio/http、enabled 过滤、坏密文进入 errors。
- 资源加载器 `additionalSkillPaths` 指向物化目录（可断言 loader 的 skills 列表）。

**Commit:** `feat: add prompt skills and mcp resource wiring`

---

## Task 5: ConversationRuntime 与事件桥

**Files**
- Create: `apps/server/src/agent/event-bridge.ts`
- Create: `apps/server/src/agent/runtime.ts`
- Create: `apps/server/src/agent/runtime-manager.ts`
- Create: `apps/server/src/agent/session.ts`
- Test: `apps/server/test/runtime.test.ts`、`apps/server/test/event-bridge.test.ts`

**Interfaces**

```ts
// session.ts
export async function createConversationSession(input: {
  db: Db; config: AppConfig; runtime: ModelRuntime;
  conversation: ConversationRow; userId: string; skillsDir: string;
}): Promise<{ session: AgentSession; piSessionFile: string }>;

// event-bridge.ts
export function bridgeSessionEvents(input: {
  db: Db; runId: string; conversationId: string;
  session: AgentSession; emit: (event: RunEvent & { seq: number }) => void;
}): { usage: UsageTotals; stop: () => void };
```

- 会话创建严格按 spec §5.1：`SessionManager.open(piSessionFile)` 或 `SessionManager.create(config.dataDir, path.join(config.dataDir,"pi-sessions",userId))`；创建后把 `session.sessionFile` 写回 `conversations.pi_session_file`；`noTools:"builtin"`、`customTools: buildAgentTools(ctx)`、`await session.bindExtensions()`。
- 事件映射：
  - `message_update` + `assistantMessageEvent.type==="text_delta"` → `text_delta`；`thinking_delta` → `thinking_delta`。
  - `tool_execution_start` → `tool_start`；`tool_execution_end` → `tool_end`（`durationMs` 取事件值或 0，`summary` 从 `result.details` 提取，缺省截断文本 200 字）。
  - `message_end` 且 `message.role==="assistant"` 且 `message.usage` → 累加 usage。
  - `auto_retry_start` → `retry`；`compaction_end` → `compaction`；`agent_end` → 发 `assistant_message`（完整文本）+ `usage` + `run_end`（`willRetry` 时不发 run_end）。
  - `tool_execution_end` 且工具名 `db_query` 成功 → 从 details 发 `result`；`tool_end` 之后发 `sql`（details 有 sql/auditId/status 时）。
- `emit` 先 `appendRunEvent` 再广播；SSE 的 `id` 用 seq。
- `ConversationRuntime`：

```ts
export class ConversationRuntime {
  readonly conversationId: string;
  enqueue(input: { runId: string; content: string }): number; // 返回队列位置
  abort(runId: string): boolean;
  dispose(): Promise<void>;
  get busy(): boolean;
  get queueLength(): number;
}
```

- 队列 FIFO；`enqueue` 后若空闲立即 `void this.drain()`；`drain` 串行执行，单 run 锁；`session.prompt(content)` 前发 `run_start`，`agent_end` 后 `run_end`（bridge 负责），再取下一个。
- `dispose`：`session.abort()` → 等待 idle（最多 5s）→ `session.dispose()`。
- `RuntimeManager`：`getOrCreate(conversation, userId)`、`abort`、`remove(conversationId)`、LRU 20、每 60s 清理 idle>30min；`shutdown()`。
- `buildApp` 增加可选 `agentRuntime?: RuntimeManager`，测试注入 fake；生产在 `index.ts` 创建并在 `onClose` shutdown。

**Tests**
- 用 fake AgentSession（EventEmitter + `prompt` 模拟事件）验证：seq 递增、text_delta 聚合、usage 累加、`tool_end` 触发 `result`。
- 队列：两个 run 串行，第二个先收到 `run_queued`；abort 排队中的 run 发 `run_end(aborted)`。
- LRU 淘汰调用 `dispose`；idle 清理。

**Commit:** `feat: add conversation runtime and event bridge`

---

## Task 6: 会话 / 消息 / SSE 路由

**Files**
- Create: `apps/server/src/routes/conversations.ts`
- Create: `apps/server/src/routes/runs.ts`
- Create: `apps/server/src/services/conversation-service.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/conversations-api.test.ts`、`apps/server/test/runs-sse.test.ts`

**Endpoints**

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/conversations` | 当前用户，`limit`(默认 30,≤100)/`before`，返回 `{items,nextCursor}` |
| POST | `/api/conversations` | `{datasourceId,title?}`；校验授权；`201` |
| GET | `/api/conversations/:id` | 归属校验；返回 `{conversation,messages,artifacts}` |
| PATCH | `/api/conversations/:id` | `{title?}`/`{modelId?}`；modelId 必须在白名单 |
| DELETE | `/api/conversations/:id` | 中止、清队列、dispose、删事件/运行/artifact 文件与行、删 Pi session 文件 |
| POST | `/api/conversations/:id/messages` | `{content}` 1..8000 字；`202 {runId,position}` |
| GET | `/api/runs/:id/stream` | SSE；`Last-Event-ID` 回放；15s 心跳 |
| POST | `/api/runs/:id/abort` | 204 |
| GET | `/api/runs/:id` | `{id,status,usage,error}` |

- `messages` 聚合：按 run 返回 `{runId,status,user:{content},assistant:{content}|null,tools:[...],results:[...],createdAt}`；assistant 文本来自 `assistant_message` 事件，缺省拼接 `text_delta`。
- SSE 头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`；每事件 `id: <seq>\nevent: <type>\ndata: <json>\n\n`；`reply.hijack()` 后直接写 `reply.raw`。
- 回放：`lastId` 从 header 或 `?after=` 取，先写历史事件再订阅；竞态用「先订阅缓冲，再查历史，按 seq 去重」。
- 关闭：客户端断开时移除订阅，不 abort run。
- 首条消息自动标题：取 content 前 40 字（去换行），仅当 title 为空。

**Tests**
- 创建/列表/重命名/删除（级联）。
- 发消息返回 202 与 runId；伪造他人会话 404。
- SSE：注入 fake runtime 发事件，`inject` 读取流并断言 `id/event/data`；`Last-Event-ID` 只回放后续事件。
- 删除会话后 `pi_session_file` 文件被删。

**Commit:** `feat: add conversation message and sse routes`

---

## Task 7: 前端脚手架、登录与应用壳

**Files**
- Create: `apps/web/package.json`、`vite.config.ts`、`tsconfig.json`、`index.html`、`postcss.config.js`、`tailwind.config.ts`
- Create: `apps/web/src/main.tsx`、`App.tsx`、`index.css`
- Create: `apps/web/src/lib/{api.ts,query.ts,utils.ts}`
- Create: `apps/web/src/components/ui/{button,input,textarea,spinner}.tsx`
- Create: `apps/web/src/pages/LoginPage.tsx`
- Create: `apps/web/src/components/AppShell.tsx`
- Test: `apps/web/src/pages/LoginPage.test.tsx`、`apps/web/src/lib/api.test.ts`

**Setup**
- 根 `pnpm-workspace.yaml` 已含 `apps/*`；新增 `apps/web` 后 `pnpm install`。
- 依赖：`react react-dom react-router-dom @tanstack/react-query react-markdown remark-gfm rehype-highlight highlight.js clsx tailwind-merge lucide-react`；dev：`vite @vitejs/plugin-react typescript tailwindcss postcss autoprefixer vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom`。
- `vite.config.ts`：`server.proxy["/api"] = "http://localhost:8080"`；`test.environment="jsdom"`、`setupFiles`。
- `api.ts`：`fetch` 包一层，`credentials:"include"`，非 2xx 抛 `ApiError{code,message,status}`；401 → 清 query 并跳 `/login`（由 `query.ts` 的 error handler 处理）。

**Pages**
- `/login`：用户名/密码，提交 `POST /api/auth/login` → `GET /api/auth/me` 写入 query cache → 跳 `/chat`；错误内联展示；Enter 提交。
- `AppShell`：左侧会话列表占位 + 当前用户 + 退出；`/chat` 路由懒加载聊天页（Task 8）。
- 受保护路由：`GET /api/auth/me` 401 时重定向。

**Tests**
- api 错误映射；401 触发跳转。
- 登录表单成功/失败（mock fetch）。

**Commit:** `feat: add web app shell with login`

---

## Task 8: 聊天页、流式渲染与结果表格

**Files**
- Create: `apps/web/src/pages/ChatPage.tsx`
- Create: `apps/web/src/components/chat/{MessageList,MessageItem,Composer,RunStatus,ToolCard,SqlCard,ResultTable,ConversationSidebar}.tsx`
- Create: `apps/web/src/hooks/useRunStream.ts`
- Create: `apps/web/src/lib/run-events.ts`（reducer）
- Test: `apps/web/src/lib/run-events.test.ts`、`apps/web/src/components/chat/ResultTable.test.tsx`

**Data flow**
- `useRunStream(runId)`：`new EventSource(`/api/runs/${runId}/stream`)`；对事件类型列表逐个 `addEventListener`；reducer 状态 `{status, text, thinking, tools, sqls, results, error, queuePosition}`；`run_end` 后 `queryClient.invalidateQueries(["conversation", id])` 并关闭。
- 断线：`onerror` 指数退避重连（1s/2s/4s，最多 5 次），保留 `Last-Event-ID`（浏览器自动带；手动重连时拼 `?after=lastSeq`）。
- 发送：`POST /messages` → 拿 runId → 乐观插入用户消息 → 打开流；同一会话只允许一个 active run，输入框禁用 + “停止”。
- 消息渲染：用户气泡；助手 Markdown（`react-markdown` + `remark-gfm` + `rehype-highlight`）；`text_delta` 追加；thinking 折叠；`tool_start/tool_end` 渲染工具卡片（名称、参数折叠、耗时、错误）；`sql` 渲染 SQL 卡片（复制按钮）；`result` 渲染表格。
- 表格：TanStack Table；列头类型对齐（number 右对齐）；`∅` 显示空值；默认 100 行；`rowCount>100` 显示“加载更多”（`GET /api/artifacts/:id/rows?offset&limit`，Plan 3 前先用事件内 preview 行，超过时提示“完整结果在导出中提供”）。
- 顶栏：数据源名、模型下拉（`GET /api/models`，切换 `PATCH /conversations/:id`）、分享按钮占位。
- 侧边栏：会话列表、新建（先选数据源对话框；无授权提示联系管理员）、重命名、删除。

**Tests**
- reducer：text 拼接、tool 生命周期、sql/result 去重、run_end 状态。
- 表格：空值、数字对齐、加载更多按钮出现条件（用假数据）。
- 发送流程：mock fetch + 假 EventSource，断言乐观消息与最终文本。

**Commit:** `feat: add chat page with streaming and result tables`

---

## Task 9: 端到端联调与真实模型冒烟

**Files**
- Create: `scripts/smoke-agent.mjs`（不入库密钥；读 `.env`）
- Modify: `README.md`（启动步骤、模型白名单、冒烟说明）
- Test: `apps/server/test/agent-e2e.test.ts`（fake runtime，全链路）

**Steps**
1. `pnpm install && pnpm verify` 全绿。
2. 启动 `pnpm --filter @datachat/server dev` + `pnpm --filter @datachat/web dev`；浏览器手工路径：登录 → 新建会话（选测试库）→ 问“users 表有多少行” → 看到 SQL 卡片 + 表格 + 中文结论；追问“按角色分组”验证多轮；点停止验证 abort。
3. `scripts/smoke-agent.mjs`：直接调用真实硅基流动，断言 4 个模型 tool_calls 可用（无 key 时 skip 并打印提示）。
4. 记录一条真实 run 的 `run_events`（seq/type）与 `query_audit` 证据到最终报告。

**Commit:** `chore: verify agent chat end to end`

---

## 风险与预案

- **Pi 事件差异**：`message_end.usage` 字段若缺失，usage 记 0 并在 UI 隐藏；以 `agent_end` 兜底发 `run_end`。
- **SSE 代理缓冲**：Vite dev 已关闭缓冲；生产 Nginx 需 `proxy_buffering off`（Plan 4）。
- **Docker 不可用**：真实 MySQL/PG 查询用 mock 驱动验证工具链路；手工冒烟需用户提供测试库（`.env` 的 `SMOKE_*`）。
- **模型兼容**：新增模型必须先跑 tool-call 冒烟再加入 `models.json`；失败模型从白名单移除。
- **上下文长度**：Pi 自动压缩；`run_events` 的 `compaction` 事件透传给前端显示提示。

---

## 验收标准（Plan 2 完成）

- [ ] 登录后能新建会话、选数据源、发消息，收到流式中文回答。
- [ ] 模型触发 `db_query`，前端出现 SQL 卡片与结果表格，数据与库一致。
- [ ] 多轮追问保持上下文；停止按钮能中止当前 run。
- [ ] 刷新页面后历史消息与结果可恢复（来自 `run_events`/artifacts）。
- [ ] 4 个白名单模型 tool-call 冒烟通过；无 key 时服务可启动但聊天页提示配置。
- [ ] `pnpm verify` 绿；新增测试覆盖 reducer、SSE 回放、工具沙箱、队列。
