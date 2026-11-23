# 开放平台（Open API、MCP Server 与 Webhook）

开放平台把 DataChat 的语义层、受守卫只读 NL2SQL、行级数据权限、多步 Agent 问答与模板化报告能力以标准化接口暴露给外部业务系统。所有外部请求均经过与 Web 聊天相同的 `guardSql` → `applyScopeToSql` → `executeReadOnly` 安全链路，绝不绕过守卫或凭据加密边界。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 表 | 应用配置、哈希密钥、外部会话映射、调用审计、Webhook 投递日志 | [`schema.ts`](../../apps/server/src/db/schema.ts)（`open_apps`、`open_api_keys`、`open_app_sessions`、`open_api_audit`、`open_webhook_deliveries`） |
| 仓储 | 应用/密钥/会话/审计/统计/Webhook 持久化 | [`open-platform.ts`](../../apps/server/src/db/repositories/open-platform.ts) |
| 认证与身份 | API Key 生成与校验、Scope 门禁、终端用户与部门范围 fail-closed 解析、RPM 滑动窗口限流 | [`open-platform-auth.ts`](../../apps/server/src/services/open-platform-auth.ts) |
| 执行编排 | 问答（sync/async/stream）、模板报告生成、去除内部 UI 占位符、流式分页读取数据集 | [`open-platform-execution.ts`](../../apps/server/src/services/open-platform-execution.ts) |
| Webhook | HMAC-SHA256 签名（`X-DataChat-Signature`）、退避重试、管理端重放、优雅关闭 | [`open-platform-webhook.ts`](../../apps/server/src/services/open-platform-webhook.ts) |
| 开放路由与 MCP | `/api/open/v1/*` REST/SSE 路由与 JSON-RPC 2.0 Streamable HTTP MCP Server | [`open-v1.ts`](../../apps/server/src/routes/open-v1.ts) |
| 管理路由 | `/api/admin/open-platform/*` 应用/密钥 CRUD、审计统计、Webhook 重放、调试台 | [`admin-open-platform.ts`](../../apps/server/src/routes/admin-open-platform.ts) |
| 共享契约 | `OPEN_APP_SCOPES`、`openEndUserSchema`、结构化响应类型、`admin.open_platform` 权限 | [`open-platform.ts`](../../packages/shared/src/open-platform.ts)、[`permissions.ts`](../../packages/shared/src/permissions.ts) |
| 管理 UI | `/admin/open-platform` 应用与密钥、在线调试台、调用审计与 Webhook 重放 | [`OpenPlatformPage.tsx`](../../apps/web/src/pages/admin/OpenPlatformPage.tsx) |
| 在线文档与 OpenAPI | 公开只读 `GET /api/open/v1/openapi.json` 规范与免登录 `/open-docs` 门户/试调台 | [`open-platform-openapi.ts`](../../apps/server/src/services/open-platform-openapi.ts)、[`OpenDocsPage.tsx`](../../apps/web/src/pages/OpenDocsPage.tsx) |

`open_api_keys` 仅保存 `sha256(rawKey)` 与前 16 位 `key_prefix`，明文密钥只在签发响应返回一次。`open_apps.webhook_secret_cipher` 使用 `APP_SECRET` 派生的密钥加密存储，绝不明文落库或返回给前端。

## 主要运行路径

```text
External Client / Agent (Authorization: Bearer dc_open_... | X-API-Key)
  → authenticateOpenApiKey（每次从 SQLite 重读 key/app/serviceUser，即时生效吊销/过期/停用）
  → Scope 校验 + OpenRateLimiter（每应用 RPM 滑动窗口）
  → resolveOpenExecutionIdentity（数据源交集校验 + 可选 endUser/部门/外部组织码 fail-closed 解析）
  → resolveOrCreateSession（按 app_id + conversationId/externalSessionId 复用隐藏会话）
  → RuntimeManager.getOrCreate（禁用个人记忆防串扰；注入应用补充提示词、scopeDepartmentOverride、queryLimitsOverride）
  → db_schema / db_explain / db_query（强制走 guardSql → applyScopeToSql → executeReadOnly）
  → buildOpenAskResult（剥离 [[artifact:]]/[[chart:]]/[[result:]]，返回 answer + datasets + charts + lineage）
  → recordOpenApiAudit + OpenWebhookService.dispatch（异步 HMAC 签名回调）
```

### 开放端点总览

