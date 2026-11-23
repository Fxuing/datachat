import type {
  OpenAskResult,
  OpenChart,
  OpenDataset,
  OpenEndUserContext,
  OpenLineage,
  OpenReportResult,
  OpenSqlLineage,
  OpenUsage,
  RunEvent,
} from "@datachat/shared";
import { REPORT_MAX_ARTIFACTS } from "@datachat/shared";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { createConversation, findConversation, type ConversationRow } from "../db/repositories/conversations.js";
import { findDatasource } from "../db/repositories/datasources.js";
import {
  createOpenAppSession,
  findOpenAppSessionByConversation,
  findOpenAppSessionByExternalId,
  recordOpenApiAudit,
  touchOpenAppSession,
  type OpenAppRow,
  type OpenAppSessionRow,
} from "../db/repositories/open-platform.js";
import { listRunEventsAfter } from "../db/repositories/run-events.js";
import { createRun, findRun, markRun } from "../db/repositories/runs.js";
import { findReport } from "../db/repositories/reports.js";
import { listSemanticMetrics } from "../db/repositories/semantic-layer.js";
import { resolveConversationPermissions, type RuntimeManager } from "../agent/runtime.js";
import { resolveChatModel } from "../agent/model-runtime.js";
import type { ArtifactStore } from "./artifacts.js";
import { resolveDefaultModelId } from "./app-settings.js";
import { enabledProviderIds } from "./llm-catalog.js";
import { parseScopeSnapshot } from "./data-scope.js";
import { buildReportMarkdown, createReport, formatReportTitle } from "./reports.js";
import {
  OpenPlatformAuthError,
  resolveOpenExecutionIdentity,
  type OpenApiPrincipal,
  type ResolvedOpenExecutionIdentity,
} from "./open-platform-auth.js";
import type { OpenWebhookService } from "./open-platform-webhook.js";

export const OPEN_SYNC_TIMEOUT_MS = 120_000;
export const OPEN_ASYNC_WATCH_TIMEOUT_MS = 10 * 60_000;

const INTERNAL_PLACEHOLDER_RE = /\[\[(?:artifact|chart|result):[0-9a-fA-F-]+\]\]/g;

/**
 * Strips DataChat's internal UI placeholders (`[[artifact:]]`, `[[chart:]]`, `[[result:]]`)
 * so external systems receive clean prose/Markdown alongside structured `datasets` and `charts`.
 */
export function stripInternalPlaceholders(markdown: string): string {
  return markdown
    .replace(INTERNAL_PLACEHOLDER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface OpenExecutionServiceOptions {
  db: Db;
  config: AppConfig;
  artifacts: ArtifactStore;
  runtime: RuntimeManager;
  webhooks: OpenWebhookService;
  getModelRuntime?: () => Promise<ModelRuntime>;
  syncTimeoutMs?: number;
}

export interface OpenAskInput {
  principal: OpenApiPrincipal;
  datasourceId: string;
  question: string;
  mode?: "sync" | "async";
  conversationId?: string;
  externalSessionId?: string;
  modelId?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  endUser?: OpenEndUserContext;
  endpoint?: string;
}

export interface OpenReportGenerateInput {
  principal: OpenApiPrincipal;
  datasourceId: string;
  prompt: string;
  title?: string;
  template?: string;
  sections?: string[];
  parameters?: Record<string, string | number | boolean>;
  mode?: "sync" | "async";
  modelId?: string;
  endUser?: OpenEndUserContext;
  endpoint?: string;
}

export function composeReportPrompt(input: {
  prompt: string;
  title?: string;
  template?: string;
  sections?: string[];
  parameters?: Record<string, string | number | boolean>;
}): string {
  const parts: string[] = [
    "请作为专业的数据分析报告生成引擎，严格基于真实只读 SQL 查询结果撰写一份精准、结构清晰、可直接交付业务使用的分析报告。",
    "要求：",
    "1. 先查 schema 并遵循语义层指标口径，所有关键数字必须来自真实查询结果，绝不臆造。",
    "2. 对适合可视化的数据主动生成图表（调用 make_chart）。",
    "3. 明确列出统计周期、过滤口径、关键发现、异常波动与可执行建议。",
  ];
  if (input.title) parts.push(`\n报告标题：${input.title}`);
  if (input.parameters && Object.keys(input.parameters).length > 0) {
    const paramLines = Object.entries(input.parameters).map(([k, v]) => `- ${k}: ${String(v)}`);
    parts.push(`\n报告参数：\n${paramLines.join("\n")}`);
  }
  if (input.sections && input.sections.length > 0) {
    const sectionLines = input.sections.map((s, idx) => `${idx + 1}. ${s}`);
    parts.push(`\n请严格按以下章节结构组织报告：\n${sectionLines.join("\n")}`);
  }
  if (input.template) {
    parts.push(`\n参考报告模板：\n${input.template}`);
  }
  parts.push(`\n核心分析诉求：\n${input.prompt}`);
  return parts.join("\n");
}

function extractRunTranscript(db: Db, runId: string): {
  rawAnswer: string;
  sqls: OpenSqlLineage[];
  resultPreviews: Map<string, unknown[][]>;
} {
  const events = listRunEventsAfter(db, runId, 0);
  const deltas: string[] = [];
  let assistantFull: string | null = null;
  const sqls: OpenSqlLineage[] = [];
  const resultPreviews = new Map<string, unknown[][]>();

  for (const row of events) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      continue;
    }
    const event = { type: row.type, payload } as RunEvent;
    if (event.type === "text_delta" && typeof event.payload?.text === "string") {
      deltas.push(event.payload.text);
    } else if (event.type === "assistant_message" && typeof event.payload?.content === "string") {
      assistantFull = event.payload.content;
    } else if (event.type === "sql" && event.payload) {
      sqls.push({
        sql: event.payload.sql,
        auditId: event.payload.auditId,
        status: event.payload.status,
      });
    } else if (event.type === "result" && event.payload) {
      resultPreviews.set(event.payload.artifactId, event.payload.rows);
    }
  }

  return {
    rawAnswer: assistantFull ?? deltas.join(""),
    sqls,
    resultPreviews,
  };
}

