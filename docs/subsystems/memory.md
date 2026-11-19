# 用户记忆：召回、保存与提取

记忆是每个用户跨会话的上下文。它是额外的 prompt 上下文，不是模型可以查询的第二个数据库。记忆可以是全局的，也可以绑定到一个数据源，并且只对属主可见。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 表/设置 | `user_memories`、`user_memory_settings`、`runs.memory_extracted_at` | [`schema.ts`](../../apps/server/src/db/schema.ts)，迁移 `0013` |
| 仓储 | 按属主 CRUD、去重/合并、活跃/核心过滤、来源 run 计数 | [`user-memories.ts`](../../apps/server/src/db/repositories/user-memories.ts) |
| 召回 | 排序活跃记忆、预算、格式化 prompt 块 | [`recall.ts`](../../apps/server/src/memory/recall.ts) |
| 扩展 | 每轮运行前注入记忆块 | [`recall.ts`](../../apps/server/src/memory/recall.ts) |
| 工具 | `memory_save` 校验/持久化 | [`tool.ts`](../../apps/server/src/memory/tool.ts) |
| 提取 | 成功运行的对话记录 → 校验后的记忆 | [`extraction.ts`](../../apps/server/src/memory/extraction.ts)、[`generate.ts`](../../apps/server/src/memory/generate.ts) |
| 秘密 | 拒绝密码/token/key | [`secrets.ts`](../../apps/server/src/memory/secrets.ts) |
| API | 按属主列出/创建/更新/删除/清空/设置 | [`memories.ts` 路由](../../apps/server/src/routes/memories.ts) |

## 运行路径

### 召回（prompt 之前）

1. 检查管理员全局开关和用户设置。任一关闭就不注入。
2. 加载活跃记忆：全局 + 当前数据源；排除停用/归档项。
3. 先放 `core` 的 `profile`/`instruction`/`preference` 记忆，随后自动纳入当前范围内置信度 ≥80（`MEMORY_ALWAYS_ON_PREFERENCE_CONFIDENCE = 80`）的活跃 `preference` 记忆（合计上限 `MEMORY_CORE_BUDGET = 2000` 字符、最多 20 条）；再放按查询分词排序后的相关记忆（如 `fact` 与低置信度条目，预算 `MEMORY_RECALL_BUDGET = 1500`，最多 `MEMORY_RECALL_LIMIT = 5`）。总量上限 `MEMORY_TOTAL_BUDGET = 3500`；超长条目跳过，不要从句子中间截断。
4. 格式化成简短的“用户长期记忆”块，带标题/内容，标注 `[核心]` 和来源范围，作为隐藏的 prompt 上下文注入。不要把它伪装成用户消息或工具结果。

### `memory_save`（模型主动保存）

用户明确陈述长期偏好/事实时，模型可以保存。必填字段包括 kind（`profile`/`preference`/`instruction`/`fact`）、scope（`global`/`datasource`）、title、content、confidence，可选 `core` 和 datasource id。`profile`/`instruction`/`preference` 可以是核心；`fact` 不可以。拒绝秘密和空白/超长内容。标题/内容重复时合并或返回受控冲突；绝不能留下两条相同的活跃记录。

### 提取（成功运行之后）

1. 只在成功终止、记忆已启用且 `runs.memory_extracted_at` 为空时触发。
2. 如果本轮已经通过 `memory_save` 写过（`sourceRunId` 计数 > 0），或已被重试替换，则跳过。
3. 用与本轮相同的模型跑一个独立的、无工具的 agent 会话；传入精简对话记录和提取 prompt。输出最多 3 条记忆。
4. 逐条校验：允许的 kind/scope、置信度阈值、无秘密、无 SQL 结果/表清单/临时筛选条件。低置信度可以保存但不注入；无效项丢弃。
5. 保存 `sourceConversationId`/`sourceRunId`，即使没提取到内容也要标记 `memory_extracted_at`；提取失败绝不能让本轮运行失败。

## 契约

- **属主隔离是绝对的。** 每次读写都过滤 `userId`；模型不能读取其他用户的记忆。管理员全局禁用不等于可以浏览内容。
- **记忆是不可信文本。** 它可能包含 prompt injection；要标记为背景信息，放在系统/工具规则之下，绝不能让记忆授予权限或改变数据源范围。
- **范围在召回时强制执行。** 数据源范围的记忆只在本轮数据源匹配时注入；全局记忆可以出现在任何地方。
- **预算是字符预算，不是 token 估算。** 常量和测试要同步。
- **提取是尽力而为。** 它不能阻塞运行完成、改变运行状态或产生用户可见错误。它可以被全局禁用，也必须尊重用户设置。
- **不要保存查询结果或 schema 转储。** 这些属于 artifact/schema 缓存。记忆只存长期用户偏好/事实。
- **清空就是清空。** 用户清空只删除自己的记忆并适当重置设置；不能碰其他属主。

## 失败行为

| 情况 | 行为 |
| --- | --- |
| 全局/用户记忆关闭 | 不召回、不写工具、不提取 |
| 没有相关记忆 | 不注入（不要空标题） |
| 超长/无效记忆 | 召回时跳过；写入时校验 |
| 检测到秘密 | `MEMORY_SECRET_DETECTED`；不保存 |
| 重复 | 合并或 `MEMORY_DUPLICATE`；不产生重复活跃记录 |
| 提取/模型失败 | 记录/忽略；本轮仍成功；下一轮再试 |
| 本轮已写记忆 | 跳过该轮提取 |

## 验证

```bash
pnpm exec vitest run apps/server/test/memory-recall.test.ts \
  apps/server/test/user-memories.test.ts \
  apps/server/test/memory-extraction.test.ts \
  apps/server/test/memory-routes.test.ts \
  apps/server/test/agent-e2e.test.ts
```

召回改动需要预算/范围测试；提取改动需要“提取失败但不改变运行结果”的测试。
