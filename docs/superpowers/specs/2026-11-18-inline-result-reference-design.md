# 正文结果引用（Inline Result Reference）设计

- 状态：待实现
- 日期：2026-11-18
- 范围：DataChat 聊天正文；不改变报告、分享页和结果表的数据接口

## 1. 背景

查询结果目前固定显示在“执行过程”折叠块里。部分用户不会展开执行过程，而是一直要求模型“把全部数据列出来”。当结果有几万行时，模型既无法在一次回复中输出全部行，也不应该把整张表粘进正文。

需要给模型一个受控的方式，在正文里指向已经返回的查询结果，让用户一键打开完整表格；正文仍然只保留结论和关键数字。

目标：

1. 模型可以在回答里插入一个结果入口，点击后打开现有结果详情弹窗。
2. 入口不复制数据、不新增接口，直接复用当前轮已返回的 `ChatResult`。
3. 明确“完整数据在表格里”，避免模型承诺逐行输出几万行。
4. 不改变现有 `[[artifact]]`、`[[chart]]`、报告和分享页的行为。

非目标（第一版）：

- 不自动为每个查询结果生成正文链接；只由模型按需插入。
- 不支持跨轮次/历史 artifact 的按 id 拉取；只引用当前消息中已有的结果。
- 不修改结果表的分页、加载更多、导出逻辑。
- 不在报告正文中支持 `[[result]]`。

## 2. 语法与交互

### 2.1 标记

聊天正文新增：

```text
[[result:<artifactId>]]
```

- 只允许出现在普通聊天回复中。
- 报告正文继续使用 `[[artifact:<id>]]`。
- 标记单独占一行或作为自然段的一部分均可，前端解析后替换为一行链接。
- 模型应只引用“本次查询返回的结果”，不要凭空写 id。

### 2.2 展示

解析到 `result` 段后，在正文位置渲染：

```text
[表格图标] 查看完整结果（12,345 行）
```

点击后打开与结果卡相同的详情弹窗：

- 表格列、已加载的行、`rowCount`、`truncated` 状态；
- 有 SQL 时保留“查看 SQL”；
- 结果表原有的“加载更多”和导出能力继续可用。

链接是行内按钮，不渲染完整结果卡，不把表格内容复制到正文。

### 2.3 大结果集行为

用户说“给我全部数据”“全部列出来”时：

- 模型不得承诺在对话里逐行输出全部结果；
- 应说明完整结果已保存在结果表中，正文给出 `[[result:<id>]]` 入口；
- 正文最多给结论、关键数字或少量代表性行，不粘贴几万行；
- 用户可以在弹窗中继续加载和导出完整数据。

这是提示词层面的行为约束；前端不根据行数自动改写模型回答，也不设置会截断用户查看能力的硬阈值。

## 3. 前端设计

### 3.1 解析器

`apps/web/src/lib/report-markdown.ts`：

- 新增 `ChatSegment`，在现有 `ReportSegment` 基础上增加：

```ts
{ type: "result"; artifactId: string }
```

- 抽出内部解析函数，支持 `includeResults` 开关：
  - `parseReportMarkdown(markdown)`：继续只返回 markdown/artifact/chart；遇到 `[[result:id]]` 时按普通文本保留，避免报告页误当成 artifact。
  - `parseChatMarkdown(markdown)`：额外识别 `result`。
- 标记正则扩展为 `artifact|chart|result`，artifactId 仍沿用当前的 `[^\]\s]+` 规则。
- 只有完整闭合的 `]]` 才切分；流式中的半截标记继续作为 markdown，避免渲染出错误链接。

### 3.2 复用详情弹窗

从 `apps/web/src/components/chat/ResultCard.tsx` 抽出私有 `ResultDetailDialog` 到：

`apps/web/src/components/chat/ResultDetailDialog.tsx`

职责保持不变：标题、`max-w-5xl`、表格容器、可选 SQL。`ResultCard` 改为引用它；新链接组件也引用同一弹窗，避免两套详情 UI。

### 3.3 新增结果链接

新增 `apps/web/src/components/chat/ResultLink.tsx`：

```ts
interface ResultLinkProps {
  result: ChatResult;
  canExport?: boolean;
}
```

- 使用 `useState` 控制弹窗开关。
- 行内按钮：`Table2` 图标 + `查看完整结果（<formatCount(rowCount)> 行）`。
- 点击打开 `ResultDetailDialog`，内部渲染：

