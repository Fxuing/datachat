# DataChat 开放平台接入指南

本指南面向希望复用 DataChat 精准问数、语义层指标口径、行级数据权限（RLS）与报告生成能力的外部业务研发。

> **在线互动文档**：部署 DataChat 后，外部研发无需管理员账号，可直接访问以下两个公开地址：
> - **在线开发者文档与接口试调台**：`http(s)://<your-host>/open-docs`
> - **标准 OpenAPI 3.1 JSON 规范**：`http(s)://<your-host>/api/open/v1/openapi.json`（可直接导入 Postman / Apifox / Swagger / OpenAPI Generator）

---

## 1. 接入前准备（3 步）

1. **平台管理员配置应用**：在 `管理后台 → 开放平台` 新建应用，绑定服务账号、选择数据源白名单与能力 Scope（`ask` / `report` / `semantic` / `mcp` / `feedback`），按需开启「允许行级身份透传」和配置 Webhook。
2. **获取 API Key**：管理员签发 `dc_open_...` 密钥并交付给接入方（明文仅展示一次）。
3. **验证连通性**：打开 `http(s)://<your-host>/open-docs`，在页面顶部填入 API Key，直接点击「在线接口试调 → 获取可用数据源」即可验证权限与数据源 ID。

---

## 2. 认证与行级数据权限（RLS）

所有开放接口均通过请求头认证（不使用浏览器 Cookie）：

```http
Authorization: Bearer dc_open_YOUR_API_KEY
# 或
X-API-Key: dc_open_YOUR_API_KEY
```

当目标数据源已启用行级数据权限且应用已开启「允许行级身份透传」时，可在请求体中附加 `endUser`：

```json
{
  "endUser": {
    "externalUserId": "crm_user_1024",
    "externalOrgCodes": ["ORG_EAST_SH"]
  }
}
```

- 支持 `username`（映射到 DataChat 已有活跃用户）、`departmentCodes`（本系统部门编码）或 `externalOrgCodes`（外部组织映射码）。
- **严格 fail-closed**：任意部门码不存在/已归档、外部组织码缺映射或超出服务账号授权子树，均在建立数据库连接前直接返回 `403`。

---

## 3. 核心接入方式

### 方式 A：结构化精准问数（适合已有自研问答/BI 页面）

```bash
curl -X POST "https://<your-host>/api/open/v1/ask" \
  -H "Authorization: Bearer dc_open_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "datasourceId": "<DATASOURCE_ID>",
    "question": "统计近 30 天各渠道销售额与环比增速",
    "mode": "sync",
    "externalSessionId": "biz-session-001"
  }'
```

- `mode`: `"sync"`（同步等待结果）、`"async"`（立即返回 `202 + runId` + Webhook 回调）、`"stream"`（SSE 流式推送，结束时返回完整 `open_result`）。
- 响应已自动剥离 DataChat 内部渲染标记，返回纯净 `answer`、结构化 `datasets[]`（可通过 `GET /api/open/v1/artifacts/:id/rows` 分页拉取完整明细）、`charts[]`（ECharts Spec）及 `lineage`（SQL、行级范围与命中的语义指标）。

### 方式 B：模板化精准报告生成（适合替换原有不精准的自动报告）

```bash
curl -X POST "https://<your-host>/api/open/v1/reports/generate" \
  -H "Authorization: Bearer dc_open_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "datasourceId": "<DATASOURCE_ID>",
    "title": "月度经营分析报告",
    "prompt": "分析各区域销售额、订单量与退单率",
    "sections": ["核心指标概览", "区域对比", "异常波动与建议"],
    "parameters": { "period": "2026-10" },
    "mode": "async"
  }'
```

### 方式 C：远程 MCP Server（适合 Dify / Coze / Cursor / 自研 AI Agent）

直接将以下配置挂载到支持 Streamable HTTP MCP 的客户端即可获得 `list_datasources`、`get_semantic_layer`、`ask_data`、`generate_report` 工具：

```json
{
  "mcpServers": {
    "datachat": {
      "type": "http",
      "url": "https://<your-host>/api/open/v1/mcp",
      "headers": {
        "Authorization": "Bearer dc_open_YOUR_API_KEY"
      }
    }
  }
}
```

---

## 4. 反馈回流与 Webhook 验签

- **反馈回流**：调用 `POST /api/open/v1/feedback`（`{ runId, rating: 1 | -1, comment, externalUserId }`），业务用户的评价会自动进入 DataChat 后台「数据源 → 语义层 → 问答反馈」，便于持续沉淀 Few-Shot 示例。
- **Webhook 验签**：使用 `HMAC-SHA256(secret, "${X-DataChat-Timestamp}.${rawBody}")` 计算摘要并与 `X-DataChat-Signature`（格式 `t=<ts>,v1=<hex>`）做常量时间比对。完整 Node.js / Python 示例代码见在线文档 `/open-docs#webhook`。

更多内部架构、状态转换与安全边界请参考 [开放平台子系统参考](subsystems/open-platform.md)。
