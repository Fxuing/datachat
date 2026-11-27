# 报告与公开分享

报告是保存下来的 Markdown 文档，引用查询结果 artifact。公开分享是通过不可猜测的 token 访问某个报告/会话的只读投影。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 表 | `reports`、`shares`、`artifacts` | [`schema.ts`](../../apps/server/src/db/schema.ts) |
| 报告创建 | 归属、artifact 成员校验、Markdown 生成 | [`reports.ts`](../../apps/server/src/services/reports.ts) |
| 报告工具 | 面向模型的 `create_report`、权限门禁 | [`create-report.ts`](../../apps/server/src/agent/tools/create-report.ts) |
| 路由 | 报告列表/详情/编辑/删除；分享列表/创建/撤销 | [`reports.ts` 路由](../../apps/server/src/routes/reports.ts)、[`shares.ts` 路由](../../apps/server/src/routes/shares.ts) |
| 公开解析 | token 查找、过期/撤销、投影 | [`shares.ts`](../../apps/server/src/services/shares.ts) |
| 报告与分享 UI | 报告中心/我的分享、Markdown/artifact/在线编辑、分享/打印与悬浮导出（MD/HTML/Word） | [`ReportsPage.tsx`](../../apps/web/src/pages/ReportsPage.tsx)、[`ReportPage.tsx`](../../apps/web/src/pages/ReportPage.tsx)、[`ShareDialog.tsx`](../../apps/web/src/components/ShareDialog.tsx)、[`ReportExportFab.tsx`](../../apps/web/src/components/report/ReportExportFab.tsx)、[`report-export.ts`](../../apps/web/src/lib/report-export.ts)、[`report-docx.ts`](../../apps/web/src/lib/report-docx.ts)、[`mermaid-render.ts`](../../apps/web/src/components/markdown/mermaid-render.ts) |
| 公开 UI | 匿名报告/会话视图 | [`PublicSharePage.tsx`](../../apps/web/src/pages/PublicSharePage.tsx) |

常量：`REPORT_MAX_ARTIFACTS = 20`、`REPORT_MAX_MARKDOWN_LENGTH = 50_000`、`SHARE_MAX_ROWS = 100`，有效期 1–365 天（默认 7 天）。

## 报告路径

1. `create_report` 需要 `report.create`，检查会话属于当前用户，并校验每个 artifact id：属于该用户、同一会话、不重复。缺失/他人的 artifact 一律拒绝。`create_report` 工具说明及 [`system.md`](../../agent/prompts/system.md) 明确告知模型报告详情页原生支持导出 Word（`.docx`）、HTML、Markdown 与打印 PDF，引导用户前往报告详情页导出，不在聊天中伪造导出文件。
2. 未提供 Markdown 时，服务根据引用的 artifact（列 + 预览行）生成；提供的 Markdown 要校验长度/数量。
3. 报告保存 `markdown` 和 `artifact_ids`（JSON），不复制行数据；渲染报告时解析当前 artifact 内容。
4. `GET /api/reports` 按当前登录用户列出自有报告，支持标题 `q`（`instr(lower(...))` 字面匹配）、`source`（`chat`/`scheduled`）、`datasourceId` 筛选与分页，并在返回前逐条执行 `reportScopeVisible` 过滤，对超出当前部门范围的受控历史报告予以隐藏。报告详情可由属主或管理员读取。缺失和他人报告返回相同的 not-found 形状。
5. `PATCH /api/reports/:id` 需要 `report.create` 权限与可读/范围内归属校验，只允许修改 `title` 与 `markdown`（更新 `updated_at`），不允许修改 `artifact_ids`（防止引用越权 artifact）；缺失/他人/越范围报告返回相同 `404`。
6. 删除报告会通过 `revokeSharesForReport` 同步撤销该报告名下未撤销的公开分享，但不删除底层 artifact；删除会话/artifact 可能让报告里的结果卡片不可用。
7. 报告中心（[`ReportsPage.tsx`](../../apps/web/src/pages/ReportsPage.tsx)，路由 `/reports`）提供「我的报告」集中检索/一键导出 Word/HTML/MD/分享/跳回来源对话，以及「我的分享」集中核查状态与撤销；管理员在设置页「分享」分栏可查看并撤销全站活跃分享。报告页在阅读区右下角提供悬浮导出按钮（编辑态和打印时自动隐藏），点击弹出 3 个导出选项：`.md`、离线自包含 `.html`（将 ECharts `<canvas>` 转为内嵌 PNG 并移除交互按钮），以及按需懒加载生成的标准 `.docx` Word 文档（保留标题/正文/列表/引用/代码块与原生表格，将 ECharts 与 Mermaid SVG 栅格化为 PNG 嵌入，受限环境下的 Mermaid 降级为源码代码块）；在暗色模式下，HTML 与 Word 导出均会将 ECharts 和 Mermaid 重新按亮色白底主题渲染后再导出；浏览器打印保留在顶栏。

