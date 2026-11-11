import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  conversations,
  datasources,
  queryAudit,
  runs,
} from "../src/db/schema.js";
import { getOpsMetrics } from "../src/services/ops-metrics.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 12);

function setup() {
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  const db = handle.db;

  const userId = randomUUID();
  const dsId = randomUUID();
  const now = NOW - 2 * DAY;
  db.insert(datasources)
    .values({
      id: dsId,
      name: "biz",
      type: "mysql",
      host: "127.0.0.1",
      port: 3306,
      database: "biz",
      username: "u",
      passwordCipher: "cipher",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const conversationId = randomUUID();
  db.insert(conversations)
    .values({
      id: conversationId,
      userId,
      datasourceId: dsId,
      title: "c",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const base = {
    conversationId,
    userId,
    modelId: "m",
  };
  const ok = randomUUID();
  const failed = randomUUID();
  const aborted = randomUUID();
  db.insert(runs)
    .values([
      {
        ...base,
        id: ok,
        status: "ok",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
        createdAt: now,
        startedAt: now,
        endedAt: now + 1000,
      },
      {
        ...base,
        id: failed,
        status: "error",
        createdAt: now + 1000,
        startedAt: now + 1000,
        endedAt: now + 4000,
        error: "boom",
      },
      {
        ...base,
        id: aborted,
        status: "aborted",
        createdAt: NOW,
      },
    ])
    .run();

  const audits = [
    { status: "ok" as const, rowCount: 10 },
    { status: "ok" as const, rowCount: 20 },
    { status: "rejected" as const, rowCount: null },
    { status: "error" as const, rowCount: null },
    { status: "timeout" as const, rowCount: null },
  ];
  db.insert(queryAudit)
    .values(
      audits.map((item) => ({
        id: randomUUID(),
        userId,
        datasourceId: dsId,
        sqlText: "select 1",
        sqlHash: "hash",
        action: "query" as const,
        status: item.status,
        rowCount: item.rowCount,
        durationMs: 1,
        createdAt: now,
      })),
    )
    .run();

  return { db, dsId, sqlite: handle.sqlite };
}

describe("ops metrics", () => {
  it("aggregates runs, tokens, durations and queries", () => {
    const { db, dsId } = setup();
    const metrics = getOpsMetrics({ db, days: 7, now: () => NOW });

    expect(metrics.range).toEqual({ days: 7, from: NOW - 7 * DAY, to: NOW });
    expect(metrics.totals).toMatchObject({
      runs: 3,
      ok: 1,
      error: 1,
      aborted: 1,
      queuedOrRunning: 0,
      successRate: 1 / 3,
      p50Ms: 1000,
      p95Ms: 3000,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      activeUsers: 1,
    });
    expect(metrics.daily).toHaveLength(8);
    expect(metrics.daily.find((day) => day.date === "2026-11-09")).toMatchObject({
      runs: 2,
      ok: 1,
      error: 1,
    });
    expect(metrics.datasources).toEqual([
      { datasourceId: dsId, name: "biz", runs: 3, failed: 2 },
    ]);
    expect(metrics.queries).toEqual({
      total: 5,
      rejected: 1,
      error: 1,
      timeout: 1,
      averageRows: 15,
    });
  });

  it("handles an empty range", () => {
    const handle = createDb(":memory:");
    migrateDb(handle.db);
    const metrics = getOpsMetrics({ db: handle.db, days: 7, now: () => NOW });
    expect(metrics.totals.successRate).toBe(0);
    expect(metrics.totals.p50Ms).toBe(0);
    expect(metrics.queries.averageRows).toBeNull();
    expect(metrics.datasources).toEqual([]);
  });

  it("falls back to a deleted datasource label", () => {
    const { db, dsId, sqlite } = setup();
    sqlite.pragma("foreign_keys = OFF");
    db.update(conversations)
      .set({ datasourceId: "missing-datasource" })
      .where(eq(conversations.datasourceId, dsId))
      .run();
    sqlite.pragma("foreign_keys = ON");
    const metrics = getOpsMetrics({ db, days: 7, now: () => NOW });
    expect(metrics.datasources[0]?.name).toBe("已删除的数据源");
  });
});
