# DataChat 实现计划 04 — 交付与运营面

> **实施状态：已交付。** 下方复选框保留为原始执行模板，未逐项回填；实际交付、计划外能力与差异见 [`docs/roadmap.md`](../../roadmap.md)。

> 依据 `docs/superpowers/specs/2026-11-06-datachat-design.md` §7.2/§7.4/§11/§13/§14/§16。
> 前置：Plan 1–3 已完成；分支 `feat/foundation`。
> 执行方式：批量 worker，每个 Task 一个提交，最后统一评审。

## 范围

1. 数据源管理页（让用户摆脱 curl）
2. 报告（确定性拼装 + Agent 工具 + 打印）
3. 分享（token 只存 hash、公开只读页、410）
4. 审计页、全局设置页
5. Docker Compose 部署
6. 最终验证与浏览器冒烟

## 通用约束

- ESM `.js` 后缀；TS strict；服务端错误 `{error:{code,message}}`；审计不记录密钥/连接串。
- 公开接口只返回白名单字段；`Cache-Control: no-store`。
- 新增路由都要 `authenticate`/`requireAdmin`；对象级授权用 `userCanAccess` 模式。
- 前端不引入 `rehype-raw`；所有 markdown 禁原始 HTML。
- 每个 Task 结束跑 `pnpm typecheck`；Task 内新增测试；最后 `pnpm verify`。

---

## Task 1 数据源管理页

服务端已具备 `/api/datasources` CRUD/test/refresh-schema/schema 与 grants 接口，仅补必要字段。

前端：
- `apps/web/src/pages/admin/DatasourcesPage.tsx`，路由 `/admin/datasources`（RequireAdmin），侧栏入口。
- 列表：名称/类型/host:port/database/状态（ok/error/unknown + 只读标记）/最近检查；行操作：测试、刷新 schema、查看 schema、授权、编辑、删除。
- 新建/编辑对话框：name、type(mysql|postgres)、host、port（按类型默认 3306/5432）、database、username、password（编辑时留空=不变）、sslMode(disable|require|no-verify)。提交前前端校验，展示服务端 `DS_UNREACHABLE`/`CONFLICT`/`HOST_NOT_ALLOWED`。
- schema 抽屉：表列表 + 搜索 + 分页，展开看列（类型/可空/PK/FK/注释）。
- 授权对话框：用户多选（GET /admin/users），PUT `/api/admin/datasources/:id/grants`。
- 删除：409 时提示“存在会话，无法删除”。

测试：编辑不提交空密码；类型切换改默认端口；409 提示；授权提交 body；schema 搜索。

提交：`feat: add datasource admin page`

## Task 2 报告 API + `create_report` 工具

- `apps/server/src/db/repositories/reports.ts`：insert/get/listByConversation/delete，`artifactIdsJson`。
- `apps/server/src/services/reports.ts`：
  - `buildReportMarkdown(artifacts)`：每个 artifact 一节，含标题、SQL（若取得到）、`[[artifact:<id>]]` 占位、表格/图表说明。
  - `createReport({db,userId,conversationId,title,artifactIds})`：校验会话属主、artifact 属主且同会话、非空、≤20 个；生成 markdown 与标题（缺省“分析报告 YYYY-MM-DD HH:mm”）。
- 路由 `apps/server/src/routes/reports.ts`：`POST /api/reports`、`GET /api/reports/:id`、`DELETE /api/reports/:id`（owner/admin）。
- 工具 `apps/server/src/agent/tools/create-report.ts`：参数 `title?`、`markdown`（≤50000）、`artifactIds`；校验后落库，返回 `{reportId,title,url:"/reports/<id>"}`；注册进 `buildAgentTools`，系统提示词加“报告时调用 create_report，正文用 [[artifact:id]] 引用结果”。
- shared：`ReportSummary`/`ReportDetail` 类型。

测试：属主/跨会话拒绝、空 artifactIds、标题缺省、工具落库、markdown 含占位、GET 授权。

提交：`feat: add reports api and create_report tool`

## Task 3 报告页与打印

- `apps/web/src/pages/ReportPage.tsx`，路由 `/reports/:id`（RequireAuth）。
- 渲染：标题、时间、markdown（react-markdown，无 raw HTML）、`[[artifact:<id>]]` 替换为图表（EChart）或表格前 100 行；未知 artifact 显示占位。
- 工具栏：打印（`window.print()`）、分享、删除（确认后回会话）。
- 打印样式 `@media print`：隐藏侧栏/工具栏，白底、分页避断。
- 聊天页：结果卡增加“生成报告”按钮 → `POST /api/reports {conversationId, artifactIds:[id]}` → 跳转；助手消息中的 `/reports/<id>` 链接可点。

