# 聊天界面：消息、分段、结果与滚动

聊天页渲染一个会话，消费实时 run 流，并把助手 Markdown 转成文本、图表、报告、artifact 和行内结果链接。服务端队列/事件见 [聊天运行时](chat-runtime.md)。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 页面状态 | 会话/消息/run 查询、输入框、活跃流 | [`ChatPage.tsx`](../../apps/web/src/pages/ChatPage.tsx) |
| 流 | 重连、回放、按序号合并事件、取消/清理 | [`useRunStream.ts`](../../apps/web/src/hooks/useRunStream.ts) |
| 消息列表 | 排序、滚动锚定、流式尾部、“有新内容” | [`MessageList.tsx`](../../apps/web/src/components/chat/MessageList.tsx)、[`message-scroll.ts`](../../apps/web/src/lib/message-scroll.ts) |
| 单条消息 | Markdown、分段、执行过程、用量、操作、部门范围提示 | [`MessageItem.tsx`](../../apps/web/src/components/chat/MessageItem.tsx) |
| 解析器 | 切分 markdown/artifact/chart/result 段 | [`report-markdown.ts`](../../apps/web/src/lib/report-markdown.ts) |
| 数据表格 | 预览、加载更多、导出、SQL 详情 | [`ResultTable.tsx`](../../apps/web/src/components/chat/ResultTable.tsx)、[`ResultDetailDialog.tsx`](../../apps/web/src/components/chat/ResultDetailDialog.tsx) |
| 行内结果 | 链接 + 详情弹窗 | [`ResultLink.tsx`](../../apps/web/src/components/chat/ResultLink.tsx) |
| 图表 | 渲染校验后的图表 spec | [`ChartCard.tsx`](../../apps/web/src/components/chat/ChartCard.tsx) |
| 报告 | 报告 artifact 卡片/链接 | [`ReportPage.tsx`](../../apps/web/src/pages/ReportPage.tsx) |

React Query 是服务端状态缓存；使用 `lib/query.ts` 的 `queryKeys` 和 `lib/api.ts` 的 `apiRequest`。能用 query/mutation 解决时，不要在 effect 里发请求。

## 运行路径

1. `ChatPage` 加载会话和消息历史。服务端从 `runs`/`run_events` 组装消息；活跃 run 会带上可回放事件，供刷新后恢复。
2. 发送消息会入队一个 run（202），设置活跃 run id，并让 `useRunStream` 打开 SSE。输入框在终止前保持禁用。
3. 事件按 `seq` 合并：text/thinking 增量追加到流式轮次；工具事件变成 trace 行；artifact/chart/report 挂到 run 上；`run_end` 收尾状态/用量/错误。
4. 刷新/重连时，hook 从最后看到的序号之后回放，避免持久事件和实时事件重复。断线会显示重连 UI；run 仍在服务端继续。
5. 完成后使该轮失效/重新拉取；持久化消息替换本地流式表示。除非用户本来贴在底部，MessageList 会保持阅读锚点。

## 消息分段契约

助手文本由 `parseChatMarkdown` 切成：

- `markdown`——正文、表格、Mermaid、普通代码块；
- `artifact`——`[[artifact:<id>]]`，渲染成结果/报告卡片；
- `chart`——`[[chart:<id>]]`，从图表 artifact 渲染；
- `result`——`[[result:<id>]]`，聊天专用的当前结果行内链接。

`parseReportMarkdown` 故意把 `[[result:...]]` 当普通文本（报告使用 artifact）。新增标记或分段时：

1. 扩展解析器和类型。
2. 更新 `MessageItem` 和 `MessageList` 的流式分支；如果报告/分享可能收到该标记，同步更新 `parseReportMarkdown` 行为。
3. 处理不完整/未知 id，不能崩溃：回退为可见文本或受控的“不可用”卡片。
4. 确保被引用的 artifact 不会再渲染成独立卡片。
5. 加解析器测试、每个消费端一个渲染测试，以及一个流式测试。

Mermaid 代码块由 `MermaidDiagram` 在聊天、报告和公开分享中渲染；保留源码回退和严格安全级别。

## 布局与交互契约

- 消息区域是滚动所有者。输入框不在其中 sticky；它在下方，不能遮住最后一行。窄屏下左侧栏收起为左抽屉（`Sheet`），通过顶栏菜单按钮打开，避免挤压对话与后台表格。
- 左侧会话栏的「新建对话」直接进入 `/chat` 空态，在发送首条消息时携带已选数据源、模型与思考等级创建会话（避免空会话记录）；列表支持 `before` 游标分页（「加载更多」）与防抖关键词搜索。
- 助手轮次底部支持一键复制回答、单次点击直接点赞（再点撤销）与弹窗填写差评原因；代码块复制走共享剪贴板兼容封装；外部 Markdown 链接以新标签页打开。
- 流式期间：只有用户本来在底部/接近底部时才贴底。用户上翻时冻结并显示“有新内容”；点击回到底部。切换会话恢复每个会话保存的位置，同时重置 `Composer` 草稿与失败重发状态。
- 顶栏右侧状态指示器真实反映当前流状态（「生成中…」「重连中…」「模型异常」），空闲时不显示占位提示。
- 长表格横向滚动；每个 flex/grid 祖先都要有 `min-w-0`/`overflow-x-auto`。不要只靠 `truncate` 把表格压小。
- 结果预览有界；“加载更多”追加分页，导出流式发送完整 artifact；生成报告进行中禁用按钮防连点。初次渲染卡片时绝不拉取全部行。
- 流式文本可能包含半个 `[[artifact:`/`[[chart:`/`[[result:` 标记；在完整前隐藏，不要显示原始语法。
- 使用共享 `Button`/`Dialog`/`Sheet`/`ConfirmDialog` 原语，不在业务操作中调用原生 `window.confirm`；原生 `title` 只通过 `Tooltip` 组件使用；纯图标按钮要有可访问名称。

## 失败行为

- SSE 401/404：停止重连并显示错误；不要空转。
- 网络断开：退避重试，从最后序号回放，保留部分轮次。
- 未知 artifact/result id：显示不可用状态，不要留空白卡片。
- run 失败：保留 trace，显示错误和重试/换模型操作；重试通过 `retry_of_run_id` 替换失败轮次。
- 部门过滤：`message.scope` 存在且非空时，在回答上方显示数据范围提示；没有 `scope` 的历史轮次不显示，不要用当前部门反推。
- 图表/报告 JSON 损坏：显示错误/回退；一个坏 artifact 不能让消息列表崩溃。

## 验证

```bash
pnpm --filter @datachat/web exec vitest run \
  src/lib/report-markdown.test.ts \
  src/components/chat/MessageItem.test.tsx \
  src/components/chat/MessageList.test.tsx \
  src/components/chat/ConversationSidebar.test.tsx \
  src/pages/ChatPage.test.tsx
pnpm --filter @datachat/web typecheck
```

视觉改动要在桌面和窄宽度下检查，并覆盖长表格、流式过程中和刷新后。分段改动需要流式半标记测试。
