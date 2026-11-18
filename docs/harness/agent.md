# Agent、Prompt 与技能

> 适用：`apps/server/src/agent/**`、`apps/server/src/memory/**`、`agent/prompts/**`、`agent/skills/**`。
> 注意：根目录 `AGENTS.md` 是给**编码 agent** 的项目说明；DataChat 产品内的 Pi 会话通过 `noContextFiles: true` 明确关闭了项目上下文文件，不会自动读取它。

## 1. 两个“Agent”不要混淆

| | 编码 agent（当前会话） | DataChat 产品 agent |
| --- | --- | --- |
| 入口 | Pi CLI / 本仓库 | `apps/server/src/agent/runtime.ts` |
| 上下文 | 根 `AGENTS.md` + 按需 docs | 渲染后的 `agent/prompts/system.md` |
| 工具 | shell/read/edit/... | `buildAgentTools()` 的只读数据工具 |
| 技能 | `.pi/skills`、项目 skills | 数据库 `skills` 表 → 每会话物化目录 |
| 目标 | 改代码 | 回答用户的数据问题 |

改产品行为时改 `agent/` 与 `system.md`；不要试图用根 `AGENTS.md` 影响产品 agent。

## 2. 会话与运行生命周期

`RuntimeManager`（`runtime.ts`）按会话缓存 `ConversationRuntime`：

1. `POST /messages` 创建 `runs` 行，`runtime.enqueue()` 入队；返回 `runId + position`。
2. `ConversationRuntime.drain()` 串行执行；同一会话同时只有一个 active run。
3. 首次运行 `createConversationSession()`：
   - 解析数据源、启用模型、`createConversationResources()`；
   - 物化技能到 `DATA_DIR/skills/<conversationId>`；
   - 构造 `AgentToolContext`（绑定 userId/conversationId/datasourceId/runId）；
   - `createAgentSession({ noTools: "builtin", customTools, resourceLoader, ... })`。
4. 每次 prompt 前 runtime 更新 `toolContext.runId`，确保 artifact/审计/事件归属当前 run。
5. `EventBridge` 把 Pi 事件转成 shared `RunEvent`，持久化 + 广播；`run_end` 后更新状态。
6. 成功 run 可触发异步记忆提取；失败/取消不提取。
7. 空闲 runtime 由 manager 回收；`dispose()` 中止 session 并清理。

约束：

- 不要绕过队列直接调用 `session.prompt()`；并发会破坏 session 状态与事件顺序。
- 不要跨会话复用 `AgentToolContext`；datasourceId 必须来自会话。
- session 文件路径写回 `conversations.piSessionFile`；删除会话时要删文件（见 `deleteConversationFiles`）。
- 测试可用 `ConversationSessionFactory` 注入假 session，不要真的调模型。

## 3. 工具

注册：`apps/server/src/agent/tools/index.ts` `buildAgentTools(ctx, { canCreateReports })`。

| 工具 | 作用 | 关键约束 |
| --- | --- | --- |
| `read`（sandbox） | 读取物化技能文档 | 只能读 `skillsDir`/workspace；防路径逃逸 |
| `db_schema` | 读取表/列/类型 | 只读 introspect；不暴露连接信息 |
| `db_query` | 执行只读 SQL、产出 artifact | 必须走 `runGuardedQuery`；自动 LIMIT；审计 |
| `db_explain` | 执行计划 | 同样 guard/只读 |
| `make_chart` | 从 result artifact 生成图表 spec | 输入最多 50k 行；只允许已有 artifact |
| `list_artifacts` | 列出当前会话结果 | 用户/会话隔离 |
| `create_report` | 生成报告 | 需要 `report.create`，fail closed |
| MCP 工具 | 外部 MCP server | 需要 `mcp.use`；按数据源配置加载 |
| 记忆工具 | `memory_save` | 需要记忆开启；秘密过滤；owner 隔离 |

工具写法：

- 从 `AgentToolContext` 取 db/config/pools/artifacts/ids，不从参数接收 datasourceId。
- 失败返回 `errorResult(code, message, details)`，不要 throw 到 agent loop（模型应看到可纠正的错误）。
- 返回 `textResult` + 结构化 `details`；`event-bridge.ts` 会从 details 提取 artifact/rowCount/sql 等给 UI。
- 新增工具要同步 `event-bridge.ts` 的 `ToolDetails`/映射、前端工具卡片、权限与测试。

## 4. 系统 Prompt

文件：`agent/prompts/system.md`，由 `apps/server/src/agent/prompt.ts` 渲染（数据源名、类型、库名、当前时间）。

当前行为要点：

- 先判断意图：寒暄/通用知识不查库；需要数据才走 schema → query。
- 查询列严格对齐问题；简单问答尽量一条 SQL；报告/多维可多条。
- 结果表默认在执行过程；正文用 `[[result:<id>]]` 给完整结果入口（仅聊天）。
- 图表用 `make_chart` + `[[chart:<id>]]`；报告用 `[[artifact:<id>]]` + 报告链接。
- Mermaid 只用于结构/流程/关系，不用于数据趋势/对比/占比；图型可用 Mermaid 标准库，节点/字段/步骤必须来自 schema、结果或用户输入，≤15 节点。
- 超过 100 行不逐行粘贴；用户要“全部数据”时引导结果表/导出，截断时明确说明。

改 prompt 时：