function buildLineage(
  db: Db,
  input: {
    datasourceId: string;
    exposeSql: boolean;
    sqls: OpenSqlLineage[];
    scopeSnapshotRaw: string | null;
    questionText?: string;
  },
): OpenLineage {
  const snapshot = parseScopeSnapshot(input.scopeSnapshotRaw);
  const scope =
    snapshot && snapshot.departments.length > 0
      ? {
          departments: snapshot.departmentNames ?? snapshot.departments,
          ...(snapshot.scopedTables ? { scopedTables: snapshot.scopedTables } : {}),
        }
      : null;

  const allMetrics = listSemanticMetrics(db, input.datasourceId, { onlyEnabled: true });
  const qLower = (input.questionText ?? "").toLowerCase();
  const matchedMetrics = allMetrics
    .filter((metric) => {
      if (!qLower) return true;
      if (qLower.includes(metric.name.toLowerCase())) return true;
      return metric.synonyms.some((syn) => syn && qLower.includes(syn.toLowerCase()));
    })
    .slice(0, 10)
    .map((metric) => ({
      name: metric.name,
      formula: metric.sqlExpression,
      unit: metric.unit,
    }));

  return {
    ...(input.exposeSql ? { sqls: input.sqls } : {}),
    scope,
    semanticMetrics: matchedMetrics,
  };
}

/** Stream a bounded page of rows from a result artifact without loading the full file into memory. */
export async function readArtifactRowsPage(
  artifacts: ArtifactStore,
  artifactId: string,
  offset: number,
  limit: number,
): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  let index = 0;
  for await (const row of artifacts.openRows(artifactId)) {
    if (index >= offset) {
      rows.push(row);
      if (rows.length >= limit) break;
    }
    index += 1;
  }
  return rows;
}

