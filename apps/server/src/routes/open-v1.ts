import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { openEndUserSchema, type OpenAppScope, type RunEvent } from "@datachat/shared";
import type { Db } from "../db/client.js";
import { listDatasourcesForAccess } from "../db/repositories/datasources.js";
import {
  findOpenAppSessionByConversation,
  recordOpenApiAudit,
} from "../db/repositories/open-platform.js";
import { appendRunEvent, listRunEventsAfter } from "../db/repositories/run-events.js";
import { findRun, markRun } from "../db/repositories/runs.js";
import { upsertRunFeedback } from "../db/repositories/run-feedback.js";
import { listSemanticMetrics, listSemanticRelations } from "../db/repositories/semantic-layer.js";
import { listSqlExamples } from "../db/repositories/sql-examples.js";
import type { LiveRunEvent } from "../agent/event-bus.js";
import type { RuntimeManager } from "../agent/runtime.js";
import type { ArtifactStore } from "../services/artifacts.js";
import {
  OpenPlatformAuthError,
  assertOpenScope,
  authenticateOpenApiKey,
  extractOpenApiKey,
  isAppDatasourceAllowed,
  type OpenApiPrincipal,
  type OpenRateLimiter,
} from "../services/open-platform-auth.js";
import {
  buildOpenAskResult,
  readArtifactRowsPage,
  type OpenExecutionService,
} from "../services/open-platform-execution.js";
import { buildOpenApiSpec } from "../services/open-platform-openapi.js";

export interface OpenV1RouteOptions {
  db: Db;
  artifacts: ArtifactStore;
  runtime: RuntimeManager;
  execution: OpenExecutionService;
  rateLimiter: OpenRateLimiter;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const askBodySchema = z.object({
  datasourceId: z.string().uuid(),
  question: z.string().trim().min(1).max(8_000),
  mode: z.enum(["sync", "async", "stream"]).default("sync"),
  conversationId: z.string().uuid().optional(),
  externalSessionId: z.string().trim().min(1).max(128).optional(),
  modelId: z.string().trim().min(1).max(200).optional(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  endUser: openEndUserSchema.optional(),
});

const reportGenerateBodySchema = z.object({
  datasourceId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(8_000),
  title: z.string().trim().min(1).max(120).optional(),
  template: z.string().trim().min(1).max(10_000).optional(),
  sections: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  parameters: z.record(z.string().min(1).max(64), z.union([z.string(), z.number(), z.boolean()])).optional(),
  mode: z.enum(["sync", "async"]).default("sync"),
  modelId: z.string().trim().min(1).max(200).optional(),
  endUser: openEndUserSchema.optional(),
});

const feedbackBodySchema = z.object({
  runId: z.string().uuid(),
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().trim().max(2_000).optional(),
  externalUserId: z.string().trim().min(1).max(128).optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });
const rowsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1_000).default(100),
});
const lastEventIdSchema = z.object({ after: z.coerce.number().int().nonnegative().optional() });

const mcpRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

