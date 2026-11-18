# 前端

> 适用：`apps/web/**`。后端/权限/SQL 规则见 `backend.md`；聊天运行链路见 `agent.md`。

## 1. 组成与路由

```text
main.tsx
  └─ App.tsx                 BrowserRouter + lazy routes + RequireAuth / RequireAdmin
       ├─ LoginPage
       ├─ ChatPage           /chat, /chat/:conversationId
       ├─ ReportPage         /reports/:id
       ├─ PublicSharePage    /s/:token（匿名）
       ├─ ScheduledPage      /scheduled
       ├─ MemoryPage         /memory
       └─ admin/*            AdminShell + 管理页
```

- 路由统一在 `apps/web/src/App.tsx` 注册；新页面用 `lazy()`，并补 `AppShell`/`AdminShell` 导航项。
- 页面只做组合与数据编排；可复用 UI 放 `components/`，纯函数放 `lib/`。
- 侧边栏宽度固定 `w-60`；聊天主体必须保持 `min-h-0` 链，否则滚动容器会撑破。

## 2. 服务端状态（React Query）

- `lib/api.ts`：所有 HTTP 调用的唯一入口。
  - `apiRequest<T>(path, init)` 自动 `credentials: include`、JSON content-type、401 触发全局 handler。
  - 失败抛 `ApiError`，含 `code/status/details/message`；组件用 `errorMessage()` 或 `code` 分支。
  - 不要用裸 `fetch`；测试里才 stub `fetch`。
- `lib/query.ts`：`queryClient` + `queryKeys`。
  - 新资源必须加 query key；列表筛选参数进入 key（如 `conversationList(q)`）。
  - 默认 `staleTime: 10_000`、`retry: 1`、mutation 不重试。
  - mutation 成功后按前缀 invalidate：`queryClient.invalidateQueries({ queryKey: ["conversations"] })`。
- 组件内不要复制服务端数据到本地 state 长期保存；需要乐观更新时明确回滚。
- 401 由 `installUnauthorizedHandler` 清空 query cache 并跳登录；不要在每处单独处理。

## 3. 聊天页数据流

```text
ChatPage
  ├─ useQuery(conversation detail)
  ├─ useRunStream(runId, conversationId)   // SSE + 断线续传
  ├─ useQuery(conversation skills)
  ├─ Composer (模型/思考级别/技能/发送)
  └─ MessageList
        └─ MessageItem
              ├─ Markdown / Mermaid
              ├─ artifacts → ResultCard / ChartCard
              └─ results → ResultLink → ResultDetailDialog
```

- 打开会话时先拉历史详情，再根据 `activeRun` 订阅 SSE；不要先渲染空态再闪回。
- `useRunStream` 合并实时事件与历史状态；组件只消费合并后的消息/运行状态。
- 发送消息后乐观插入用户消息和占位 assistant；`run_end` 后以服务端详情为准刷新。
- 失败轮次显示“原地重试/换模型”；不要删除旧轮次后再本地拼接。
- 滚动行为集中在 `lib/message-scroll.ts` + `MessageList`：切换会话回底、阅读位置恢复、流式贴底、上翻冻结。不要在多个组件里各自 `scrollIntoView`。

## 4. 消息与占位符协议

解析器：`apps/web/src/lib/report-markdown.ts`