```tsx
<ResultTable
  {...result}
  embedded
  maxBodyHeightClass="max-h-[60vh]"
  canExport={canExport}
/>
```

- 使用 `aria-haspopup="dialog"`，按钮有可读名称。
- 样式为低干扰文本链接，不抢正文结论的注意力。

### 3.4 MessageItem

`apps/web/src/components/chat/MessageItem.tsx`：

- 改用 `parseChatMarkdown`。
- `referenced` 继续收集所有非 markdown 段的 `artifactId`，这样正文引用过的结果不会再在下方重复渲染。
- 遇到 `result` 段：
  - 在 `message.results` 中按 `artifactId` 查找；
  - 找到则渲染 `<ResultLink result={result} canExport={canExport} />`；
  - 找不到则渲染“结果引用不可用：<id>”，不发起网络请求。
- `[[artifact]]` 的 `InlineArtifact` 行为不变。

### 3.5 流式消息

`apps/web/src/components/chat/MessageList.tsx`：

- 改用 `parseChatMarkdown` 解析流式文本。
- `inlineResults` 同时收集 `artifact` 和 `result` 段，避免结果卡在正文链接之外重复出现。
- 流式期间找到 `result` 就渲染 `ResultLink`；结果尚未进入 `stream.results` 时先不渲染，不显示原始标记。
- 非 `chartsReady` 阶段清理半截标记的正则加入 `result`，避免出现 `[[result:...` 文本。

### 3.6 报告与分享页

`apps/web/src/pages/ReportPage.tsx` 和 `apps/web/src/pages/PublicSharePage.tsx` 继续使用 `parseReportMarkdown`，不识别 `result`。因此报告里的 `[[result:id]]` 只会作为普通文本出现，不会误渲染成 artifact 卡片。

## 4. Prompt 约束

`agent/prompts/system.md` 增加两条规则：

1. 在“工作方式”的结果说明中：
   - 查询结果保存为 artifact；
   - 若需要用户查看某次查询的完整明细，在正文单独一行写 `[[result:<artifactId>]]`；
   - 该标记只用于普通聊天，报告继续用 `[[artifact:<id>]]`。
2. 在“回答方式”的大结果规则中：
   - 用户要求“全部数据/全部列出来”时，说明对话不适合逐行输出全部行；
   - 完整结果已保存在结果表，用 `[[result:<id>]]` 打开查看，支持继续加载和导出；
   - 正文最多给关键数字或少量示例行。

同时调整“结果表固定在执行过程”的表述：默认在执行过程；写了 `[[result]]` 时正文会出现一个查看入口，避免与新行为冲突。

## 5. 错误与边界

| 情况 | 行为 |
|---|---|
| `message.results` 中找不到 artifactId | 显示“结果引用不可用：<id>”，不请求服务端 |
| artifactId 格式异常但完整闭合 | 按 id 查找失败，走不可用提示 |
| 标记未闭合 | 按普通 markdown 文本显示 |
| 同一结果被写多次 | 每次标记都渲染链接；prompt 约束“最多一次”，不做额外去重 |
| 报告正文出现 `[[result]]` | 保留为普通文本，不影响报告 artifact 渲染 |
| 用户无 `export.data` | 弹窗仍可查看/加载更多，导出按钮按现有权限隐藏 |

## 6. 测试

- `apps/web/src/lib/report-markdown.test.ts`
  - `parseChatMarkdown` 正确切出 `result` 段；
  - `parseReportMarkdown` 不返回 `result` 段，标记保留为文本；
  - 未闭合标记不切分。
- `apps/web/src/components/chat/MessageItem.test.tsx`
  - 正文出现“查看完整结果（N 行）”；
  - 点击后弹窗显示列名/数据，且不重复渲染独立结果卡；
  - 找不到结果时显示不可用提示。
- `apps/web/src/components/chat/MessageList.test.tsx`
  - 流式文本中的 `result` 段渲染链接，不残留原始标记；
  - 对应结果不会重复出现在末尾。
- 现有 `ResultTable` / `ResultCard` 相关测试保持通过。

## 7. 实施顺序

1. 解析器扩展与单测。
2. 抽出 `ResultDetailDialog`，保持 `ResultCard` 测试通过。
3. 新增 `ResultLink`，接入 `MessageItem`。
4. 接入 `MessageList` 流式渲染。
5. 更新 prompt，补前端测试并跑 typecheck/vitest。