测试：占位解析、缺省标题、打印按钮调用、删除确认。

提交：`feat: add report page and print styles`

## Task 4 分享

- `apps/server/src/services/shares.ts`：
  - `createShare({db,userId,conversationId?,reportId?,expiresInDays=7})`：二选一；校验属主；`token=base64url(randomBytes(32))`；存 `sha256(token)`；返回 `{id,token,url,expiresAt}`（仅此一次）。
  - `resolveShare(token)`：hash 查询；revoked/expired → `410 SHARE_GONE`；返回目标。
  - `revokeShare`：owner/admin。
- 路由：`POST /api/shares`、`DELETE /api/shares/:id`、`GET /api/public/shares/:token`（无鉴权）。
  - 公开响应白名单：
    - 会话：`{type:"conversation",title,messages:[{role,text,sql?,columns?,rows?(≤100),chart?}]}`
    - 报告：`{type:"report",title,markdown,artifacts:[{id,kind,columns?,rows?(≤100),spec?}]}`
  - 不含 userId/username/datasource/host/audit/runId；`Cache-Control: no-store`。
- 前端：`ShareDialog`（有效期 1/7/30 天，创建后显示链接+复制，提示只显示一次）；聊天页/报告页入口；`/s/:token` 公开页（无 AppShell、无用户信息、410 提示）。
- 测试：明文 token 不落库、过期/撤销 410、白名单字段、跨用户创建 403、公开页 100 行截断。

提交：`feat: add share links and public page`

## Task 5 审计页

- `GET /api/admin/audit`：filters `userId/datasourceId/action/status/from/to`，`limit≤200` + `offset`，返回 `{items,total}`，按 `created_at desc`；`detail_json` 仅管理员可见。
- `apps/web/src/pages/admin/AuditPage.tsx`：筛选栏（用户下拉、数据源下拉、动作、状态、时间范围）、表格（时间/用户/动作/数据源/状态/耗时/行数）、详情抽屉（SQL、错误、detail JSON）。
- 测试：过滤组合、分页、权限、详情渲染。

提交：`feat: add audit log page`

## Task 6 全局设置

- `GET/PUT /api/admin/settings`：允许键 `defaultModelId`、`queryMaxRows`(1..100000)、`queryPreviewRows`(1..1000)、`queryTimeoutMs`(1000..300000)、`shareMaxDays`(1..365)；zod 校验；存 `settings.value_json`。
- `defaultModelId` 影响 `GET /api/models` 的 `default` 与新会话初始模型（不存在或未配置则回退首个）。
- `apps/web/src/pages/admin/SettingsPage.tsx`：表单 + 保存 + 恢复默认；侧栏入口。
- 测试：校验边界、持久化、default 生效、非管理员 403。

提交：`feat: add admin settings`

## Task 7 Docker Compose

- `deploy/Dockerfile`：多阶段 `node:22-bookworm-slim`，corepack pnpm，安装→build→裁剪；运行 `node apps/server/dist/index.js`；非 root 用户；`HEALTHCHECK` 打 `/api/health`。
- `deploy/nginx.conf`：静态 `apps/web/dist`，SPA fallback，`/api` 反代 server，SSE `proxy_buffering off`、`proxy_read_timeout 3600s`、`X-Accel-Buffering: no`。
- `docker-compose.yml`：`server` + `web`，命名卷 `datachat-data:/data`，env 从 `.env`，`restart: unless-stopped`。
- README 部署段；`.dockerignore`。
- 本机 Docker 不可用时只做静态校验（`docker compose config` 若可用），并在报告标注未实跑。

提交：`chore: add docker deployment`

## Task 8 验证与浏览器冒烟

- `pnpm verify` 全绿；`node scripts/smoke-server.mjs`；`node scripts/smoke-agent.mjs`。
- 手工路径（有真实 MySQL/PG 时）：登录→建数据源→测试→建会话→提问→图表→导出→报告→分享→匿名打开→撤销→410→审计可见。
- Playwright：若浏览器可安装，覆盖登录 + 数据源页（mock API）+ 分享 410；否则记录为环境限制，不阻塞。
- 更新 README 验收清单与已知限制。

提交：`chore: verify delivery features`

---

## 验收标准

- 管理员可完全通过 UI 建/改/测/授权/删数据源，无需 curl。
- 任意查询结果可生成报告并在报告页打印；报告可分享为匿名链接，撤销后 410。
- 审计页能查到登录、数据源、授权、技能、MCP、查询、导出动作。
- 设置修改后新会话使用新默认模型/查询上限。
- `docker compose up` 的配置在静态检查下有效；无 Docker 环境时明确标注未实跑。