| 语法 | 场景 | 渲染 |
| --- | --- | --- |
| `[[artifact:<id>]]` | 报告/正文引用完整结果 | `ResultCard` / 报告内嵌结果 |
| `[[chart:<id>]]` | 数据图表 | `ChartCard` + ECharts |
| `[[result:<id>]]` | 聊天内联结果链接（仅聊天） | `ResultLink` → `ResultDetailDialog` |
| ```mermaid | 结构/流程/关系图 | `MermaidDiagram`（strict security） |

- 聊天用 `parseChatMarkdown`；报告/分享用 `parseReportMarkdown`（不识别 `result`，保持原文）。
- **流式文本可能只有半个占位符**：`MessageList` 有 partial-marker 清理逻辑；新增语法时同步处理。
- 结果引用只查当前 `message.results`；找不到显示“结果引用不可用”，不要发请求猜历史 artifact。
- 图表数据只能来自 `make_chart` 生成的 chart artifact；不要让前端从表格行自行计算图表。
- Mermaid 只用于结构/流程，不用于数据趋势/对比；`securityLevel: "strict"`，不要开 `htmlLabels`。

## 5. UI 约定

- 组件：`components/ui/` 是 Radix 包装层（Button/Input/Textarea/Select/Dialog/Sheet/Tooltip/Spinner）。新交互优先复用；不要引入 shadcn/Tailwind 4 或第二套设计系统。
- 样式：Tailwind 3.4 + 语义 token（`bg-canvas/surface/subtle`、`text-ink/inksoft/muted`、`border-line`、`brand*`）。不要硬编码十六进制颜色，除非已有图表/品牌例外。
- 抽屉/弹窗：管理页统一用 `Sheet`；确认操作 `ConfirmDialog`；结果详情 `Dialog`。
- 图标按钮必须有 `aria-label` + `Tooltip`；**不要用原生 `title`**（无法键盘/触屏访问，样式也不一致）。
- 空态/加载/错误三态都要有；列表加载更多用游标，不要一次性拉全量。
- 禁用按钮的说明放在 Tooltip/文案里，不要只靠 `opacity`。
- 表单错误贴近字段显示；提交中禁用重复提交；`ApiError.message` 可直接展示，但不要泄露 details 中的敏感信息。

## 6. 组件模式

- 受控组件优先；本地 UI 状态留在组件内，跨组件状态才提升或进 Query。
- `Composer` 是复杂输入的唯一入口：slash 技能、模型/思考级别、上下文占用、只读锁定都在这里；不要另做起草框。
- 结果表格：`ResultTable` 负责预览 100 行 + 加载更多/导出；全量查看用 `ResultDetailDialog`，不要新写一套表格。
- 长列表（消息、抽屉）用 `overflow-y-auto` + `min-h-0`；不要用 `h-screen` 嵌套滚动。
- 可访问性：对话框标题/描述、`aria-current` 导航、switch `role`、focus ring 不要移除。

## 7. 测试

- 运行：`pnpm --filter @datachat/web test`；单文件：
  `pnpm --filter @datachat/web exec vitest run src/components/chat/Foo.test.tsx`
- 环境：jsdom；`src/test/setup.ts` 已补 Radix 需要的 pointer capture / scrollIntoView / ResizeObserver。
- 常用包装：

```tsx
render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={["/chat/c-1"]}>
      <Routes><Route path="/chat/:conversationId" element={<ChatPage />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
```

- 页面级测试通常 stub `fetch`（参考 `ChatPage.test.tsx` 的 `stubFetch`）；组件级测试 mock `lib/api` 模块。
- 交互用 `userEvent`，异步用 `findBy*`/`waitFor`；不要用固定 `setTimeout`。
- 测试用户可见行为（role/label/text），不要断言实现细节或 snapshots。
- 修改 `ConversationSidebar` 等共享组件时，检查 `App.test.tsx` 是否依赖按钮文案。

## 8. 常见坑

- 根 vitest 不跑 web；只跑 `pnpm test` 会误以为前端通过。
- Radix Tooltip 每个实例自带 Provider；在测试中 `getByRole("button", { name })` 通常能命中 `aria-label`。
- `queryKey` 不包含筛选参数会导致搜索不刷新；包含整个对象时注意引用稳定性。
- SSE 重连要用 `after`/`Last-Event-ID`；不要只靠内存事件。
- 报告/分享页与聊天页共用 Markdown 解析器；改协议必须四处同改（chat/report/share/stream）。
- 删除/重命名会话后 invalidate 列表和详情；只改本地数组会与后台不一致。