- `GET /api/open/v1/openapi.json`（公开只读，无需认证）：返回 OpenAPI 3.1.0 静态接口契约 JSON，不含任何租户数据、数据源或密钥；对应前端免登录开发者门户 `/open-docs`。
- `GET /api/open/v1/datasources`：发现当前应用有权访问的数据源及语义层计数摘要（不暴露主机/账号/密码）。
- `GET /api/open/v1/datasources/:id/semantic`（`semantic`）：读取已启用的指标口径、标准表关联和已验证 SQL 示例（受 `exposeSql` 控制）。
- `POST /api/open/v1/ask`（`ask`）：支持 `mode: "sync" | "async" | "stream"`；通过 `conversationId` 或 `externalSessionId` 维持多轮上下文；`stream` 模式在 `run_end` 后追加 `open_result` 结构化事件。
- `GET /api/open/v1/runs/:id` / `GET /api/open/v1/runs/:id/stream` / `POST /api/open/v1/runs/:id/abort`：仅限归属本应用的运行，支持 `Last-Event-ID`/`after` 回放；`exposeSql=false` 时过滤 `sql` 事件。
- `GET /api/open/v1/artifacts/:id/rows`：流式分页读取归属本应用的数据集行（不整文件读入内存）。
- `POST /api/open/v1/reports/generate` / `GET /api/open/v1/reports/:id`（`report`）：按模板/章节大纲/参数生成并持久化报告，完成后触发 `report.completed`/`report.failed` Webhook。
- `POST /api/open/v1/feedback`（`feedback`）：将外部业务点赞/点踩回流至 `run_feedback`，直接进入管理员语义层 Few-Shot 沉淀流程。
- `POST /api/open/v1/mcp`（`mcp`）：无状态 JSON-RPC 2.0 Streamable HTTP MCP Server，按应用 Scope 动态暴露 `list_datasources`、`get_semantic_layer`、`ask_data`、`generate_report`。

## 状态转换

- **API Key**：`active` → `revoked`（写入 `revoked_at` 立即失效）或自然过期（`expires_at <= now` 立即拒绝）。
- **Open App**：`active` ↔ `disabled`（停用后所有下属密钥立即返回 `403 APP_DISABLED`）。
- **Webhook 投递**：`pending` → `ok`（2xx）或 `failed`（退避重试耗尽）；管理员可手动重放，累加 `attempts` 并更新最新状态。

## 重要约束与失败行为

- **Cookie CSRF 豁免边界**：`/api/open/*` 路由仅认 `Authorization: Bearer` / `X-API-Key`，绝不读取 `dc_session` cookie，因此在 `app.ts` 中豁免浏览器 Origin CSRF 钩子；管理端 `/api/admin/open-platform/*` 仍强制走会话 cookie、CSRF 和 `admin.open_platform` 权限门禁。
- **跨应用强隔离**：运行、数据集、报告与反馈均通过 `open_app_sessions(app_id, conversation_id)` 校验归属，跨应用访问统一返回 `404 NOT_FOUND`。
- **行级权限 fail-closed**：
  - 未开启 `allowEndUserOverride` 时传入 `endUser` 返回 `403 END_USER_OVERRIDE_DISABLED`。
  - 部门编码不存在/归档返回 `403 DATA_SCOPE_INVALID_DEPARTMENT`；外部组织码未映射返回 `403 DATA_SCOPE_MAPPING_MISSING`。
  - 非管理员服务账号传入超出自身部门子树的部门编码返回 `403 DATA_SCOPE_OUT_OF_BOUNDS`。
  - 管理员服务账号传入 `departmentCodes`/`externalOrgCodes` 时，查询路径强制关闭管理员绕过，按指定部门执行 `applyScopeToSql`。
- **查询限额只紧不松**：应用级 `maxRowsOverride` 与 `timeoutMsOverride` 在 `runGuardedQuery` / `db_explain` 中取与系统全局上限的较小值，无法突破系统安全天花板。
- **优雅关闭**：`app.ts` 的 `onClose` 钩子调用 `openExecution.shutdown()` 与 `openWebhooks.shutdown()`，取消重试定时器与订阅，避免测试与停机残留句柄。

| 错误码 | HTTP 状态 | 触发条件 |
| --- | --- | --- |
| `API_KEY_REQUIRED` / `API_KEY_INVALID` / `API_KEY_REVOKED` / `API_KEY_EXPIRED` | `401` | 密钥缺失、错误、已吊销或已过期 |
| `APP_DISABLED` / `SERVICE_USER_DISABLED` | `403` | 应用或绑定的服务账号已停用 |
| `SCOPE_DENIED` | `403` | 应用未开通对应能力 Scope |
| `DATASOURCE_FORBIDDEN` | `403` | 数据源不在应用白名单或服务账号无权访问 |
| `END_USER_OVERRIDE_DISABLED` / `END_USER_NOT_FOUND` / `END_USER_DATASOURCE_FORBIDDEN` | `403` | 终端用户透传未开启、用户不可用或无数据源权 |
| `DATA_SCOPE_INVALID_DEPARTMENT` / `DATA_SCOPE_MAPPING_MISSING` / `DATA_SCOPE_OUT_OF_BOUNDS` | `403` | 行级部门/组织上下文无效、缺映射或越权 |
| `RATE_LIMITED` | `429` | 超出应用每分钟 RPM 限流（附 `Retry-After`） |

## 验证

```bash
pnpm exec vitest run apps/server/test/db.test.ts apps/server/test/open-platform.test.ts
pnpm --filter @datachat/web exec vitest run src/pages/admin/OpenPlatformPage.test.tsx
pnpm verify
```