function parseLastEventId(request: FastifyRequest): number {
  const header = request.headers["last-event-id"];
  const rawHeader = Array.isArray(header) ? header[0] : header;
  if (rawHeader !== undefined && rawHeader !== "") {
    const parsed = Number(rawHeader);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  const query = lastEventIdSchema.safeParse(request.query);
  return query.success ? (query.data.after ?? 0) : 0;
}

function persistedEvent(row: { seq: number; type: string; payloadJson: string }): LiveRunEvent | null {
  try {
    return {
      runId: "",
      conversationId: "",
      seq: row.seq,
      createdAt: 0,
      event: {
        type: row.type,
        payload: JSON.parse(row.payloadJson) as unknown,
      } as RunEvent,
    };
  } catch {
    return null;
  }
}

export async function openV1Routes(app: FastifyInstance, opts: OpenV1RouteOptions): Promise<void> {
  function authenticateAndLimit(
    request: FastifyRequest,
    reply: FastifyReply,
    requiredScopes: OpenAppScope[],
    endpoint: string,
  ): OpenApiPrincipal | null {
    const rawKey = extractOpenApiKey(request.headers);
    let principal: OpenApiPrincipal;
    try {
      principal = authenticateOpenApiKey(opts.db, rawKey);
    } catch (error) {
      if (error instanceof OpenPlatformAuthError) {
        void reply.code(error.httpStatus).send(errorBody(error.code, error.message));
        return null;
      }
      throw error;
    }

    const hasRequiredScope =
      requiredScopes.length === 0 || requiredScopes.some((scope) => principal.scopes.has(scope));
    if (!hasRequiredScope) {
      const missing = requiredScopes[0]!;
      recordOpenApiAudit(opts.db, {
        appId: principal.app.id,
        keyId: principal.key.id,
        endpoint,
        status: "rejected",
        httpStatus: 403,
        errorCode: "SCOPE_DENIED",
        errorMessage: `当前应用未开通「${missing}」能力权限`,
      });
      void reply.code(403).send(errorBody("SCOPE_DENIED", `当前应用未开通「${missing}」能力权限`));
      return null;
    }

    const rate = opts.rateLimiter.consume(principal.app.id, principal.app.rateLimitRpm);
    reply.header("X-RateLimit-Limit", String(principal.app.rateLimitRpm));
    reply.header("X-RateLimit-Remaining", String(rate.remaining));
    if (!rate.allowed) {
      reply.header("Retry-After", String(rate.retryAfterSec));
      recordOpenApiAudit(opts.db, {
        appId: principal.app.id,
        keyId: principal.key.id,
        endpoint,
        status: "rate_limited",
        httpStatus: 429,
        errorCode: "RATE_LIMITED",
        errorMessage: `超出应用每分钟调用上限（${principal.app.rateLimitRpm} RPM）`,
      });
      void reply
        .code(429)
        .send(errorBody("RATE_LIMITED", `请求过于频繁，请在 ${rate.retryAfterSec} 秒后重试`));
      return null;
    }

    return principal;
  }

  function streamRunEvents(
    request: FastifyRequest,
    reply: FastifyReply,
    input: {
      principal: OpenApiPrincipal;
      runId: string;
      conversationId: string;
      includeFinalOpenResult?: boolean;
      questionText?: string;
    },
  ): void {
    const lastId = parseLastEventId(request);
    const exposeSql = input.principal.app.exposeSql === 1;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let maxSeq = lastId;
    let live = false;
    let cleaned = false;
    let finished = false;
    const buffered: LiveRunEvent[] = [];
    let unsubscribe: () => void = () => undefined;
    // eslint-disable-next-line prefer-const
    let heartbeat: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    };

    const writeEvent = (ev: LiveRunEvent): boolean => {
      if (ev.seq <= maxSeq) return false;
      maxSeq = ev.seq;
      if (ev.event.type === "sql" && !exposeSql) {
        return false;
      }
      reply.raw.write(`id: ${ev.seq}\nevent: ${ev.event.type}\ndata: ${JSON.stringify(ev.event.payload)}\n\n`);
      return ev.event.type === "run_end";
    };

    const finishStream = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      cleanup();
      if (input.includeFinalOpenResult) {
        const session = findOpenAppSessionByConversation(
          opts.db,
          input.principal.app.id,
          input.conversationId,
        );
        if (session) {
          try {
            const structured = await buildOpenAskResult(opts.db, opts.artifacts, {
              app: input.principal.app,
              session,
              runId: input.runId,
              questionText: input.questionText,
            });
            if (structured) {
              reply.raw.write(`event: open_result\ndata: ${JSON.stringify(structured)}\n\n`);
            }
          } catch {
            // Do not crash the SSE teardown if structured summary fails.
          }
        }
      }
      reply.raw.end();
    };

    unsubscribe = opts.runtime.bus.subscribe(input.conversationId, (event) => {
      if (event.runId !== input.runId || finished) return;
      if (!live) {
        buffered.push(event);
        return;
      }
      if (writeEvent(event)) {
        void finishStream();
      }
    });

    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);

    for (const row of listRunEventsAfter(opts.db, input.runId, lastId)) {
      const parsed = persistedEvent(row);
      if (parsed && writeEvent(parsed)) {
        void finishStream();
        return;
      }
    }

    live = true;
    for (const event of buffered) {
      if (writeEvent(event)) {
        void finishStream();
        return;
      }
    }
    buffered.length = 0;

    const latest = findRun(opts.db, input.runId);
    if (latest && (latest.status === "ok" || latest.status === "error" || latest.status === "aborted")) {
      void finishStream();
      return;
    }

    heartbeat = setInterval(() => {
      if (!cleaned && !finished) reply.raw.write(": ping\n\n");
    }, 15_000);
    heartbeat.unref?.();
  }

  // 0. Public OpenAPI 3.1 contract metadata (static schema only; never exposes tenant data or secrets)
  app.get("/api/open/v1/openapi.json", async (request, reply) => {
    const host = request.headers.host ?? "localhost:8080";
    const origin = `${request.protocol}://${host}`;
    reply.header("Cache-Control", "public, max-age=300");
    return buildOpenApiSpec(origin);
  });

  // 1. Discover datasources authorized for this app
  app.get("/api/open/v1/datasources", async (request, reply) => {
    const startedAt = Date.now();
    const endpoint = "GET /api/open/v1/datasources";
    const principal = authenticateAndLimit(request, reply, ["semantic", "ask", "report"], endpoint);
    if (!principal) return;

    const items = listDatasourcesForAccess(opts.db, principal.serviceAccess)
      .filter((ds) => isAppDatasourceAllowed(principal, ds.id))
      .map((ds) => ({
        id: ds.id,
        name: ds.name,
        type: ds.type,
        status: ds.status,
        dataScopeMode: ds.dataScopeMode,
        semanticSummary: {
          metricsCount: listSemanticMetrics(opts.db, ds.id, { onlyEnabled: true }).length,
          relationsCount: listSemanticRelations(opts.db, ds.id, { onlyEnabled: true }).length,
          examplesCount: listSqlExamples(opts.db, ds.id, { onlyEnabled: true }).length,
        },
      }));

    recordOpenApiAudit(opts.db, {
      appId: principal.app.id,
      keyId: principal.key.id,
      endpoint,
      status: "ok",
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
    });
    return { items };
  });

  // 2. Read semantic layer metadata (metrics, relations, verified examples)
  app.get("/api/open/v1/datasources/:id/semantic", async (request, reply) => {
    const startedAt = Date.now();
    const endpoint = "GET /api/open/v1/datasources/:id/semantic";
    const principal = authenticateAndLimit(request, reply, ["semantic"], endpoint);
    if (!principal) return;

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody("VALIDATION", "datasourceId 参数不合法"));
    }
    if (!isAppDatasourceAllowed(principal, params.data.id)) {
      recordOpenApiAudit(opts.db, {
        appId: principal.app.id,
        keyId: principal.key.id,
        endpoint,
        datasourceId: params.data.id,
        status: "rejected",
        httpStatus: 403,
        errorCode: "DATASOURCE_FORBIDDEN",
        errorMessage: "无权访问该数据源",
        durationMs: Date.now() - startedAt,
      });
      return reply.code(403).send(errorBody("DATASOURCE_FORBIDDEN", "数据源不存在或当前应用无权访问"));
    }

    const exposeSql = principal.app.exposeSql === 1;
    const metrics = listSemanticMetrics(opts.db, params.data.id, { onlyEnabled: true }).map((m) => ({
      id: m.id,
      name: m.name,
      synonyms: m.synonyms,
      description: m.description,
      ...(exposeSql ? { sqlExpression: m.sqlExpression, defaultFilters: m.defaultFilters } : {}),
      tableName: m.tableName,
      timeColumn: m.timeColumn,
      unit: m.unit,
    }));
    const relations = listSemanticRelations(opts.db, params.data.id, { onlyEnabled: true }).map((r) => ({
      id: r.id,
      leftTable: r.leftTable,
      leftColumn: r.leftColumn,
      rightTable: r.rightTable,
      rightColumn: r.rightColumn,
      joinType: r.joinType,
      description: r.description,
    }));
    const examples = listSqlExamples(opts.db, params.data.id, { onlyEnabled: true }).map((e) => ({
      id: e.id,
      question: e.question,
      ...(exposeSql ? { sqlText: e.sqlText } : {}),
      notes: e.notes,
      tables: e.tables,
    }));

    recordOpenApiAudit(opts.db, {
      appId: principal.app.id,
      keyId: principal.key.id,
      endpoint,
      datasourceId: params.data.id,
      status: "ok",
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
    });
    return { datasourceId: params.data.id, metrics, relations, examples };
  });

  // 3. Structured Q&A / Ask-to-Data API (sync | async | stream)
  app.post("/api/open/v1/ask", async (request, reply) => {
    const startedAt = Date.now();
    const endpoint = "POST /api/open/v1/ask";
    const principal = authenticateAndLimit(request, reply, ["ask"], endpoint);
    if (!principal) return;

    const body = askBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(errorBody("VALIDATION", "请求参数不合法", body.error.flatten()));
    }

    try {
      if (body.data.mode === "stream") {
        const { result } = await opts.execution.ask({
          principal,
          datasourceId: body.data.datasourceId,
          question: body.data.question,
          mode: "async",
          conversationId: body.data.conversationId,
          externalSessionId: body.data.externalSessionId,
          modelId: body.data.modelId,
          thinkingLevel: body.data.thinkingLevel,
          endUser: body.data.endUser,
          endpoint: "POST /api/open/v1/ask (stream)",
        });
        streamRunEvents(request, reply, {
          principal,
          runId: result.runId,
          conversationId: result.conversationId,
          includeFinalOpenResult: true,
          questionText: body.data.question,
        });
        return;
      }

      const { result, httpStatus } = await opts.execution.ask({
        principal,
        datasourceId: body.data.datasourceId,
        question: body.data.question,
        mode: body.data.mode,
        conversationId: body.data.conversationId,
        externalSessionId: body.data.externalSessionId,
        modelId: body.data.modelId,
        thinkingLevel: body.data.thinkingLevel,
        endUser: body.data.endUser,
        endpoint,
      });
      return reply.code(httpStatus).send(result);
    } catch (error) {
      if (error instanceof OpenPlatformAuthError) {
        recordOpenApiAudit(opts.db, {
          appId: principal.app.id,
          keyId: principal.key.id,
          endpoint,
          datasourceId: body.data.datasourceId,
          externalUserId: body.data.endUser?.externalUserId ?? null,
          status: "rejected",
          httpStatus: error.httpStatus,
          errorCode: error.code,
          errorMessage: error.message,
          durationMs: Date.now() - startedAt,
        });
        return reply.code(error.httpStatus).send(errorBody(error.code, error.message));
      }
      const message = error instanceof Error ? error.message : "问答执行失败";
      return reply.code(500).send(errorBody("ASK_FAILED", message));
    }
  });

  // 4. Poll structured run result
  app.get("/api/open/v1/runs/:id", async (request, reply) => {
    const endpoint = "GET /api/open/v1/runs/:id";
    const principal = authenticateAndLimit(request, reply, ["ask", "report"], endpoint);
    if (!principal) return;

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody("VALIDATION", "runId 参数不合法"));
    }
    const result = await opts.execution.getRunResult(principal.app, params.data.id);
    if (!result) {
      return reply.code(404).send(errorBody("NOT_FOUND", "运行不存在"));
    }
    return result;
  });

  // 5. SSE stream for an existing run (supports Last-Event-ID / after replay)
  app.get("/api/open/v1/runs/:id/stream", async (request, reply) => {
    const endpoint = "GET /api/open/v1/runs/:id/stream";
    const principal = authenticateAndLimit(request, reply, ["ask", "report"], endpoint);
    if (!principal) return;

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody("VALIDATION", "runId 参数不合法"));
    }
    const run = findRun(opts.db, params.data.id);
    if (!run) {
      return reply.code(404).send(errorBody("NOT_FOUND", "运行不存在"));
    }
    const session = findOpenAppSessionByConversation(opts.db, principal.app.id, run.conversationId);
    if (!session) {
      return reply.code(404).send(errorBody("NOT_FOUND", "运行不存在"));
    }

    streamRunEvents(request, reply, {
      principal,
      runId: run.id,
      conversationId: run.conversationId,
      includeFinalOpenResult: true,
    });
  });

  // 6. Abort an active/queued run belonging to this app
  app.post("/api/open/v1/runs/:id/abort", async (request, reply) => {
    const endpoint = "POST /api/open/v1/runs/:id/abort";
    const principal = authenticateAndLimit(request, reply, ["ask", "report"], endpoint);
    if (!principal) return;

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody("VALIDATION", "runId 参数不合法"));
    }
    const run = findRun(opts.db, params.data.id);
    if (!run) {
      return reply.code(404).send(errorBody("NOT_FOUND", "运行不存在"));
    }
    const session = findOpenAppSessionByConversation(opts.db, principal.app.id, run.conversationId);
    if (!session) {
      return reply.code(404).send(errorBody("NOT_FOUND", "运行不存在"));
    }

    const aborted = opts.runtime.abort(run.conversationId, run.id);
    if (!aborted) {
      const current = findRun(opts.db, run.id);
      if (current && (current.status === "queued" || current.status === "running")) {
        const { seq, createdAt } = appendRunEvent(opts.db, {
          runId: current.id,
          conversationId: current.conversationId,
          type: "run_end",
          payload: { status: "aborted" },
        });
        markRun(opts.db, current.id, { status: "aborted", endedAt: Date.now() });
        opts.runtime.bus.publish({
          runId: current.id,
          conversationId: current.conversationId,
          seq,
          createdAt,
          event: { type: "run_end", payload: { status: "aborted" } },
        });
      }
    }
    return reply.code(204).send();
  });

  // 7. Paginated dataset rows for an artifact produced by this app
  app.get("/api/open/v1/artifacts/:id/rows", async (request, reply) => {
    const endpoint = "GET /api/open/v1/artifacts/:id/rows";
    const principal = authenticateAndLimit(request, reply, ["ask", "report"], endpoint);
    if (!principal) return;

    const params = idParamsSchema.safeParse(request.params);
    const query = rowsQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send(errorBody("VALIDATION", "参数不合法"));
    }
    const meta = opts.artifacts.get(params.data.id);
    if (!meta || meta.kind !== "result" || !meta.conversationId) {
      return reply.code(404).send(errorBody("NOT_FOUND", "数据集不存在"));
    }
    const session = findOpenAppSessionByConversation(opts.db, principal.app.id, meta.conversationId);
    if (!session) {
      return reply.code(404).send(errorBody("NOT_FOUND", "数据集不存在"));
    }

    const rows = await readArtifactRowsPage(
      opts.artifacts,
      meta.id,
      query.data.offset,
      query.data.limit,
    );
    return {
      artifactId: meta.id,
      columns: meta.columns,
      rows,
      rowCount: meta.rowCount,
      offset: query.data.offset,
      limit: query.data.limit,
      truncated: meta.truncated,
    };
  });

  // 8. Template/outline-driven Report Generation API
  app.post("/api/open/v1/reports/generate", async (request, reply) => {
    const startedAt = Date.now();
    const endpoint = "POST /api/open/v1/reports/generate";
    const principal = authenticateAndLimit(request, reply, ["report"], endpoint);
    if (!principal) return;

    const body = reportGenerateBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(errorBody("VALIDATION", "请求参数不合法", body.error.flatten()));
    }

    try {
      const { result, httpStatus } = await opts.execution.generateReport({
        principal,
        datasourceId: body.data.datasourceId,
        prompt: body.data.prompt,
        title: body.data.title,
        template: body.data.template,
        sections: body.data.sections,
        parameters: body.data.parameters,
        mode: body.data.mode,
        modelId: body.data.modelId,
        endUser: body.data.endUser,
        endpoint,
      });
      return reply.code(httpStatus).send(result);
    } catch (error) {
      if (error instanceof OpenPlatformAuthError) {
        recordOpenApiAudit(opts.db, {
          appId: principal.app.id,
          keyId: principal.key.id,
          endpoint,
          datasourceId: body.data.datasourceId,
          externalUserId: body.data.endUser?.externalUserId ?? null,
          status: "rejected",
          httpStatus: error.httpStatus,
          errorCode: error.code,
          errorMessage: error.message,
          durationMs: Date.now() - startedAt,
        });
        return reply.code(error.httpStatus).send(errorBody(error.code, error.message));
      }
      const message = error instanceof Error ? error.message : "报告生成失败";
      return reply.code(500).send(errorBody("REPORT_FAILED", message));
    }
  });

  // 9. Read generated report owned by this app
  app.get("/api/open/v1/reports/:id", async (request, reply) => {
    const endpoint = "GET /api/open/v1/reports/:id";
    const principal = authenticateAndLimit(request, reply, ["report"], endpoint);
    if (!principal) return;

    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody("VALIDATION", "reportId 参数不合法"));
    }
    const report = await opts.execution.getReportResult(principal.app, params.data.id);
    if (!report) {
      return reply.code(404).send(errorBody("NOT_FOUND", "报告不存在"));
    }
    return report;
  });

  // 10. Feedback loop API -> writes into run_feedback for Few-Shot curation
  app.post("/api/open/v1/feedback", async (request, reply) => {
    const startedAt = Date.now();
    const endpoint = "POST /api/open/v1/feedback";
    const principal = authenticateAndLimit(request, reply, ["feedback"], endpoint);
    if (!principal) return;

    const body = feedbackBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(errorBody("VALIDATION", "请求参数不合法", body.error.flatten()));
    }
    const run = findRun(opts.db, body.data.runId);
    if (!run) {
      return reply.code(404).send(errorBody("NOT_FOUND", "运行不存在"));
    }
    const session = findOpenAppSessionByConversation(opts.db, principal.app.id, run.conversationId);
    if (!session) {
      return reply.code(404).send(errorBody("NOT_FOUND", "运行不存在"));
    }

    const actorTag = body.data.externalUserId
      ? `[Open:${principal.app.name}/${body.data.externalUserId}]`
      : `[Open:${principal.app.name}]`;
    const comment = body.data.comment ? `${actorTag} ${body.data.comment}` : actorTag;

    const saved = upsertRunFeedback(opts.db, {
      runId: run.id,
      userId: session.effectiveUserId,
      rating: body.data.rating,
      comment,
    });

    recordOpenApiAudit(opts.db, {
      appId: principal.app.id,
      keyId: principal.key.id,
      endpoint,
      datasourceId: session.datasourceId,
      conversationId: run.conversationId,
      runId: run.id,
      externalUserId: body.data.externalUserId ?? session.externalUserId,
      effectiveUserId: session.effectiveUserId,
      status: "ok",
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
    });

    return {
      id: saved.id,
      runId: saved.runId,
      rating: saved.rating,
      comment: saved.comment,
      reviewStatus: saved.reviewStatus,
      updatedAt: saved.updatedAt,
    };
  });

  // 11. Remote Streamable HTTP MCP Server (JSON-RPC 2.0)
  app.post("/api/open/v1/mcp", async (request, reply) => {
    const startedAt = Date.now();
    const endpoint = "POST /api/open/v1/mcp";
    const principal = authenticateAndLimit(request, reply, ["mcp"], endpoint);
    if (!principal) return;

    const parsed = mcpRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
      });
    }

    const { id = null, method, params } = parsed.data;

    if (method === "notifications/initialized") {
      return reply.code(202).send();
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "datachat-open-platform", version: "1.0.0" },
        },
      };
    }

    const availableTools = [
      {
        name: "list_datasources",
        description: "列出当前开放应用有权访问的数据源及其语义层指标/示例数量摘要。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      ...(principal.scopes.has("semantic")
        ? [
            {
              name: "get_semantic_layer",
              description: "获取指定数据源的业务指标定义、标准表关联和已验证 SQL 示例。",
              inputSchema: {
                type: "object",
                properties: {
                  datasourceId: { type: "string", description: "数据源 UUID" },
                },
                required: ["datasourceId"],
                additionalProperties: false,
              },
            },
          ]
        : []),
      ...(principal.scopes.has("ask")
        ? [
            {
              name: "ask_data",
              description:
                "向 DataChat 发起自然语言精准问数/分析。内部自动执行语义层召回、AST 只读 SQL 守卫与行级数据权限过滤，返回精准结论、结构化数据集与图表规格。",
              inputSchema: {
                type: "object",
                properties: {
                  datasourceId: { type: "string", description: "数据源 UUID" },
                  question: { type: "string", description: "自然语言分析问题" },
                  externalSessionId: { type: "string", description: "可选外部会话 ID，用于多轮上下文复用" },
                  endUser: {
                    type: "object",
                    description: "可选终端用户/部门上下文（需应用开启透传）",
                    properties: {
                      externalUserId: { type: "string" },
                      username: { type: "string" },
                      departmentCodes: { type: "array", items: { type: "string" } },
                      externalOrgCodes: { type: "array", items: { type: "string" } },
                    },
                  },
                },
                required: ["datasourceId", "question"],
                additionalProperties: false,
              },
            },
          ]
        : []),
      ...(principal.scopes.has("report")
        ? [
            {
              name: "generate_report",
              description:
                "基于指定数据源与章节大纲/参数生成精准数据分析报告，返回 Markdown 报告、结构化数据集与图表规格。",
              inputSchema: {
                type: "object",
                properties: {
                  datasourceId: { type: "string", description: "数据源 UUID" },
                  prompt: { type: "string", description: "报告分析主题与要求" },
                  title: { type: "string", description: "可选报告标题" },
                  sections: {
                    type: "array",
                    items: { type: "string" },
                    description: "可选报告章节列表",
                  },
                  parameters: {
                    type: "object",
                    description: "可选参数键值对（时间范围、区域等）",
                  },
                  endUser: {
                    type: "object",
                    description: "可选终端用户/部门上下文",
                  },
                },
                required: ["datasourceId", "prompt"],
                additionalProperties: false,
              },
            },
          ]
        : []),
    ];

    if (method === "tools/list") {
      recordOpenApiAudit(opts.db, {
        appId: principal.app.id,
        keyId: principal.key.id,
        endpoint: "MCP tools/list",
        status: "ok",
        httpStatus: 200,
        durationMs: Date.now() - startedAt,
      });
      return { jsonrpc: "2.0", id, result: { tools: availableTools } };
    }

    if (method === "tools/call") {
      const toolName = typeof params?.name === "string" ? params.name : "";
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      const mcpError = (code: string, message: string) => ({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
        },
      });

      try {
        if (toolName === "list_datasources") {
          const items = listDatasourcesForAccess(opts.db, principal.serviceAccess)
            .filter((ds) => isAppDatasourceAllowed(principal, ds.id))
            .map((ds) => ({
              id: ds.id,
              name: ds.name,
              type: ds.type,
              status: ds.status,
              dataScopeMode: ds.dataScopeMode,
            }));
          recordOpenApiAudit(opts.db, {
            appId: principal.app.id,
            keyId: principal.key.id,
            endpoint: "MCP list_datasources",
            status: "ok",
            httpStatus: 200,
            durationMs: Date.now() - startedAt,
          });
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify({ items }) }],
              structuredContent: { items },
            },
          };
        }

        if (toolName === "get_semantic_layer") {
          assertOpenScope(principal, "semantic");
          const dsId = typeof args.datasourceId === "string" ? args.datasourceId : "";
          if (!dsId || !isAppDatasourceAllowed(principal, dsId)) {
            return mcpError("DATASOURCE_FORBIDDEN", "数据源不存在或当前应用无权访问");
          }
          const exposeSql = principal.app.exposeSql === 1;
          const payload = {
            datasourceId: dsId,
            metrics: listSemanticMetrics(opts.db, dsId, { onlyEnabled: true }).map((m) => ({
              name: m.name,
              synonyms: m.synonyms,
              description: m.description,
              ...(exposeSql ? { sqlExpression: m.sqlExpression } : {}),
              unit: m.unit,
            })),
            relations: listSemanticRelations(opts.db, dsId, { onlyEnabled: true }).map((r) => ({
              leftTable: r.leftTable,
              leftColumn: r.leftColumn,
              rightTable: r.rightTable,
              rightColumn: r.rightColumn,
              joinType: r.joinType,
            })),
          };
          recordOpenApiAudit(opts.db, {
            appId: principal.app.id,
            keyId: principal.key.id,
            endpoint: "MCP get_semantic_layer",
            datasourceId: dsId,
            status: "ok",
            httpStatus: 200,
            durationMs: Date.now() - startedAt,
          });
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(payload) }],
              structuredContent: payload,
            },
          };
        }

        if (toolName === "ask_data") {
          assertOpenScope(principal, "ask");
          const parsedArgs = askBodySchema
            .pick({ datasourceId: true, question: true, externalSessionId: true, endUser: true })
            .safeParse(args);
          if (!parsedArgs.success) {
            return mcpError("VALIDATION", "ask_data 参数不合法");
          }
          const { result } = await opts.execution.ask({
            principal,
            datasourceId: parsedArgs.data.datasourceId,
            question: parsedArgs.data.question,
            mode: "sync",
            externalSessionId: parsedArgs.data.externalSessionId,
            endUser: parsedArgs.data.endUser,
            endpoint: "MCP ask_data",
          });
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: result.status !== "ok",
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            },
          };
        }

        if (toolName === "generate_report") {
          assertOpenScope(principal, "report");
          const parsedArgs = reportGenerateBodySchema
            .pick({
              datasourceId: true,
              prompt: true,
              title: true,
              sections: true,
              parameters: true,
              endUser: true,
            })
            .safeParse(args);
          if (!parsedArgs.success) {
            return mcpError("VALIDATION", "generate_report 参数不合法");
          }
          const { result } = await opts.execution.generateReport({
            principal,
            datasourceId: parsedArgs.data.datasourceId,
            prompt: parsedArgs.data.prompt,
            title: parsedArgs.data.title,
            sections: parsedArgs.data.sections,
            parameters: parsedArgs.data.parameters,
            mode: "sync",
            endUser: parsedArgs.data.endUser,
            endpoint: "MCP generate_report",
          });
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: result.status !== "ok",
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            },
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown MCP tool: ${toolName}` },
        };
      } catch (error) {
        if (error instanceof OpenPlatformAuthError) {
          recordOpenApiAudit(opts.db, {
            appId: principal.app.id,
            keyId: principal.key.id,
            endpoint: `MCP ${toolName || "tools/call"}`,
            status: "rejected",
            httpStatus: error.httpStatus,
            errorCode: error.code,
            errorMessage: error.message,
            durationMs: Date.now() - startedAt,
          });
          return mcpError(error.code, error.message);
        }
        const message = error instanceof Error ? error.message : "MCP 工具执行失败";
        return mcpError("MCP_TOOL_ERROR", message);
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  });
}