export async function buildOpenAskResult(
  db: Db,
  artifacts: ArtifactStore,
  input: {
    app: OpenAppRow;
    session: OpenAppSessionRow;
    runId: string;
    questionText?: string;
  },
): Promise<OpenAskResult | null> {
  const run = findRun(db, input.runId);
  if (!run || run.conversationId !== input.session.conversationId) return null;

  const { rawAnswer, sqls, resultPreviews } = extractRunTranscript(db, run.id);
  const artifactRows = artifacts.list({ runId: run.id, limit: REPORT_MAX_ARTIFACTS });

  const datasets: OpenDataset[] = [];
  const charts: OpenChart[] = [];

  for (const meta of artifactRows) {
    if (meta.kind === "result") {
      let previewRows = resultPreviews.get(meta.id);
      if (!previewRows) {
        try {
          previewRows = await readArtifactRowsPage(artifacts, meta.id, 0, 20);
        } catch {
          previewRows = [];
        }
      }
      datasets.push({
        artifactId: meta.id,
        columns: meta.columns,
        previewRows,
        rowCount: meta.rowCount,
        truncated: meta.truncated,
        rowsUrl: `/api/open/v1/artifacts/${meta.id}/rows`,
      });
    } else if (meta.kind === "chart" && meta.specJson) {
      try {
        const spec: unknown = JSON.parse(meta.specJson);
        charts.push({ artifactId: meta.id, spec });
      } catch {
        // Skip unreadable chart artifact.
      }
    }
  }

  const usage: OpenUsage | null =
    run.inputTokens !== null || run.outputTokens !== null
      ? {
          input: run.inputTokens ?? 0,
          output: run.outputTokens ?? 0,
          cacheRead: run.cacheReadTokens ?? 0,
          cacheWrite: run.cacheWriteTokens ?? 0,
        }
      : null;

  const durationMs =
    run.startedAt !== null && run.endedAt !== null ? Math.max(0, run.endedAt - run.startedAt) : null;

  const status: OpenAskResult["status"] =
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "ok" ||
    run.status === "error" ||
    run.status === "aborted"
      ? run.status
      : "error";

  return {
    runId: run.id,
    conversationId: run.conversationId,
    externalSessionId: input.session.externalSessionId,
    datasourceId: input.session.datasourceId,
    status,
    answer: stripInternalPlaceholders(rawAnswer),
    rawAnswer,
    datasets,
    charts,
    lineage: buildLineage(db, {
      datasourceId: input.session.datasourceId,
      exposeSql: input.app.exposeSql === 1,
      sqls,
      scopeSnapshotRaw: run.scopeSnapshot,
      questionText: input.questionText,
    }),
    usage,
    durationMs,
    error: run.error,
    createdAt: run.createdAt,
  };
}

