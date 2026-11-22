import { and, desc, eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import { findConversation } from "../db/repositories/conversations.js";
import { findDatasource } from "../db/repositories/datasources.js";
import {
  findOwnedDashboard,
  findOwnedDashboardCard,
  insertDashboardCard,
  listDashboardCardRows,
  toDashboardCardDto,
  updateOwnedDashboardCard,
  type DashboardCardDto,
} from "../db/repositories/dashboards.js";
import { queryAudit } from "../db/schema.js";
import { MAX_CHART_INPUT_ROWS, type ArtifactStore } from "./artifacts.js";
import { ChartError, buildChartOption, type ChartInput } from "./charts.js";
import { runGuardedQuery } from "./query-service.js";
import { artifactRunVisible } from "./scope-access.js";

export const MAX_CARDS_PER_DASHBOARD = 30;

export interface DashboardServiceDeps {
  db: Db;
  config: AppConfig;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
}

export type PinCardResult =
  | { ok: true; card: DashboardCardDto }
  | { ok: false; status: number; code: string; message: string };

export type RefreshCardResult =
  | { ok: true; card: DashboardCardDto }
  | { ok: false; status: number; code: string; message: string; card?: DashboardCardDto };

function parseChartInput(spec: unknown): ChartInput | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const chart = (spec as Record<string, unknown>).chart;
  if (!chart || typeof chart !== "object" || Array.isArray(chart)) return null;
  const record = chart as Record<string, unknown>;
  const type = record.type;
  const x = record.x;
  const y = record.y;
  if (
    (type !== "bar" && type !== "line" && type !== "area" && type !== "pie" && type !== "scatter") ||
    typeof x !== "string" ||
    typeof y !== "string"
  ) {
    return null;
  }
  const agg = record.aggregate;
  const validAgg =
    agg === "sum" || agg === "avg" || agg === "count" || agg === "min" || agg === "max"
      ? agg
      : undefined;
  return {
    type,
    x,
    y,
    ...(typeof record.series === "string" ? { series: record.series } : {}),
    ...(validAgg ? { aggregate: validAgg } : {}),
    ...(typeof record.title === "string" && record.title.trim()
      ? { title: record.title.trim() }
      : {}),
  };
}

function findRunQuerySql(db: Db, runId: string | null): string | null {
  if (!runId) return null;
  const row = db
    .select({ sqlText: queryAudit.sqlText })
    .from(queryAudit)
    .where(
      and(
        eq(queryAudit.runId, runId),
        eq(queryAudit.action, "query"),
        eq(queryAudit.status, "ok"),
      ),
    )
    .orderBy(desc(queryAudit.createdAt))
    .limit(1)
    .get();
  return row?.sqlText ?? null;
}

export function pinChartArtifactToDashboard(
  deps: Pick<DashboardServiceDeps, "db" | "artifacts">,
  input: {
    dashboardId: string;
    userId: string;
    isAdmin: boolean;
    artifactId: string;
    title?: string;
    width?: 1 | 2;
  },
): PinCardResult {
  const dashboard = findOwnedDashboard(deps.db, input.dashboardId, input.userId);
  if (!dashboard) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "看板不存在" };
  }

  const existingCards = listDashboardCardRows(deps.db, dashboard.id);
  if (existingCards.length >= MAX_CARDS_PER_DASHBOARD) {
    return {
      ok: false,
      status: 409,
      code: "CARD_LIMIT",
      message: `单个看板最多固定 ${MAX_CARDS_PER_DASHBOARD} 张卡片`,
    };
  }

  const artifact = deps.artifacts.get(input.artifactId);
  if (
    !artifact ||
    artifact.userId !== input.userId ||
    !artifactRunVisible(deps.db, artifact.runId, input.isAdmin)
  ) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "图表不存在" };
  }
  if (artifact.kind !== "chart" || !artifact.specJson) {
    return { ok: false, status: 400, code: "VALIDATION", message: "只能固定图表类型的结果" };
  }

  let parsedSpec: unknown;
  try {
    parsedSpec = JSON.parse(artifact.specJson);
  } catch {
    return { ok: false, status: 400, code: "VALIDATION", message: "图表配置无效" };
  }

  const chartConfig = parseChartInput(parsedSpec);
  const conversation = artifact.conversationId
    ? findConversation(deps.db, artifact.conversationId)
    : undefined;
  const datasourceId =
    conversation && conversation.sourceKind === "datasource" ? conversation.datasourceId : null;
  const datasourceName = datasourceId
    ? (findDatasource(deps.db, datasourceId)?.name ?? null)
    : null;

  // Prefer the SQL for the source result artifact's run when present, falling back to chart's run.
  let sourceRunId = artifact.runId;
  const sourceArtId =
    parsedSpec && typeof parsedSpec === "object" && !Array.isArray(parsedSpec)
      ? (parsedSpec as Record<string, unknown>).sourceArtifactId
      : null;
  if (typeof sourceArtId === "string") {
    const sourceMeta = deps.artifacts.findMeta(sourceArtId);
    if (sourceMeta && sourceMeta.userId === input.userId && sourceMeta.runId) {
      sourceRunId = sourceMeta.runId;
    }
  }
  const sqlText = datasourceId ? findRunQuerySql(deps.db, sourceRunId) : null;

  const title = input.title?.trim() || chartConfig?.title || "图表卡片";
  const nextPosition =
    existingCards.length > 0
      ? Math.max(...existingCards.map((c) => c.position)) + 1
      : 0;

  const row = insertDashboardCard(deps.db, {
    dashboardId: dashboard.id,
    userId: input.userId,
    title,
    sourceConversationId: artifact.conversationId,
    sourceArtifactId: artifact.id,
    datasourceId,
    sqlText,
    chartConfigJson: chartConfig ? JSON.stringify(chartConfig) : null,
    specJson: artifact.specJson,
    points: artifact.rowCount,
    width: input.width ?? 1,
    position: nextPosition,
    lastRefreshedAt: artifact.createdAt,
  });

  return { ok: true, card: toDashboardCardDto(row, datasourceName) };
}

