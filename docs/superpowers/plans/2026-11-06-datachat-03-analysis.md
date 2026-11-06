# DataChat Plan 3 — 图表、导出、Skills 与 MCP 管理

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 在已完成的聊天链路上补齐「结果可视化 + 数据导出 + 语义层（Skills）+ 外部工具（MCP）」四块能力，形成可演示的分析产品。

**Architecture:** 图表由服务端工具 `make_chart` 读取 artifact 行并生成 ECharts option（存 `artifacts.spec_json`，kind=`chart`）；导出由服务端从 JSONL.gz 流式转为 CSV/XLSX；Skills/MCP 由管理员在 Web 后台维护，运行时按会话/数据源物化与加载。

**Tech Stack:** 现有 Plan 1/2 + `echarts`（web）、`exceljs`（server）、`@modelcontextprotocol/sdk`（MCP 连接测试）。

---

## 通用约束

- 分支 `feat/foundation`，HEAD 以 `git log -1` 为准；每个 Task 独立 commit。
- 服务端 ESM + `.js` 后缀；严格 TS；复用 `testConfig`/测试 helper。
- 所有 artifact 读取必须校验属主（`artifacts.user_id`）或会话归属；管理员接口走 `requireAdmin`。
- 导出/图表只读，不新增写库路径；审计沿用 `recordAudit`。
- 前端中文文案、无渐变、ECharts 按需引入 `echarts/core`。
- 不修改 Plan 1/2 已定型契约；需要扩展时在 Task 内说明并补测试。

---

## Task 1: Artifact 读取、分页与导出 API

**Files**
- Modify: `apps/server/src/services/artifacts.ts`（新增 `openRows`、`findMeta`）
- Create: `apps/server/src/services/export.ts`
- Create: `apps/server/src/routes/artifacts.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/artifacts-api.test.ts`、`apps/server/test/export.test.ts`

**Interfaces**

```ts
// artifacts.ts
async openRows(id: string): AsyncGenerator<unknown[], void, void>; // gunzip + readline(JSONL) + decodeRow
findMeta(id: string): ArtifactMeta | null;                          // 不读文件
```

- `openRows` 逐行 `JSON.parse` + `decodeRow`，流式；文件缺失抛 `ENOENT`（路由 410 `ARTIFACT_GONE`）。
- `GET /api/artifacts/:id`：`{id,kind,conversationId,rowCount,truncated,columns,createdAt,spec}`；非属主 404。
- `GET /api/artifacts/:id/rows?offset=0&limit=100`：`limit` 1..1000，返回 `{columns,rows,total}`；用 `openRows` 跳过 offset（最多扫到 offset+limit，不整文件入内存）；offset 越界返回空数组。
- `GET /api/artifacts/:id/download?format=csv|xlsx`：
  - 属主校验；`kind` 必须 `result`；`rowCount<=100000` 否则 413 `EXPORT_TOO_LARGE`。
  - `Content-Disposition: attachment; filename*=UTF-8''<encoded>.csv|xlsx`；`Cache-Control: no-store`。
  - 导出前 `recordAudit({action:"export", status:"ok", datasourceId, userId, conversationId, sqlText, rowCount})`；失败也记 `status:"error"`（不阻断已开始流）。
- `export.ts`：

```ts
export function csvStream(columns: ColumnInfo[], rows: AsyncIterable<unknown[]>): Readable;
export function xlsxStream(columns: ColumnInfo[], rows: AsyncIterable<unknown[]>): Readable;
```

  - CSV：`\uFEFF` BOM，RFC4180（含逗号/引号/换行加引号，`"`→`""`），null → 空串，Date → ISO，boolean → `true/false`。
  - XLSX：`exceljs` streaming workbook，首行加粗+冻结，列宽按前 200 行采样（min 10 / max 60），数值列写 number，null 留空。
  - 两者都通过 `pipeline` 写 `reply.raw`，客户端断开时销毁生成器（`try/finally`）。
- 依赖：`pnpm --filter @datachat/server add exceljs`。