export class OpenExecutionService {
  private readonly db: Db;
  private readonly config: AppConfig;
  private readonly artifacts: ArtifactStore;
  private readonly runtime: RuntimeManager;
  private readonly webhooks: OpenWebhookService;
  private readonly getModelRuntime: (() => Promise<ModelRuntime>) | undefined;
  private readonly syncTimeoutMs: number;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly unsubscribes = new Set<() => void>();
  private readonly pendingAsync = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: OpenExecutionServiceOptions) {
    this.db = options.db;
    this.config = options.config;
    this.artifacts = options.artifacts;
    this.runtime = options.runtime;
    this.webhooks = options.webhooks;
    this.getModelRuntime = options.getModelRuntime;
    this.syncTimeoutMs = options.syncTimeoutMs ?? OPEN_SYNC_TIMEOUT_MS;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes.clear();
    await Promise.allSettled([...this.pendingAsync]);
  }

  private async resolveModelId(app: OpenAppRow, requestedModelId?: string): Promise<string | null> {
    let candidate = requestedModelId ?? app.defaultModelId ?? null;
    if (!candidate && this.getModelRuntime) {
      candidate = await resolveDefaultModelId({
        db: this.db,
        config: this.config,
        getRuntime: this.getModelRuntime,
      });
    }
    if (!candidate) return null;
    if (!this.getModelRuntime) return candidate;
    const providerIds = enabledProviderIds(this.db);
    if (providerIds.length === 0) return candidate;
    try {
      const model = resolveChatModel(await this.getModelRuntime(), candidate, providerIds);
      if (requestedModelId && !model) {
        throw new OpenPlatformAuthError("MODEL_NOT_FOUND", `模型「${requestedModelId}」不存在或未启用`, 400);
      }
      return model ? `${model.provider}/${model.id}` : candidate;
    } catch (error) {
      if (error instanceof OpenPlatformAuthError) throw error;
      return candidate;
    }
  }

  private resolveOrCreateSession(input: {
    principal: OpenApiPrincipal;
    identity: ResolvedOpenExecutionIdentity;
    conversationId?: string;
    externalSessionId?: string;
    modelId: string | null;
    thinkingLevel?: string;
    title: string;
  }): { conversation: ConversationRow; session: OpenAppSessionRow } {
    const { principal, identity, conversationId, externalSessionId, modelId, thinkingLevel, title } = input;

    let existingSession: OpenAppSessionRow | undefined;
    if (conversationId) {
      existingSession = findOpenAppSessionByConversation(this.db, principal.app.id, conversationId);
      if (!existingSession) {
        throw new OpenPlatformAuthError("SESSION_NOT_FOUND", "会话不存在或不属于当前应用", 404);
      }
    } else if (externalSessionId) {
      existingSession = findOpenAppSessionByExternalId(this.db, principal.app.id, externalSessionId);
    }

    if (existingSession) {
      if (existingSession.datasourceId !== identity.datasource.id) {
        throw new OpenPlatformAuthError(
          "SESSION_DATASOURCE_MISMATCH",
          "已有会话绑定的数据源与本次请求不一致",
          400,
        );
      }
      if (existingSession.effectiveUserId !== identity.effectiveUser.id) {
        throw new OpenPlatformAuthError(
          "SESSION_IDENTITY_MISMATCH",
          "已有会话归属用户与本次请求不一致",
          403,
        );
      }
      const conversation = findConversation(this.db, existingSession.conversationId);
      if (conversation) {
        touchOpenAppSession(this.db, existingSession.id);
        return { conversation, session: existingSession };
      }
    }

    // Open Platform conversations use `kind: "scheduled"` so they stay hidden from the
    // service account's personal chat sidebar while reusing the exact same Pi runtime.
    const conversation = createConversation(this.db, {
      userId: identity.effectiveUser.id,
      datasourceId: identity.datasource.id,
      title: title.slice(0, 100),
      modelId,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      kind: "scheduled",
    });

    const session = createOpenAppSession(this.db, {
      appId: principal.app.id,
      conversationId: conversation.id,
      datasourceId: identity.datasource.id,
      externalSessionId: externalSessionId ?? null,
      externalUserId: identity.externalUserId,
      effectiveUserId: identity.effectiveUser.id,
      scopeDepartmentIds: identity.scopeDepartmentOverride?.effectiveIds ?? null,
    });

    return { conversation, session };
  }

  private waitForRunEnd(
    conversationId: string,
    runId: string,
    timeoutMs: number,
  ): Promise<{ status: string; error?: string }> {
    const existing = findRun(this.db, runId);
    if (existing && (existing.status === "ok" || existing.status === "error" || existing.status === "aborted")) {
      return Promise.resolve({ status: existing.status, error: existing.error ?? undefined });
    }

    return new Promise((resolve) => {
      let settled = false;
      // eslint-disable-next-line prefer-const -- assigned after finish closes over them
      let timer: NodeJS.Timeout | undefined;
      // eslint-disable-next-line prefer-const -- assigned after finish closes over them
      let unsub: (() => void) | undefined;

      const finish = (payload: { status: string; error?: string }) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(timer);
        }
        if (unsub) {
          unsub();
          this.unsubscribes.delete(unsub);
        }
        resolve(payload);
      };

      unsub = this.runtime.bus.subscribe(conversationId, (live) => {
        if (live.runId !== runId || live.event.type !== "run_end") return;
        finish(live.event.payload as { status: string; error?: string });
      });
      this.unsubscribes.add(unsub);

      timer = setTimeout(() => {
        this.runtime.abort(conversationId, runId);
        finish({ status: "error", error: "请求执行超时" });
      }, timeoutMs);
      timer.unref?.();
      this.timers.add(timer);
    });
  }

  private queryLimitsOverride(app: OpenAppRow) {
    if (!app.maxRowsOverride && !app.timeoutMsOverride) return undefined;
    return {
      maxRows: app.maxRowsOverride,
      timeoutMs: app.timeoutMsOverride,
    };
  }

  async ask(input: OpenAskInput): Promise<{ result: OpenAskResult; httpStatus: number }> {
    const startedAt = Date.now();
    const endpoint = input.endpoint ?? "POST /api/open/v1/ask";
    const identity = resolveOpenExecutionIdentity(this.db, {
      principal: input.principal,
      datasourceId: input.datasourceId,
      requiredPermissions: ["chat.use"],
      endUser: input.endUser,
    });

    const modelId = await this.resolveModelId(input.principal.app, input.modelId);
    const { conversation, session } = this.resolveOrCreateSession({
      principal: input.principal,
      identity,
      conversationId: input.conversationId,
      externalSessionId: input.externalSessionId,
      modelId,
      thinkingLevel: input.thinkingLevel,
      title: `[Open:${input.principal.app.name}] ${input.question.slice(0, 60)}`,
    });

    const run = createRun(this.db, {
      conversationId: conversation.id,
      userId: identity.effectiveUser.id,
      modelId: modelId ?? conversation.modelId,
    });

    const basePerms = resolveConversationPermissions(this.db, identity.effectiveUser.id);
    const convRuntime = await this.runtime.getOrCreate(conversation, identity.effectiveUser.id, {
      permissions: {
        ...basePerms,
        // Disable cross-conversation personal memory leakage on Open Platform sessions.
        memory: false,
      },
      ...(input.principal.app.systemPromptExtra
        ? { extraInstructions: input.principal.app.systemPromptExtra }
        : {}),
    });

    const mode = input.mode ?? "sync";
    const completionPromise = this.waitForRunEnd(
      conversation.id,
      run.id,
      mode === "sync" ? this.syncTimeoutMs : OPEN_ASYNC_WATCH_TIMEOUT_MS,
    );

    try {
      convRuntime.enqueue({
        runId: run.id,
        content: input.question,
        displayContent: input.question,
        ...(identity.scopeDepartmentOverride
          ? { scopeDepartmentOverride: identity.scopeDepartmentOverride }
          : {}),
        ...(this.queryLimitsOverride(input.principal.app)
          ? { queryLimitsOverride: this.queryLimitsOverride(input.principal.app) }
          : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markRun(this.db, run.id, { status: "error", error: message, endedAt: Date.now() });
      recordOpenApiAudit(this.db, {
        appId: input.principal.app.id,
        keyId: input.principal.key.id,
        endpoint,
        datasourceId: identity.datasource.id,
        conversationId: conversation.id,
        runId: run.id,
        externalUserId: identity.externalUserId,
        effectiveUserId: identity.effectiveUser.id,
        status: "error",
        httpStatus: 500,
        errorCode: "ENQUEUE_FAILED",
        errorMessage: message,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }

    if (mode === "async") {
      const bg = completionPromise
        .then(async () => {
          if (this.closed) return;
          const finished = await buildOpenAskResult(this.db, this.artifacts, {
            app: input.principal.app,
            session,
            runId: run.id,
            questionText: input.question,
          });
          if (!finished) return;
          recordOpenApiAudit(this.db, {
            appId: input.principal.app.id,
            keyId: input.principal.key.id,
            endpoint,
            datasourceId: identity.datasource.id,
            conversationId: conversation.id,
            runId: run.id,
            externalUserId: identity.externalUserId,
            effectiveUserId: identity.effectiveUser.id,
            status: finished.status === "ok" ? "ok" : "error",
            httpStatus: finished.status === "ok" ? 200 : 500,
            errorCode: finished.status === "ok" ? null : "RUN_FAILED",
            errorMessage: finished.error,
            durationMs: Date.now() - startedAt,
            inputTokens: finished.usage?.input ?? 0,
            outputTokens: finished.usage?.output ?? 0,
          });
          this.webhooks.dispatch({
            app: input.principal.app,
            event: finished.status === "ok" ? "ask.completed" : "ask.failed",
            payload: finished,
          });
        })
        .catch(() => undefined);
      this.pendingAsync.add(bg);
      void bg.finally(() => this.pendingAsync.delete(bg));

      const initial = (await buildOpenAskResult(this.db, this.artifacts, {
        app: input.principal.app,
        session,
        runId: run.id,
        questionText: input.question,
      }))!;
      return { result: initial, httpStatus: 202 };
    }

    await completionPromise;
    const finalResult = (await buildOpenAskResult(this.db, this.artifacts, {
      app: input.principal.app,
      session,
      runId: run.id,
      questionText: input.question,
    }))!;

    recordOpenApiAudit(this.db, {
      appId: input.principal.app.id,
      keyId: input.principal.key.id,
      endpoint,
      datasourceId: identity.datasource.id,
      conversationId: conversation.id,
      runId: run.id,
      externalUserId: identity.externalUserId,
      effectiveUserId: identity.effectiveUser.id,
      status: finalResult.status === "ok" ? "ok" : "error",
      httpStatus: finalResult.status === "ok" ? 200 : 500,
      errorCode: finalResult.status === "ok" ? null : "RUN_FAILED",
      errorMessage: finalResult.error,
      durationMs: Date.now() - startedAt,
      inputTokens: finalResult.usage?.input ?? 0,
      outputTokens: finalResult.usage?.output ?? 0,
    });

    this.webhooks.dispatch({
      app: input.principal.app,
      event: finalResult.status === "ok" ? "ask.completed" : "ask.failed",
      payload: finalResult,
    });

    return { result: finalResult, httpStatus: 200 };
  }

  async generateReport(
    input: OpenReportGenerateInput,
  ): Promise<{ result: OpenReportResult; httpStatus: number }> {
    const startedAt = Date.now();
    const endpoint = input.endpoint ?? "POST /api/open/v1/reports/generate";
    const identity = resolveOpenExecutionIdentity(this.db, {
      principal: input.principal,
      datasourceId: input.datasourceId,
      requiredPermissions: ["chat.use", "report.create"],
      endUser: input.endUser,
    });

    const modelId = await this.resolveModelId(input.principal.app, input.modelId);
    const reportTitle = input.title?.trim() || formatReportTitle(Date.now());
    const composedPrompt = composeReportPrompt({
      prompt: input.prompt,
      title: reportTitle,
      template: input.template,
      sections: input.sections,
      parameters: input.parameters,
    });

    const { conversation, session } = this.resolveOrCreateSession({
      principal: input.principal,
      identity,
      modelId,
      title: `[OpenReport:${input.principal.app.name}] ${reportTitle}`,
    });

    const run = createRun(this.db, {
      conversationId: conversation.id,
      userId: identity.effectiveUser.id,
      modelId: modelId ?? conversation.modelId,
    });

    const basePerms = resolveConversationPermissions(this.db, identity.effectiveUser.id);
    const convRuntime = await this.runtime.getOrCreate(conversation, identity.effectiveUser.id, {
      permissions: {
        ...basePerms,
        reports: true,
        memory: false,
      },
      ...(input.principal.app.systemPromptExtra
        ? { extraInstructions: input.principal.app.systemPromptExtra }
        : {}),
    });

    const mode = input.mode ?? "sync";
    const completionPromise = this.waitForRunEnd(
      conversation.id,
      run.id,
      mode === "sync" ? this.syncTimeoutMs : OPEN_ASYNC_WATCH_TIMEOUT_MS,
    );

    convRuntime.enqueue({
      runId: run.id,
      content: composedPrompt,
      displayContent: input.prompt,
      ...(identity.scopeDepartmentOverride
        ? { scopeDepartmentOverride: identity.scopeDepartmentOverride }
        : {}),
      ...(this.queryLimitsOverride(input.principal.app)
        ? { queryLimitsOverride: this.queryLimitsOverride(input.principal.app) }
        : {}),
    });

    const finalizeReport = async (): Promise<OpenReportResult> => {
      const askResult = (await buildOpenAskResult(this.db, this.artifacts, {
        app: input.principal.app,
        session,
        runId: run.id,
        questionText: input.prompt,
      }))!;

      let reportId: string | null = null;
      let markdown = askResult.answer;

      if (askResult.status === "ok") {
        const produced = this.artifacts.list({ runId: run.id, limit: REPORT_MAX_ARTIFACTS });
        if (produced.length > 0) {
          const composedMd = markdown.trim()
            ? markdown
            : `# ${reportTitle}\n\n${buildReportMarkdown(this.db, produced)}`;
          const created = createReport({
            db: this.db,
            artifacts: this.artifacts,
            userId: identity.effectiveUser.id,
            conversationId: conversation.id,
            artifactIds: produced.map((item) => item.id),
            title: reportTitle,
            markdown: composedMd,
          });
          if (created.ok) {
            reportId = created.report.id;
            markdown = stripInternalPlaceholders(created.report.markdown);
          }
        }
      }

      const reportResult: OpenReportResult = {
        reportId,
        runId: run.id,
        conversationId: conversation.id,
        datasourceId: identity.datasource.id,
        status: askResult.status,
        title: reportTitle,
        markdown,
        datasets: askResult.datasets,
        charts: askResult.charts,
        lineage: askResult.lineage,
        usage: askResult.usage,
        durationMs: askResult.durationMs,
        error: askResult.error,
        createdAt: askResult.createdAt,
      };

      recordOpenApiAudit(this.db, {
        appId: input.principal.app.id,
        keyId: input.principal.key.id,
        endpoint,
        datasourceId: identity.datasource.id,
        conversationId: conversation.id,
        runId: run.id,
        reportId,
        externalUserId: identity.externalUserId,
        effectiveUserId: identity.effectiveUser.id,
        status: reportResult.status === "ok" ? "ok" : "error",
        httpStatus: reportResult.status === "ok" ? 200 : 500,
        errorCode: reportResult.status === "ok" ? null : "REPORT_FAILED",
        errorMessage: reportResult.error,
        durationMs: Date.now() - startedAt,
        inputTokens: reportResult.usage?.input ?? 0,
        outputTokens: reportResult.usage?.output ?? 0,
      });

      this.webhooks.dispatch({
        app: input.principal.app,
        event: reportResult.status === "ok" ? "report.completed" : "report.failed",
        payload: reportResult,
      });

      return reportResult;
    };

    if (mode === "async") {
      const bg = completionPromise
        .then(async () => {
          if (this.closed) return;
          await finalizeReport();
        })
        .catch(() => undefined);
      this.pendingAsync.add(bg);
      void bg.finally(() => this.pendingAsync.delete(bg));

      return {
        httpStatus: 202,
        result: {
          reportId: null,
          runId: run.id,
          conversationId: conversation.id,
          datasourceId: identity.datasource.id,
          status: "queued",
          title: reportTitle,
          markdown: "",
          datasets: [],
          charts: [],
          lineage: {
            ...(input.principal.app.exposeSql === 1 ? { sqls: [] } : {}),
            scope: null,
            semanticMetrics: [],
          },
          usage: null,
          durationMs: null,
          error: null,
          createdAt: run.createdAt,
        },
      };
    }

    await completionPromise;
    const result = await finalizeReport();
    return { result, httpStatus: 200 };
  }

  async getRunResult(app: OpenAppRow, runId: string): Promise<OpenAskResult | null> {
    const run = findRun(this.db, runId);
    if (!run) return null;
    const session = findOpenAppSessionByConversation(this.db, app.id, run.conversationId);
    if (!session) return null;
    return buildOpenAskResult(this.db, this.artifacts, { app, session, runId });
  }

  async getReportResult(app: OpenAppRow, reportId: string): Promise<{
    id: string;
    title: string;
    markdown: string;
    datasourceId: string;
    conversationId: string;
    datasets: OpenDataset[];
    charts: OpenChart[];
    createdAt: number;
    updatedAt: number;
  } | null> {
    const report = findReport(this.db, reportId);
    if (!report) return null;
    const session = findOpenAppSessionByConversation(this.db, app.id, report.conversationId);
    if (!session) return null;
    const datasource = findDatasource(this.db, session.datasourceId);
    if (!datasource) return null;

    const artifactIds: string[] = (() => {
      try {
        const parsed = JSON.parse(report.artifactIdsJson) as unknown;
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
      } catch {
        return [];
      }
    })();

    const datasets: OpenDataset[] = [];
    const charts: OpenChart[] = [];

    for (const artifactId of artifactIds) {
      const meta = this.artifacts.get(artifactId);
      if (!meta || meta.conversationId !== report.conversationId) continue;
      if (meta.kind === "result") {
        let previewRows: unknown[][] = [];
        try {
          previewRows = await readArtifactRowsPage(this.artifacts, meta.id, 0, 20);
        } catch {
          previewRows = [];
        }
        datasets.push({
          artifactId: meta.id,
          columns: meta.columns,
          previewRows,
          rowCount: meta.rowCount,
          truncated: meta.truncated,
          rowsUrl: `/api/open/v1/artifacts/${meta.id}/rows`,
        });
      } else if (meta.kind === "chart" && meta.specJson) {
        try {
          charts.push({ artifactId: meta.id, spec: JSON.parse(meta.specJson) as unknown });
        } catch {
          // Ignore corrupted chart.
        }
      }
    }

    return {
      id: report.id,
      title: report.title,
      markdown: stripInternalPlaceholders(report.markdown),
      datasourceId: session.datasourceId,
      conversationId: report.conversationId,
      datasets,
      charts,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }
}