1. 先判断是**产品行为**还是**单次任务**；单次任务不要写进全局 prompt。
2. 保持占位符语法与前端解析器一致（`report-markdown.ts`）；新增标记要改聊天/报告/分享/流式。
3. 不在 prompt 中写具体用户数据、密钥、内部路径。
4. 同步 `agent/skills/analysis-standards` 的边界：分析规范讲方法，格式规则留在 system prompt，避免重复。
5. 跑 prompt/agent 相关测试；至少手工验证一个简单问答 + 一个图表/报告场景。

## 5. 技能

- 内置模板：`agent/skills/<name>/SKILL.md`，frontmatter `name/description`。
- 启动时 `seedSkills()` 把模板导入 `skills` 表，**按 name 幂等**：已存在的同名技能不会更新。因此修改模板只影响新数据库；已部署环境需管理员在 `/admin/skills` 编辑或写迁移/升级脚本。
- 会话创建时 `materializeSkills()` 从 DB 读取当前数据源适用的技能，写入 `DATA_DIR/skills/<conversationId>/`；数据源技能按同名覆盖全局技能。
- `skill.use` 权限在会话级解析；无权限不物化、前端也不显示技能入口。
- 显式 `/skill` 调用由 `composeSkillInstruction()` 把技能正文注入 prompt（限制 60k 字符），不是只让模型“自己记得读”。
- 技能内容只写方法/方言/业务口径；不要写密钥、连接串、真实用户数据。

新增内置技能：

1. 建 `agent/skills/<name>/SKILL.md`，frontmatter 必填 name/description。
2. 本地新库验证 seeding；已有库用管理页导入/创建。
3. 如技能影响分析结论，补一个 agent/e2e 或 prompt 测试。
4. 不要在技能里重复 system prompt 的通用格式规则。

## 6. 模型与 Provider

- Provider 配置在 `llm_providers`（API URL/Key/协议），模型目录同步到 `DATA_DIR/agent/models.json`。
- 模型 id 规范：`<providerId>::<modelId>`；解析在 `agent/model-runtime.ts`。
- 会话可覆盖模型/思考级别；默认模型来自管理员设置。解析顺序与 fallback 见 `resolveConversationModel()`。
- 不要在代码里硬编码模型名；测试用 fake runtime/model。
- 修改 provider/模型行为时检查：`/api/models`、`ModelPicker`、会话创建、错误提示、`apps/server/test/model-runtime.test.ts`。

## 7. MCP 与记忆

**MCP**：

- 配置存 `mcp_servers`，按数据源启用；`mcp.use` 无权限不加载。
- `resources.ts` 通过 `createMcpExtension` 延迟加载；MCP 工具名可能冲突，启用前检查。
- MCP server 可能访问外网；管理员配置，普通用户不能自建。

**记忆**：

- 召回：`memory/recall.ts` 每轮注入全局 + 数据源相关记忆，预算约 3500 字符；`onMemoryUsed` 写入 run trace。
- 写入：`memory_save` 工具 + 成功 run 后 `memory/extraction.ts` 异步提取（独立无工具 session，跟随 run 模型，最多 3 条）。
- 隐私：记忆只属于用户；管理员只能全局开关/管理，不读取正文；秘密过滤在写入前。
- 关闭记忆：用户设置或管理员全局开关；关闭后不召回、不注入、不提取。
- 改记忆行为检查：`memory/*.test.ts`、`memory-routes.test.ts`、`ChatPage` 的记忆 trace。

## 8. 事件与 UI 协议

- 事件类型在 `packages/shared/src/run-events.ts`；服务端 `EventBridge` 产生，前端 `useRunStream` 消费。
- 工具事件要包含足够 UI 信息：`artifactId`、`columns`、`rowCount`、`truncated`、`sql`、`chartArtifactId` 等；不要只发自然语言。
- `run_end` 必须最终到达；失败/取消/超时都要落状态，否则前端一直转圈。
- 新增事件：shared → bridge → append/publish → SSE replay → 前端合并 → 组件测试。

## 9. 新增工具检查单

- [ ] 工具只从 `AgentToolContext` 取身份/数据源。
- [ ] 数据查询走 `runGuardedQuery`/guard；无直接 pool。
- [ ] 失败用 `errorResult`，错误码稳定。
- [ ] `details` 可供 `event-bridge` 映射；前端有对应展示。
- [ ] 权限：工具是否应 fail closed？在 `buildAgentTools`/session 层控制。
- [ ] 审计/artifact 归属当前 run。
- [ ] 单测 + 至少一个 route/agent 流测试。
- [ ] prompt 中说明何时使用；避免模型滥用。

## 10. 常见坑

- **内置技能改了但不生效**：`seedSkills` 不覆盖同名行；去管理页改或加迁移。
- **skill 内容没进 prompt**：检查 `skill.use`、`materializeSkills`、前端 `/skills` 列表、`composeSkillInstruction`。
- **工具报错后模型反复重试**：错误消息要可操作（表名不存在/权限不足/超时），不要只返回堆栈。
- **artifact 跑到上一轮**：忘记在 prompt 前更新 `toolContext.runId`。
- **MCP 工具突然消失**：检查权限、数据源配置、extension 是否 resolve 成功。
- **记忆污染**：提取 session 必须无工具、低置信度不注入、秘密过滤；不要复用主会话上下文。
- **报告链接失效**：prompt 要求 `/reports/<id>` Markdown 链接，前端路由必须存在。
