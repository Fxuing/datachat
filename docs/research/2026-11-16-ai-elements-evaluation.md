# shadcn/ui AI Elements 调研（Trace / MessageScroller）

> 调研日期：2026-11-16。结论：**借鉴交互模式，不整体迁移**；后续优先参考 **Trace 的调用链路**，其次 **MessageScroller** 的滚动行为。

## 1. AI Elements 是什么

AI Elements 是 shadcn/ui 在 2026-10 随 `Trace`、`Code Block` 一起发布的**模式集合**，不是 npm 组件库。每个模式是一组 shadcn/ui 组合，用 CLI 复制到项目里：

```bash
pnpm dlx shadcn@latest add trace
pnpm dlx shadcn@latest add message-scroller
```

共 21 个模式：

- 对话：Chat、Message、Prompt Input、Message Scroller
- Agent 过程：Trace、Reasoning、Tool、Task、Plan、Queue、Chain of Thought
- 辅助：Model Selector、Context、Suggestion、Confirmation、Questionnaire
- 其他：Sources、Inline Citation、Checkpoint、File Tree、Subagent、Terminal、Test Results、Stack Trace

提供 Base UI / React Aria / Radix 三种实现；本项目应选 Radix 变体。`MessageScroller` 的滚动行为来自 headless 包 `@shadcn/react`（0.3.1，解包约 56KB）。

## 2. Trace：最值得参考的部分

### 2.1 结构

```text
Trace
└── TraceCollapsible
    ├── TraceCollapsibleTrigger
    │   └── TraceLine
    │       ├── TraceIcon
    │       ├── TraceTitle
    │       ├── TraceDescription
    │       └── TraceIcon
    └── TraceCollapsibleContent
        └── 详情（文本 / CodeBlock / 嵌套 Trace）
```

- `TraceLine`：一行调用步骤，包含图标、标题、次要说明和状态。
- `TraceCollapsible`：把一行包成可展开项；`TraceCollapsibleContent` 放 SQL、结果摘要、错误栈等详情。
- `status`：`running`（运行中，带 shimmer）、`error`、`pending`；`none` 表示已完成。
- 支持**嵌套**：一个 summary 行展开为多个步骤，步骤再展开为输出。
- 每行可包 `a` / Dialog trigger / Sheet trigger / Popover trigger，天然支持“点开看详情”。
- 无障碍和键盘操作由外层 trigger 提供；收起/展开状态可由 `open ?? running` 实现“运行时自动展开、用户点击优先”。

### 2.2 与 DataChat 的映射

| 现有实现 | Trace 映射 |
|---|---|
| `TurnFooter` 的执行步骤列表 | 一个 `Trace` 容器 |
| `ThinkingBlock` | `TraceCollapsible` + `TraceLine status=running`，内容放思考文本 |
| 工具卡（db_schema/db_query/db_explain/make_chart/create_report） | 每个工具一个 `TraceLine`；标题“查询数据/读取表结构/生成图表”，`TraceDescription` 放耗时/行数 |
| `SqlCard` | 工具行的 `TraceCollapsibleContent`，内嵌 CodeBlock |
| `ResultCard` | 工具行的详情或独立结果行，点击打开现有 Dialog |
| 错误/SQL 失败 | `status="error"`，标题用过去式“查询失败”，详情放错误信息 |
| `QuestionCard` | 独立的用户交互块，不塞进 Trace |

**收益**：现在“思考 → 工具 → SQL → 结果”是多种卡片拼接，层级不统一；Trace 能把它们组织成同一条可折叠调用链，默认收起，展开逐层看细节，视觉噪音更低。

**注意**：我们的 Agent 没有显式 Plan/Todo 事件，第一版不要做 Plan/Queue；只做“已发生的调用链”，等事件模型支持计划后再扩展。

## 3. Reasoning、Model Selector 与 Agent 过程组件

### 3.1 Reasoning

Reasoning 本质上是 Trace 的一层封装：一行 “Thinking” → 流式结束后变成 “Thought”，显示耗时，内部放思考文本；内置 `TraceCollapsible`，运行时展开、结束后收起。

评价：**行为与我们的 `ThinkingBlock` 几乎一致**（默认展开、跟随、结束折叠），差距主要在视觉统一和耗时展示。因此不必单独引入 Reasoning，直接把它作为 Trace 的第一行即可；这样思考、工具、结果共享同一套缩进和状态样式。

### 3.2 Model Selector

两个菜单：一个选模型，一个选思考强度（effort），通常嵌在 Prompt Input 的底部工具栏。

评价：**我们的 `ModelPicker` 功能更全**——按 provider 分组、显示模型元数据、支持 7 档思考、与上下文环/发送按钮同排。AI Elements 的版本更通用，但没有 provider 概念。除非重做 Composer，否则不建议替换；可以借鉴它的“两个独立菜单”视觉，但当前单 Popover 更省空间。

### 3.3 Agent 过程组件