报告用 `[[artifact:<id>]]` 渲染结果卡片，可以包含 Mermaid 代码块。`[[result:<id>]]` 是聊天专用的，在报告 Markdown 中保持字面量。

## 分享路径

1. 创建分享需要对应功能权限（`share.create`）和归属。原始 token 随机生成，并且**只返回一次**；只保存 `sha256(token)`。`GET /api/shares` 仅返回目标元数据、有效期与状态（支持按目标过滤、`status=active|all` 及管理员 `scope=all`），绝不返回 `token` 或 `tokenHash`；`ShareDialog` 可直接列出并撤销当前目标下已生效的链接。
2. 分享目标是一个会话或一个报告，有效期为 1–365 天。撤销设置 `revoked_at`；过期/撤销/未知 token 都返回相同的“分享不可用”响应。
3. `GET /api/public/shares/:token` 不需要登录。它解析当前的会话/报告，应用属主数据，返回每个结果最多 `SHARE_MAX_ROWS` 行的投影。不能暴露 SQL、凭据、其他会话或未分享的 artifact。会话公开投影在服务端按阅读顺序把正文中的 `[[chart:<id>]]`、`[[result:<id>|标题]]`、`[[artifact:<id>]]` 解析替换成脱敏图表/结果消息（剥离 `[[excel:]]`/`[[report:]]` 且不回显任何内部 artifact id，也不将报告专属图表当作孤儿图表输出）；公开分享页使用全局 `.markdown` 样式表与横向滚动表格容器渲染 Markdown 表格和正文，并将会话回复里的 `[查看完整报告](/reports/<id>)` 链接重写到公开子路由 `/s/:token/reports/:reportId`。服务端 `GET /api/public/shares/:token/reports/:reportId` 同样免登录，但仅当 `token` 为有效未受控的会话分享且目标报告严格属于同一 `conversationId` 与属主时才返回投影，否则一律返回 `410 SHARE_GONE`，并带「返回对话」回到 `/s/:token`。此外，公开分享页按内容类型复用桌面端导航体验：3 轮及以上对话在右侧展示 `ConversationMinimap`（按提问轮次定位与跳转），包含多级标题的报告在左侧展示 `ReportToc` 目录导航。
4. 分享是**实时投影，不是不可变快照**。删除报告、会话或 artifact 可能让它不可用或不完整；UI 必须处理。不要声称历史不可变。
5. 数据源启用行级数据权限后，该数据源下的报告/会话不能再公开分享：新建返回 `409 SHARE_DISABLED_BY_SCOPE`，已有链接解析同样失败。启用动作会撤销该数据源下所有未撤销分享；关闭受控不会自动恢复旧 token。
6. 公开响应是只读的，不能创建 run、报告、分享或通知。限流和缓存头不应泄露 token 在过期前是否存在。

## 契约

- **每次创建/撤销前都检查归属。** 他人的报告/分享返回 `404`，不是 `403`。
- **artifact id 不是信任边界。** 创建报告和公开投影时都要重新检查属主 + 会话。
- **token 是 bearer secret。** 绝不记录原始 token、明文保存、写进分析或在列表响应中返回。只存 hash。
- **公开渲染要消毒。** Markdown/HTML 走同一套安全渲染器；不允许任意链接/脚本，公开页面不能调用认证 API。
- **`[[result:...]]` 不能变成公开数据泄露。** 它只在聊天中使用；报告和公开解析器保持字面量或忽略它。
- **删除是显式的。** 删除报告/会话时撤销分享；不要留下能解析到无关数据的 token。

## 失败行为

| 情况 | 行为 |
| --- | --- |
| 他人/缺失报告 | `404`（同一形状） |
| 受控数据源上的分享 | 创建 `409 SHARE_DISABLED_BY_SCOPE`；解析“分享不可用” |
| 无效/他人 artifact | `400`/`ARTIFACT_NOT_FOUND`；不创建报告 |
| artifact/Markdown 过多 | 校验错误；不产生部分报告 |
| 分享 token 过期/撤销/未知 | 统一 `SHARE_GONE` |
| 分享后删除报告 | 分享不可用；不要回退 |
| artifact 被删除 | 结果卡片不可用；报告其余部分仍渲染 |
| 公开请求尝试写操作 | `405`/`404`；不能绕过认证 |

## 验证

```bash
pnpm exec vitest run apps/server/test/reports.test.ts \
  apps/server/test/shares.test.ts
pnpm --filter @datachat/web exec vitest run \
  src/pages/ReportPage.test.tsx \
  src/pages/PublicSharePage.test.tsx
```

分享改动需要过期/撤销/他人 token 测试，以及证明不会返回 SQL/凭据/其他用户数据的投影测试。报告改动需要跨会话 artifact 拒绝测试。
