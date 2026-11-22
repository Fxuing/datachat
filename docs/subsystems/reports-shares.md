# 报告与公开分享

报告是保存下来的 Markdown 文档，引用查询结果 artifact。公开分享是通过不可猜测的 token 访问某个报告/会话的只读投影。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 表 | `reports`、`shares`、`artifacts` | [`schema.ts`](../../apps/server/src/db/schema.ts) |
| 报告创建 | 归属、artifact 成员校验、Markdown 生成 | [`reports.ts`](../../apps/server/src/services/reports.ts) |
| 报告工具 | 面向模型的 `create_report`、权限门禁 | [`create-report.ts`](../../apps/server/src/agent/tools/create-report.ts) |
| 路由 | 报告列表/详情/编辑/删除；分享创建/撤销 | [`reports.ts` 路由](../../apps/server/src/routes/reports.ts)、[`shares.ts` 路由](../../apps/server/src/routes/shares.ts) |
| 公开解析 | token 查找、过期/撤销、投影 | [`shares.ts`](../../apps/server/src/services/shares.ts) |
| 报告 UI | Markdown、artifact、在线编辑、分享/导出（MD/HTML/打印） | [`ReportPage.tsx`](../../apps/web/src/pages/ReportPage.tsx)、[`report-export.ts`](../../apps/web/src/lib/report-export.ts) |
| 公开 UI | 匿名报告/会话视图 | [`PublicSharePage.tsx`](../../apps/web/src/pages/PublicSharePage.tsx) |

常量：`REPORT_MAX_ARTIFACTS = 20`、`REPORT_MAX_MARKDOWN_LENGTH = 50_000`、`SHARE_MAX_ROWS = 100`，有效期 1–365 天（默认 7 天）。

## 报告路径

1. `create_report` 需要 `report.create`，检查会话属于当前用户，并校验每个 artifact id：属于该用户、同一会话、不重复。缺失/他人的 artifact 一律拒绝。
2. 未提供 Markdown 时，服务根据引用的 artifact（列 + 预览行）生成；提供的 Markdown 要校验长度/数量。
3. 报告保存 `markdown` 和 `artifact_ids`（JSON），不复制行数据；渲染报告时解析当前 artifact 内容。
4. 报告详情可由属主或管理员读取。缺失和他人报告返回相同的 not-found 形状。
5. `PATCH /api/reports/:id` 需要 `report.create` 权限与可读/范围内归属校验，只允许修改 `title` 与 `markdown`（更新 `updated_at`），不允许修改 `artifact_ids`（防止引用越权 artifact）；缺失/他人/越范围报告返回相同 `404`。
6. 删除报告不删除底层 artifact；删除会话/artifact 可能让报告里的结果卡片不可用。
7. 报告页支持导出 `.md` 与离线自包含 `.html`（将 ECharts `<canvas>` 转为内嵌 PNG 并移除交互按钮），以及浏览器打印 PDF。

报告用 `[[artifact:<id>]]` 渲染结果卡片，可以包含 Mermaid 代码块。`[[result:<id>]]` 是聊天专用的，在报告 Markdown 中保持字面量。

## 分享路径

1. 创建分享需要对应功能权限（`share.create`）和归属。原始 token 随机生成，并且**只返回一次**；只保存 `sha256(token)`。
2. 分享目标是一个会话或一个报告，有效期为 1–365 天。撤销设置 `revoked_at`；过期/撤销/未知 token 都返回相同的“分享不可用”响应。
3. `GET /api/public/shares/:token` 不需要登录。它解析当前的会话/报告，应用属主数据，返回每个结果最多 `SHARE_MAX_ROWS` 行的投影。不能暴露 SQL、凭据、其他会话或未分享的 artifact。
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