**Tests**
- 属主/非属主；offset/limit；越界；`kind=chart` 下载 400。
- CSV：BOM、引号、逗号、换行、null、Date；行数与内容。
- XLSX：用 `exceljs` 读回，断言表头、number 类型、行数。
- 导出审计写入 `action=export`。

**Commit:** `feat: add artifact pagination and streaming export`

---

## Task 2: 图表引擎与 `make_chart` 工具

**Files**
- Create: `apps/server/src/services/charts.ts`
- Create: `apps/server/src/agent/tools/make-chart.ts`
- Modify: `apps/server/src/agent/tools/index.ts`（注册 `make_chart`）
- Modify: `apps/server/src/agent/event-bridge.ts`（`make_chart` 成功 → `chart` 事件）
- Test: `apps/server/test/charts.test.ts`、`apps/server/test/make-chart-tool.test.ts`

**Interfaces**

```ts
export interface ChartInput {
  type: "bar" | "line" | "area" | "pie" | "scatter";
  x: string; y: string; series?: string;
  aggregate?: "sum" | "avg" | "count" | "min" | "max";
  title?: string;
}
export function buildChartOption(input: {
  rows: unknown[][]; columns: ColumnInfo[]; chart: ChartInput;
}): { option: Record<string, unknown>; points: number };
```

- 列名大小写敏感匹配 `columns[].name`，缺失/重复 → `ChartError("COLUMN_NOT_FOUND")`。
- 数值转换：`Number(value)`，`NaN` 跳过并计数；y 列全非数值 → `ChartError("Y_NOT_NUMERIC")`。
- 聚合：按 `x`（+`series`）分组；`count` 计行数；无 `aggregate` 时要求每组唯一，否则报错提示指定聚合。
- 排序：x 为日期/数字按值升序，否则按聚合值降序；饼图取前 20，其余合并 `其他`。
- 上限 5000 点（分组后），超出报错 `TOO_MANY_POINTS` 并提示加筛选。
- 输出 ECharts option：`tooltip.trigger`（pie=item，其他=axis）、`legend`（有 series）、`grid`、`xAxis/yAxis`、`series[].type`（area→line+areaStyle）、`color` 用中性色板。
- `make_chart` 工具参数：`{artifactId, type, x, y, series?, aggregate?, title?}`；读取 `store.read(artifactId)`，校验 artifact 属主=当前用户且 `conversationId` 匹配；生成 option 后创建 chart artifact：`ArtifactStore.createChart({conversationId,userId,runId,columns,spec})`（JSON 存 `spec_json`，无 storage 文件，`rowCount=points`）；返回 `{chartArtifactId, points, type}` + `details` 供 `chart` 事件。
- `buildAgentTools` 只在有 `artifacts` 时注册 `make_chart`；系统提示词已有“图表基于 artifact”规则。

**`ArtifactStore.createChart`**：插入 `kind="chart"`、`storagePath=null`、`columnsJson`、`specJson`、`rowCount=points`；`read()` 对 chart 返回 `rows: []`。

**Tests**
- 聚合 sum/avg/count、series 分组、日期排序、饼图 Top20+其他、5000 上限、列缺失/非数值。
- 工具：成功写 chart artifact 并返回 details；他人 artifact → isError；`spec_json` 可被前端 JSON.parse。

**Commit:** `feat: add chart engine and make_chart tool`

---

## Task 3: 聊天页图表渲染与 artifact 操作

**Files**
- Create: `apps/web/src/components/chat/EChart.tsx`
- Create: `apps/web/src/components/chat/ChartCard.tsx`
- Create: `apps/web/src/components/chat/ArtifactActions.tsx`
- Modify: `apps/web/src/lib/run-events.ts`（`chart` 事件写入 `charts`）
- Modify: `apps/web/src/components/chat/MessageItem.tsx`、`ResultTable.tsx`、`ChatPage.tsx`
- Test: `apps/web/src/lib/run-events.test.ts`（补 chart）、`apps/web/src/components/chat/ResultTable.test.tsx`（补“加载更多”）

