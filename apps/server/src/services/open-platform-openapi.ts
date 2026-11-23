/**
 * Builds the public OpenAPI 3.1.0 specification for DataChat Open Platform v1.
 * Contains strictly static API contract metadata (zero tenant data, zero secrets).
 */
export function buildOpenApiSpec(serverOrigin: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "DataChat Open Platform API",
      version: "1.0.0",
      description:
        "DataChat 开放平台 API：对外提供基于语义层、AST 只读守卫与行级数据权限（RLS）的精准问数、多轮分析、模板化报告生成、反馈回流与远程 MCP Server 能力。",
    },
    servers: [{ url: serverOrigin, description: "当前 DataChat 实例" }],
    security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
    tags: [
      { name: "Discovery", description: "数据源发现与语义层元数据" },
      { name: "Ask", description: "结构化问答、流式 SSE 与数据集分页" },
      { name: "Reports", description: "模板化精准报告生成与查询" },
      { name: "Feedback", description: "业务反馈回流（Few-Shot 飞轮）" },
      { name: "MCP", description: "远程 Streamable HTTP MCP Server" },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "dc_open_...",
          description: "在请求头传递 `Authorization: Bearer dc_open_...`",
        },
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: "或在请求头传递 `X-API-Key: dc_open_...`",
        },
      },
      schemas: {
        ErrorEnvelope: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", example: "DATASOURCE_FORBIDDEN" },
                message: { type: "string", example: "数据源不存在或当前应用无权访问" },
                details: {},
              },
            },
          },
        },
        EndUserContext: {
          type: "object",
          description: "可选终端用户与行级数据范围上下文（需应用开启 allowEndUserOverride；未知部门或未映射组织一律 fail-closed 拒绝）",
          properties: {
            externalUserId: { type: "string", description: "外部业务系统用户 ID（用于审计溯源）" },
            username: { type: "string", description: "映射到 DataChat 内部已有活跃用户名" },
            departmentCodes: {
              type: "array",
              items: { type: "string" },
              description: "DataChat 部门编码列表，用于按部门树向下展开行级过滤",
            },
            externalOrgCodes: {
              type: "array",
              items: { type: "string" },
              description: "外部组织编码列表，通过 department_org_map 映射并执行行级过滤",
            },
          },
        },
        AskRequest: {
          type: "object",
          required: ["datasourceId", "question"],
          properties: {
            datasourceId: { type: "string", format: "uuid" },
            question: { type: "string", minLength: 1, maxLength: 8000 },
            mode: {
              type: "string",
              enum: ["sync", "async", "stream"],
              default: "sync",
              description: "sync 同步等待完成；async 立即返回 202；stream 返回 text/event-stream 流",
            },
            conversationId: { type: "string", format: "uuid" },
            externalSessionId: {
              type: "string",
              maxLength: 128,
              description: "外部会话 ID；相同 ID 自动复用多轮分析上下文",
            },
            modelId: { type: "string" },
            thinkingLevel: {
              type: "string",
              enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
            },
            endUser: { $ref: "#/components/schemas/EndUserContext" },
          },
        },
        OpenDataset: {
          type: "object",
          properties: {
            artifactId: { type: "string", format: "uuid" },
            columns: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string" },
                },
              },
            },
            previewRows: { type: "array", items: { type: "array", items: {} } },
            rowCount: { type: "integer" },
            truncated: { type: "boolean" },
            rowsUrl: { type: "string", example: "/api/open/v1/artifacts/<id>/rows" },
          },
        },
        OpenAskResult: {
          type: "object",
          properties: {
            runId: { type: "string", format: "uuid" },
            conversationId: { type: "string", format: "uuid" },
            externalSessionId: { type: ["string", "null"] },
            datasourceId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["queued", "running", "ok", "error", "aborted"] },
            answer: { type: "string", description: "已剔除内部 UI 占位符的纯净自然语言/Markdown 回答" },
            datasets: { type: "array", items: { $ref: "#/components/schemas/OpenDataset" } },
            charts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  artifactId: { type: "string" },
                  spec: { type: "object" },
                },
              },
            },
            lineage: {
              type: "object",
              properties: {
                sqls: {
                  type: "array",
                  description: "仅在应用开启 exposeSql=true 时返回",
                  items: {
                    type: "object",
                    properties: {
                      sql: { type: "string" },
                      auditId: { type: "string" },
                      status: { type: "string", enum: ["ok", "rejected", "error"] },
                    },
                  },
                },
                scope: {
                  type: ["object", "null"],
                  properties: {
                    departments: { type: "array", items: { type: "string" } },
                    scopedTables: { type: "array", items: { type: "string" } },
                  },
                },
                semanticMetrics: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      formula: { type: "string" },
                      unit: { type: ["string", "null"] },
                    },
                  },
                },
              },
            },
            usage: {
              type: ["object", "null"],
              properties: {
                input: { type: "integer" },
                output: { type: "integer" },
                cacheRead: { type: "integer" },
                cacheWrite: { type: "integer" },
              },
            },
            durationMs: { type: ["integer", "null"] },
            error: { type: ["string", "null"] },
            createdAt: { type: "integer" },
          },
        },
        ReportGenerateRequest: {
          type: "object",
          required: ["datasourceId", "prompt"],
          properties: {
            datasourceId: { type: "string", format: "uuid" },
            prompt: { type: "string", minLength: 1, maxLength: 8000 },
            title: { type: "string", maxLength: 120 },
            template: { type: "string", maxLength: 10000 },
            sections: { type: "array", items: { type: "string" }, maxItems: 20 },
            parameters: {
              type: "object",
              additionalProperties: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
            },
            mode: { type: "string", enum: ["sync", "async"], default: "sync" },
            modelId: { type: "string" },
            endUser: { $ref: "#/components/schemas/EndUserContext" },
          },
        },
        FeedbackRequest: {
          type: "object",
          required: ["runId", "rating"],
          properties: {
            runId: { type: "string", format: "uuid" },
            rating: { type: "integer", enum: [1, -1] },
            comment: { type: "string", maxLength: 2000 },
            externalUserId: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    paths: {
      "/api/open/v1/openapi.json": {
        get: {
          tags: ["Discovery"],
          summary: "获取 OpenAPI 3.1 规范文档（公开只读）",
          security: [],
          responses: { "200": { description: "OpenAPI 3.1.0 JSON 规范" } },
        },
      },
      "/api/open/v1/datasources": {
        get: {
          tags: ["Discovery"],
          summary: "列出当前应用有权访问的数据源及语义层摘要",
          responses: {
            "200": { description: "已授权数据源列表" },
            "401": { description: "API Key 缺失、无效、吊销或过期" },
            "429": { description: "超出应用每分钟 RPM 限流" },
          },
        },
      },
      "/api/open/v1/datasources/{id}/semantic": {
        get: {
          tags: ["Discovery"],
          summary: "读取数据源语义层（指标口径、标准表关联、已验证 SQL 示例）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "语义层配置" },
            "403": { description: "未开通 semantic 权限或无数据源访问权" },
          },
        },
      },
      "/api/open/v1/ask": {
        post: {
          tags: ["Ask"],
          summary: "发起结构化精准问数与分析（支持 sync / async / stream）",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AskRequest" } } },
          },
          responses: {
            "200": {
              description: "同步模式返回完整结构化结果；stream 模式返回 text/event-stream",
              content: { "application/json": { schema: { $ref: "#/components/schemas/OpenAskResult" } } },
            },
            "202": { description: "异步模式已入队，附带 runId 供轮询、SSE 或 Webhook 回调" },
            "403": { description: "无权限、未开启行级身份透传或行级范围 fail-closed 拒绝" },
            "429": { description: "触发应用级限流" },
          },
        },
      },
      "/api/open/v1/runs/{id}": {
        get: {
          tags: ["Ask"],
          summary: "轮询查询某次运行的状态与结构化结果",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": {
              description: "运行结果",
              content: { "application/json": { schema: { $ref: "#/components/schemas/OpenAskResult" } } },
            },
            "404": { description: "运行不存在或不属于当前应用" },
          },
        },
      },
      "/api/open/v1/runs/{id}/stream": {
        get: {
          tags: ["Ask"],
          summary: "订阅或断线回放运行事件流（SSE，支持 Last-Event-ID / ?after=）",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "after", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
          ],
          responses: {
            "200": { description: "text/event-stream 实时与回放事件流" },
            "404": { description: "运行不存在或不属于当前应用" },
          },
        },
      },
      "/api/open/v1/runs/{id}/abort": {
        post: {
          tags: ["Ask"],
          summary: "中止正在排队或执行中的运行",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "204": { description: "已发送中止请求" }, "404": { description: "运行不存在" } },
        },
      },
      "/api/open/v1/artifacts/{id}/rows": {
        get: {
          tags: ["Ask"],
          summary: "分页拉取查询数据集的完整明细行（流式读取）",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 } },
          ],
          responses: { "200": { description: "分页数据行" }, "404": { description: "数据集不存在或不属于当前应用" } },
        },
      },
      "/api/open/v1/reports/generate": {
        post: {
          tags: ["Reports"],
          summary: "按主题、章节大纲、模板与参数生成精准分析报告",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ReportGenerateRequest" } },
            },
          },
          responses: {
            "200": { description: "同步生成完成，返回报告正文、数据集、图表与血缘" },
            "202": { description: "异步已入队，完成后通过 Webhook 回调" },
          },
        },
      },
      "/api/open/v1/reports/{id}": {
        get: {
          tags: ["Reports"],
          summary: "读取本应用生成的持久化分析报告详情",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "报告详情" }, "404": { description: "报告不存在或不属于当前应用" } },
        },
      },
      "/api/open/v1/feedback": {
        post: {
          tags: ["Feedback"],
          summary: "回传外部业务终端用户的点赞/点踩反馈，沉淀 Few-Shot 示例",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/FeedbackRequest" } } },
          },
          responses: { "200": { description: "反馈已保存" }, "404": { description: "运行不存在或不属于当前应用" } },
        },
      },
      "/api/open/v1/mcp": {
        post: {
          tags: ["MCP"],
          summary: "远程 Streamable HTTP MCP Server（JSON-RPC 2.0）",
          description:
            "支持 initialize / ping / tools/list / tools/call，按应用 Scope 暴露 list_datasources、get_semantic_layer、ask_data、generate_report 工具。",
          responses: { "200": { description: "JSON-RPC 2.0 响应" } },
        },
      },
    },
  };
}