/**
 * Refresh a pinned dashboard card by re-running its persisted SQL through
 * `runGuardedQuery` (enforcing current datasource grants, read-only guard,
 * row-level data scope rewrite, and audit logging) and rebuilding the chart spec.
 */
export async function refreshDashboardCard(
  deps: DashboardServiceDeps,
  input: {
    dashboardId: string;
    cardId: string;
    userId: string;
  },
): Promise<RefreshCardResult> {
  const card = findOwnedDashboardCard(deps.db, input.dashboardId, input.cardId, input.userId);
  if (!card) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "看板卡片不存在" };
  }

  const datasource = card.datasourceId ? findDatasource(deps.db, card.datasourceId) : undefined;
  const dsName = datasource?.name ?? null;

  if (!card.datasourceId || !card.sqlText || !card.chartConfigJson) {
    return {
      ok: false,
      status: 400,
      code: "NOT_REFRESHABLE",
      message: "该卡片为静态快照，不支持实时刷新",
      card: toDashboardCardDto(card, dsName),
    };
  }

  let chartConfig: ChartInput | null = null;
  try {
    chartConfig = parseChartInput({ chart: JSON.parse(card.chartConfigJson) });
  } catch {
    chartConfig = null;
  }
  if (!chartConfig) {
    return {
      ok: false,
      status: 400,
      code: "NOT_REFRESHABLE",
      message: "图表配置不完整，无法刷新",
      card: toDashboardCardDto(card, dsName),
    };
  }

  if (!datasource) {
    const message = "关联数据源已不存在";
    const updated =
      updateOwnedDashboardCard(deps.db, card.dashboardId, card.id, input.userId, {
        lastError: message,
      }) ?? card;
    return {
      ok: false,
      status: 404,
      code: "DATASOURCE_NOT_FOUND",
      message,
      card: toDashboardCardDto(updated, null),
    };
  }

  const queryResult = await runGuardedQuery(
    {
      db: deps.db,
      config: deps.config,
      pools: deps.pools,
      artifacts: deps.artifacts,
    },
    {
      datasource,
      userId: input.userId,
      conversationId: null,
      runId: null,
      sql: card.sqlText,
    },
  );

  if (!queryResult.ok) {
    const updated =
      updateOwnedDashboardCard(deps.db, card.dashboardId, card.id, input.userId, {
        lastError: queryResult.reason,
      }) ?? card;
    const status =
      queryResult.code === "FORBIDDEN" || queryResult.code.startsWith("DATA_SCOPE_") ? 403 : 422;
    return {
      ok: false,
      status,
      code: queryResult.code,
      message: queryResult.reason,
      card: toDashboardCardDto(updated, dsName),
    };
  }

  const streamData = await deps.artifacts.readRowsStream(
    queryResult.artifactId,
    MAX_CHART_INPUT_ROWS,
  );
  if (!streamData) {
    const message = "无法读取刷新后的查询结果";
    const updated =
      updateOwnedDashboardCard(deps.db, card.dashboardId, card.id, input.userId, {
        lastError: message,
      }) ?? card;
    return {
      ok: false,
      status: 500,
      code: "ARTIFACT_READ_FAILED",
      message,
      card: toDashboardCardDto(updated, dsName),
    };
  }

  try {
    const built = buildChartOption({
      rows: streamData.rows,
      columns: streamData.meta.columns,
      chart: { ...chartConfig, title: card.title },
    });
    const nextSpec = {
      option: built.option,
      chart: { ...chartConfig, title: card.title },
    };
    const now = Date.now();
    const updated =
      updateOwnedDashboardCard(deps.db, card.dashboardId, card.id, input.userId, {
        specJson: JSON.stringify(nextSpec),
        points: built.points,
        lastRefreshedAt: now,
        lastError: null,
      }) ?? card;
    return { ok: true, card: toDashboardCardDto(updated, dsName) };
  } catch (err) {
    const message =
      err instanceof ChartError
        ? err.message
        : err instanceof Error
          ? err.message
          : "重绘图表失败";
    const updated =
      updateOwnedDashboardCard(deps.db, card.dashboardId, card.id, input.userId, {
        lastError: message,
      }) ?? card;
    return {
      ok: false,
      status: 422,
      code: err instanceof ChartError ? err.code : "CHART_ERROR",
      message,
      card: toDashboardCardDto(updated, dsName),
    };
  }
}
