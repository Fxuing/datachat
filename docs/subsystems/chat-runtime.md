# 聊天运行时：队列、会话、事件与 SSE

一个会话拥有一个 Pi 会话，并且一次只跑一轮。本文覆盖服务端从 `POST /api/conversations/:id/messages` 到持久化运行事件和实时 SSE 流的路径。Prompt/技能内容和 SQL 执行分别在其他参考里。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 入队 | 创建 run、拒绝满队列、返回位置 | [`conversations.ts`](../../apps/server/src/routes/conversations.ts)、[`RuntimeManager`](../../apps/server/src/agent/runtime.ts) |
| 单会话队列 | 串行执行 run、保留 Pi 会话、中止/释放 | [`ConversationRuntime`](../../apps/server/src/agent/runtime.ts) |
| 会话 | 解析模型/资源、构建工具、绑定扩展 | [`session.ts`](../../apps/server/src/agent/session.ts)、[`resources.ts`](../../apps/server/src/agent/resources.ts) |
| 事件桥 | 把 Pi 事件转换成共享 `RunEvent`、持久化、发布 | [`event-bridge.ts`](../../apps/server/src/agent/event-bridge.ts)、[`event-bus.ts`](../../apps/server/src/agent/event-bus.ts) |
| 回放 | 按序号读取 `run_events` | [`run-events.ts`](../../apps/server/src/db/repositories/run-events.ts) |
| SSE | 先回放再订阅、保活、清理 | [`runs.ts`](../../apps/server/src/routes/runs.ts) |
| Web 消费端 | 重连并合并实时/历史状态 | [`useRunStream.ts`](../../apps/web/src/hooks/useRunStream.ts) |
| 建议追问 | 按需生成并缓存 `runs.suggestions_json` | [`suggestions.ts`](../../apps/server/src/services/suggestions.ts)、[`runs.ts`](../../apps/server/src/routes/runs.ts) |

`runs` 行保存状态/用量/错误；`run_events` 是持久事件日志。`RunEventBus` 只在进程内有效，不是事实来源。

## 运行路径

1. 路由校验会话归属、数据源权限、技能有效性和队列容量，然后创建 `runs` 行并调用 `runtime.enqueue()`。
2. `ConversationRuntime` 发出 `run_queued`，立即返回位置（HTTP 202）。同一会话已有活跃 run 时排队；不同会话可以并行。
3. 第一轮时，`createConversationSession()` 解析模型、物化技能/资源、构建工具上下文并创建 Pi 会话。该会话会保留给后续轮次。
4. 每次 prompt 前，runtime 把 `toolContext.runId` 设为当前 run。这样工具写入的 artifact/审计/事件属于本轮，而不是某个被捕获的旧 run。
5. `EventBridge` 订阅 Pi 事件，把支持的事件映射成 `RunEvent`，逐条追加到 `run_events`，再发布到事件总线。
6. SSE 端点（`GET /api/runs/:id/stream`）校验归属，按 `Last-Event-ID`/`after` 回放事件，然后订阅实时事件。保活消息防止代理关闭空闲连接。
7. 进入终止状态时，runtime 写入 `runs.status`、`endedAt`、用量/错误，并发出最终的 `run_end`；随后释放队列，并可能触发记忆提取。

## 契约

- **每个会话同一时间只有一个活跃 run。** 不要直接调用 `session.prompt()`，也不要为同一会话创建第二个 runtime。
- **`runId` 是每轮 prompt 的状态。** `AgentToolContext` 跨 run 共享；每次 prompt 前更新它，绝不要在工具工厂里捕获一次。
- **所有终止路径都必须发出 `run_end`。** 成功、模型错误、工具错误、中止、超时和 dispose 都需要终止事件；否则 UI 会一直显示流式状态。
- **事件必须可序列化、可回放。** 新事件类型要加入 `packages/shared/src/events.ts`，在 `event-bridge.ts` 映射、持久化，并由 `useRunStream`/UI 处理。其中 `create_excel` 工具完成后由 `event-bridge.ts` 映射并持久化 `excel` 事件（仅携带 `excelArtifactId`、`filename`、`sheets` 元数据与 `totalRows`）。不要发布只存在于实时的状态。
- **中止是协作式的。** 路由调用 `runtime.abort`；会话被中止，队列项被移除。还在排队（未活跃）的 run 会立即结束。
- **会话来源分离。** `conversations.source_kind` 区分 `'datasource'`（`datasource_id` 必非空）与 `'file'`（`datasource_id` 为空，表元数据存于 `conversation_files` / `conversation_file_tables`，数据存于 `DATA_DIR/files/<conversationId>/data.sqlite`）。文件会话不走数据库范围过滤，技能（`skills.ts`）与 MCP（`mcp.ts`）仅加载全局配置；记忆保存/提取在无数据源时归为全局（且跳过临时的 `fact`）。
- **文件表动态可见。** `db_schema` 在文件会话每次执行时实时读取 `conversation_file_tables`，通过 `POST /api/conversations/:id/files` 追加上传文件后下一轮立即可查询、无需重建会话。删除会话与清理任务会同步删除 `DATA_DIR/files/<conversationId>` 与会话工作区目录。
- **会话资源是快照。** 技能/MCP/报告/导出工具（含 `ConversationPermissions.export` 控制的 `create_excel`）在创建会话时装配（开放平台会话固定禁用 `export`）。之后的权限变化影响新请求，但不会改变已有工具集（`create_excel` 执行期还会再次按数据库权限校验）；契约要求立即生效时，重建会话。
- **队列满是对客户端可见的错误。** 路由把 run 标记为失败并返回稳定错误码；不要静默丢弃消息。
- **建议追问独立于 `run_events`。** `GET /api/runs/:id/suggestions` 校验运行归属与 `runScopeVisible` 后，用无工具、关闭思考的独立会话生成最多 3 条追问并缓存到 `runs.suggestions_json`（同 `runId` 并发去重）；仅针对成功的聊天轮次按需触发，不向 `run_events` 追加事件以保持 `run_end` 为终止事件，也不在定时任务或错误/中止轮次额外调用模型。

## 失败行为

- Pi 会话创建失败会把 run 标成 `error` 并发出 `run_end`；下一轮会重试创建会话。
- 模型/工具错误记录在 run 上并显示在 trace 中；重试是新的 run，通过 `retry_of_run_id` 关联，不是原地重置。
- SSE 断线是正常的；回放会补上缺口。持久化事件格式错误时跳过，而不是让整个流崩溃。
- runtime 释放会中止活跃会话，并用终止状态清空队列。测试里必须清理定时器/interval。

## 验证

```bash
pnpm exec vitest run apps/server/test/runtime.test.ts \
  apps/server/test/agent-e2e.test.ts \
  apps/server/test/event-bridge.test.ts \
  apps/server/test/runs-sse.test.ts \
  apps/server/test/conversations-api.test.ts
```

修改 SSE 或事件契约时，还要跑 Web 聊天测试，并实际检查一次运行 trace 和刷新后的回放。回放测试必须证明重连后事件不会重复。