| 组件 | 语义 | 对我们的适用性 |
|---|---|---|
| Tool | 一次工具调用，含输入/输出/错误/等待审批 | ★★★★★ 直接对应 `db_schema/db_query/db_explain/make_chart/create_report`，应作为 Trace 的行 |
| Task | Agent 正在做的一件事，步骤随执行逐条出现，标题区分“正在做/已做完” | ★★★★ 可以把一轮问答视为一个 Task，天然有进度 |
| Plan | 开始前就确定的步骤，含 pending 状态和 “2 of 4 done” | ★★ 需要 Agent 显式产出计划；当前没有 plan 事件，强行做会变成假进度 |
| Queue | Todo 列表，分“待办/已完成” | ★★ 需要 todo 工具或状态机；SQL Agent 暂不需要 |
| Chain of Thought | 一段摘要展开成完整步骤 | ★★★ 与 Trace/Reasoning 重叠，可作为外层摘要 |
| Stack Trace | 失败的工具调用 + 调用栈 | ★★★ SQL/工具错误详情可借用其展示方式 |
| Sources / Inline Citation | 回答引用的来源 | ★ 我们目前没有网页检索；未来可引用表/字段，但不是现在 |
| Confirmation | 工具执行前的批准 | ★ 只读查询不需要 |
| Subagent / File Tree / Terminal / Test Results / Checkpoint | 编码类 Agent 场景 | ✗ 不适用 |

评价：**Agent 过程组件是这套库里除 Trace 外最有价值的一组**，因为它们把“执行过程”当成一等公民，而不是聊天气泡的附属。但真正能直接落地的是 **Tool + Task + Stack Trace**；Plan/Queue 依赖新的 Agent 事件模型，第一版不建议做。

### 3.4 建议的目标形态

把现有 `TurnFooter + ThinkingBlock + 工具卡 + SQL 卡` 收敛成一条 Trace：

```text
▾ 本轮完成 · 5 步 · 23.4s
  ✓ 思考 · 8.2s
  ✓ 读取表结构 · 0.4s
  ✓ 执行查询 · 1.2s      [查看 SQL]
  ✓ 生成图表 · 0.6s
  ✓ 生成报告 · 2.1s
```

- 运行中：`running` 行带 shimmer，自动展开当前步骤；
- 失败：`error` 行标题用“查询失败”，详情放错误和安全提示；
- 完成：整体默认收起，只留一行摘要；用户展开看 SQL/结果；
- 结果表格仍用现有 `ResultCard` Dialog，不塞进 Trace 的正文。

## 4. MessageScroller：滚动行为值得参考

能力：

- 用户消息作为滚动锚点，新问题落在顶部附近，回答在下方流式展开。
- `autoScroll` 跟随流式输出；用户往上读时暂停跟随。
- 打开历史记录不跳动；向前加载历史时保持当前位置。
- 跳到指定消息、跟踪阅读位置、虚拟化长会话。
- 只负责滚动，不接管消息、传输、持久化、分支和模型状态。

与现状对比：

- 我们的 `MessageList` 手写了贴底吸附、回到底部按钮、历史恢复，且有 `ConversationMinimap`。
- 可借鉴其“锚点 + 跟随 + 保留阅读位置”的状态机，但不一定要引入组件；引入时要处理乐观消息、run 分组、minimap 和自动滚动之间的冲突。
- 如果引入，优先使用 `@shadcn/react` 的 headless 行为，保持我们自己的消息气泡和结果卡片。

## 5. 兼容性评估

| 项 | 现状 | 影响 |
|---|---|---|
| Tailwind | 3.4，自定义 `ink/surface/line/brand` token | AI Elements 按 Tailwind 4 + shadcn 语义 token 生成；直接复制会缺样式 |
| shadcn 配置 | 无 `components.json`，组件为手写 | 不能直接 `shadcn add`，需要 init 或手工移植 |
| 消息模型 | Pi SSE 自定义事件（thinking/tool/result/sql） | 需要 adapter；不能直接用 AI SDK `UIMessage` 示例 |
| 视觉 | 已有品牌色和紧凑布局 | 全量替换会带来明显回归 |
| 依赖 | React 19、Radix 已有部分 | React 19 兼容；CodeBlock 会引入 Shiki |

Tailwind 3 只能用旧版 `shadcn@2.3.0`，而新版 AI Elements 不在旧 CLI 中；整体迁移意味着先升级 Tailwind 4，成本约 3–5 天。

## 6. 结论与后续

1. **不做整体迁移**。DataChat 的聊天界面是业务定制（技能、数据源、SQL、结果、分享），AI Elements 是通用 Agent UI，直接替换收益低。
2. **优先做 Trace 的设计移植**：把执行步骤统一成“图标 + 标题 + 状态 + 耗时 + 可展开详情”的调用链；不引入依赖，保留现有 token 和组件。
3. **MessageScroller 作为第二优先**：先评估 `@shadcn/react` headless 行为，替换手写滚动状态机；保留消息气泡、结果卡和 minimap。
4. Code Block 可选：如果后续需要行号/语法高亮/diff，再评估 Shiki 的体积。

建议在 Playwright 或产品扩展之后排期；若要做，先开分支做 1 天原型，不改主界面。

## 7. 参考

- [AI Elements](https://ui.shadcn.com/docs/ai-elements)
- [Trace](https://ui.shadcn.com/docs/components/base/trace)
- [Message Scroller](https://ui.shadcn.com/docs/components/base/message-scroller)
- [Code Block](https://ui.shadcn.com/docs/components/base/code-block)
- [2026-10 发布说明](https://ui.shadcn.com/docs/changelog/2026-10-ai-elements)
- [旧版 AI Elements 迁移说明](https://github.com/vercel/ai-elements)