**Behavior**
- `EChart`：`echarts/core` + `BarChart/LineChart/PieChart/ScatterChart` + `GridComponent/TooltipComponent/LegendComponent` + `CanvasRenderer`；`useEffect` init/dispose，`ResizeObserver` 自适应；空 option 显示占位。
- `ChartCard`：标题、图、下载 PNG（`getDataURL`）、展开全屏（dialog）。
- 结果表底部：`下载 CSV` / `下载 Excel`（`<a href>` 带 cookie），`加载更多` 调 `/rows?offset&limit`，最多到 `rowCount`；加载中禁用。
- `chart` 事件 → `charts` 数组（按 chartArtifactId 去重）；`MessageItem` 在对应 run 下渲染图表；历史加载时从 `GET /conversations/:id` 的 `artifacts` 里恢复 chart spec（若无则按 artifact id 拉 `GET /artifacts/:id`）。
- 分享占位保持不变。

**Tests**
- reducer 处理 `chart` 去重；表格“加载更多”按钮在 `rowCount>preview` 时出现并追加行。
- 不引入快照测试。

**Commit:** `feat: render charts and artifact actions in chat`

---

## Task 4: Skills 管理 API

**Files**
- Create: `apps/server/src/routes/admin-skills.ts`
- Modify: `apps/server/src/app.ts`（`/api/admin/skills`）
- Test: `apps/server/test/admin-skills.test.ts`

**Endpoints**（全部 `requireAdmin` + 审计 `action:"skill_change"`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/skills` | `[{id,name,description,scope,datasourceId,enabled,updatedAt}]`（不含 content） |
| GET | `/api/admin/skills/:id` | 含 content |
| POST | `/api/admin/skills` | `{name,description,content,scope,datasourceId?,enabled?}` |
| PATCH | `/api/admin/skills/:id` | 同上可选字段 |
| DELETE | `/api/admin/skills/:id` | 删除 |
| POST | `/api/admin/skills/seed` | 重新导入内置 3 个技能（按 name 幂等） |

- 校验：name `^[a-z0-9][a-z0-9-]{1,63}$` 且唯一（scope+datasource 维度）；description 1..500；content 1..20000；scope=datasource 必须存在且 datasourceId 有效；global 不允许带 datasourceId。
- content 必须是合法 frontmatter（`---\nname: ...\ndescription: ...\n---\n`）；若与 name/description 不一致则服务端重写 frontmatter，避免运行时名称漂移。
- 冲突 409；未知 id 404。
- 审计详情只记 name/scope，不记 content。

**Tests**
- CRUD + 校验矩阵 + 409/404；seed 幂等；frontmatter 重写；审计行。

**Commit:** `feat: add admin skills api`

---

## Task 5: Skills 管理页

**Files**
- Create: `apps/web/src/pages/admin/SkillsPage.tsx`
- Create: `apps/web/src/components/admin/{SkillEditor,ConfirmDialog}.tsx`
- Modify: `apps/web/src/App.tsx`（`/admin/skills`，仅 admin 可见）
- Modify: `apps/web/src/components/AppShell.tsx`（管理入口）
- Test: `apps/web/src/pages/admin/SkillsPage.test.tsx`

**Behavior**
- 列表：name/scope/数据源/enabled/更新时间；筛选 scope；新建按钮。
- 编辑器（右侧抽屉或对话框）：name、description、scope、数据源下拉（仅 scope=datasource）、enabled、content（等宽 textarea，12 行）、保存/删除；未保存离开提示。
- seed 按钮“恢复内置技能”，二次确认。
- 非 admin 路由重定向 `/chat`；接口 403 显示提示。

**Tests**
- 渲染列表、创建调用正确 body、scope 切换清空 datasourceId、删除确认。

**Commit:** `feat: add admin skills page`

---

## Task 6: MCP 管理 API 与连接测试

**Files**
- Create: `apps/server/src/services/mcp-admin.ts`
- Create: `apps/server/src/routes/admin-mcp.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/package.json`（`@modelcontextprotocol/sdk`）
- Test: `apps/server/test/admin-mcp.test.ts`、`apps/server/test/mcp-test.test.ts`

**Endpoints**（`requireAdmin`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/mcp-servers` | 列表（env/headers 打码，返回 key 名与 `hasValue`） |
| POST | `/api/admin/mcp-servers` | `{name,transport,command?,args?,url?,env?,headers?,datasourceId?,enabled?}` |
| PATCH | `/api/admin/mcp-servers/:id` | 同上；env/headers 传对象则整体替换，传 `null` 清空 |
| DELETE | `/api/admin/mcp-servers/:id` | 删除 |
| POST | `/api/admin/mcp-servers/:id/test` | 15s 超时连接并 `tools/list`，返回 `{ok,tools:[{name,description}],serverInfo?,error?}` |

