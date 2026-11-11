import { and, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { conversations, datasources, queryAudit, runs } from "../db/schema.js";

const DAY_MS = 86_400_000;

export interface OpsMetrics {
  range: { days: number; from: number; to: number };
  totals: {
    runs: number;
    ok: number;
    error: number;
    aborted: number;
    queuedOrRunning: number;
    successRate: number;
    p50Ms: number;
    p95Ms: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    activeUsers: number;
  };
  daily: Array<{
    date: string;
    runs: number;
    ok: number;
    error: number;
    aborted: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  datasources: Array<{
    datasourceId: string;
    name: string;
    runs: number;
    failed: number;
  }>;
  queries: {
    total: number;
    rejected: number;
    error: number;
    timeout: number;
    averageRows: number | null;
  };
}

export interface OpsMetricsOptions {
  db: Db;
  days: number;
  now?: () => number;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dayKeys(from: number, to: number): string[] {
  const keys: string[] = [];
  const start = Date.UTC(
    new Date(from).getUTCFullYear(),
    new Date(from).getUTCMonth(),
    new Date(from).getUTCDate(),
  );
  for (let cursor = start; cursor <= to; cursor += DAY_MS) {
    keys.push(utcDate(cursor));
  }
  return keys;
}

export function getOpsMetrics(options: OpsMetricsOptions): OpsMetrics {
  const now = options.now ?? Date.now;
  const to = now();
  const from = to - options.days * DAY_MS;

  const rows = options.db
    .select({
      status: runs.status,
      userId: runs.userId,
      inputTokens: runs.inputTokens,
      outputTokens: runs.outputTokens,
      cacheReadTokens: runs.cacheReadTokens,
      cacheWriteTokens: runs.cacheWriteTokens,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      createdAt: runs.createdAt,
      datasourceId: conversations.datasourceId,
    })
    .from(runs)
    .leftJoin(conversations, eq(runs.conversationId, conversations.id))
    .where(and(gte(runs.createdAt, from), lt(runs.createdAt, to + 1)))
    .all();

  let ok = 0;
  let error = 0;
  let aborted = 0;
  let queuedOrRunning = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const durations: number[] = [];
  const users = new Set<string>();
  const daily = new Map(
    dayKeys(from, to).map((date) => [
      date,
      { date, runs: 0, ok: 0, error: 0, aborted: 0, inputTokens: 0, outputTokens: 0 },
    ]),
  );
  const byDatasource = new Map<string, { runs: number; failed: number }>();

  for (const row of rows) {
    if (row.status === "ok") ok += 1;
    else if (row.status === "error") error += 1;
    else if (row.status === "aborted") aborted += 1;
    else queuedOrRunning += 1;

    inputTokens += row.inputTokens ?? 0;
    outputTokens += row.outputTokens ?? 0;
    cacheReadTokens += row.cacheReadTokens ?? 0;
    cacheWriteTokens += row.cacheWriteTokens ?? 0;
    users.add(row.userId);

    if (row.startedAt !== null && row.endedAt !== null && row.endedAt >= row.startedAt) {
      durations.push(row.endedAt - row.startedAt);
    }

    const key = row.datasourceId ?? "unknown";
    const bucket = byDatasource.get(key) ?? { runs: 0, failed: 0 };
    bucket.runs += 1;
    if (row.status === "error" || row.status === "aborted") bucket.failed += 1;
    byDatasource.set(key, bucket);

    const date = utcDate(row.createdAt);
    const day = daily.get(date);
    if (day) {
      day.runs += 1;
      if (row.status === "ok") day.ok += 1;
      else if (row.status === "error") day.error += 1;
      else if (row.status === "aborted") day.aborted += 1;
      day.inputTokens += row.inputTokens ?? 0;
      day.outputTokens += row.outputTokens ?? 0;
    }
  }

  durations.sort((a, b) => a - b);
  const terminal = ok + error + aborted;

  const names = new Map(
    options.db
      .select({ id: datasources.id, name: datasources.name })
      .from(datasources)
      .all()
      .map((row) => [row.id, row.name]),
  );

  const datasourceStats = [...byDatasource.entries()]
    .map(([datasourceId, value]) => ({
      datasourceId,
      name: names.get(datasourceId) ?? "已删除的数据源",
      runs: value.runs,
      failed: value.failed,
    }))
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 8);

  const auditRows = options.db
    .select({ status: queryAudit.status, rowCount: queryAudit.rowCount })
    .from(queryAudit)
    .where(and(gte(queryAudit.createdAt, from), lt(queryAudit.createdAt, to + 1)))
    .all();

  let rejected = 0;
  let queryErrors = 0;
  let timeouts = 0;
  let rowTotal = 0;
  let rowSamples = 0;
  for (const row of auditRows) {
    if (row.status === "rejected") rejected += 1;
    else if (row.status === "error") queryErrors += 1;
    else if (row.status === "timeout") timeouts += 1;
    if (row.status === "ok" && row.rowCount !== null) {
      rowTotal += row.rowCount;
      rowSamples += 1;
    }
  }

  return {
    range: { days: options.days, from, to },
    totals: {
      runs: rows.length,
      ok,
      error,
      aborted,
      queuedOrRunning,
      successRate: terminal === 0 ? 0 : ok / terminal,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      activeUsers: users.size,
    },
    daily: [...daily.values()],
    datasources: datasourceStats,
    queries: {
      total: auditRows.length,
      rejected,
      error: queryErrors,
      timeout: timeouts,
      averageRows: rowSamples === 0 ? null : rowTotal / rowSamples,
    },
  };
}