- 校验：name `^[a-z0-9][a-z0-9-_]{1,63}$` 唯一；transport=stdio 必须有 command 且无 url；http 必须有 `http(s)://` url 且无 command；args ≤20 个、env/headers ≤30 项、值 ≤2000 字符。
- 加密：env/headers 整对象 `JSON.stringify` 后 AES-256-GCM（复用 datasource `encryptSecret`/`decryptSecret`，若未导出则抽出 `services/secrets.ts`）；列表/详情不解密值。
- 测试连接：`Client` + `StdioClientTransport`（command/args/env）或 `StreamableHTTPClientTransport`（url/headers）；`Promise.race` 15s；成功后 `close()`；错误脱敏（不返回 env/headers）。
- 审计 `action:"mcp_change"`，detail 记 name/transport/enabled。
- 运行时 `loadMcpFor` 已读表；新增/修改后无需重启（下次会话创建生效），在响应里说明。

**Tests**
- CRUD + 校验；密文可被 `loadMcpFor` 解回；列表不泄露值；测试连接用本地假 stdio server（`node -e` 脚本？）或 mock transport；超时路径返回 504 风格错误；审计。

**Commit:** `feat: add admin mcp api and connection test`

---

## Task 7: MCP 管理页

**Files**
- Create: `apps/web/src/pages/admin/McpPage.tsx`
- Create: `apps/web/src/components/admin/McpEditor.tsx`
- Modify: `apps/web/src/App.tsx`、`AppShell.tsx`
- Test: `apps/web/src/pages/admin/McpPage.test.tsx`

**Behavior**
- 列表：name/transport/scope/enabled/最近测试状态（本地 state，不持久化）；新建/编辑/删除。
- 表单：transport 切换显示 command/args（每行一个）或 url；env/headers 键值对编辑器（值 password 输入，编辑时留空表示不变）；数据源下拉（可空=全局）；enabled。
- “测试连接”按钮：loading、成功显示工具数与前 5 个工具名、失败显示脱敏错误。
- 保存后刷新列表；未保存离开提示。

**Tests**
- 表单切换、键值对序列化、测试按钮渲染结果、提交 body。

**Commit:** `feat: add admin mcp page`

---

## Task 8: 验证与文档

**Files**
- Modify: `README.md`（图表/导出/技能/MCP 使用说明）
- Test: `apps/server/test/artifacts-api.test.ts` 补大文件流式（1000 行）

**Steps**
1. `pnpm verify` 全绿（含 web tests/build）。
2. 手工：登录 → 提问 → 图表（“按月统计订单金额并画柱状图”）→ 下载 CSV/Excel → 管理员新建技能（改口径）→ 新会话验证生效 → 配置一个 MCP（如 filesystem）→ 测试连接 → 新会话中模型可见其工具。
3. 无 DB/Docker 时：图表/导出用 e2e fake artifact 验证；MCP 测试用本地假 server；技能链路可完整验证。
4. 记录证据到最终报告（事件、审计行、下载文件大小）。

**Commit:** `chore: verify analysis features`

---

## 验收标准

- [ ] 模型能对查询结果生成柱/线/饼/散点图，前端渲染并可下载 PNG。
- [ ] CSV/Excel 导出内容正确（BOM、转义、数值类型），写入 `action=export` 审计。
- [ ] 管理员可增删改 Skills，数据源级覆盖全局，下一会话生效。
- [ ] 管理员可配置 stdio/http MCP，测试连接有 15s 超时与脱敏错误，运行时工具可见。
- [ ] 所有 artifact 访问有属主校验；导出/图表无越权。
- [ ] `pnpm verify` 绿。
