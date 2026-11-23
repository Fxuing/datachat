import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { eq } from "drizzle-orm";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { insertUser } from "../src/db/repositories/users.js";
import { dashboardCards, dashboards, datasources, runEvents } from "../src/db/schema.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { recordAudit } from "../src/services/audit.js";
import { sweepDueDashboards } from "../src/services/dashboards.js";
import { testConfig } from "./helpers/config.js";

let tmpDir: string;
let db: Db;
let closeDb: () => void;
let app: Awaited<ReturnType<typeof buildApp>>;
let store: ArtifactStore;
let ownerCookie: string;
let otherCookie: string;
let ownerId: string;
let datasourceId: string;
let conversationId: string;
let fakeRows: Array<[string, number]>;
let lastExecutedSql = "";
let fakeFields: Array<{ name: string }> = [{ name: "region" }, { name: "total" }];
let fakePoolsRef: PoolRegistry;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-dashboards-test-"));
  const handle = createDb(path.join(tmpDir, "app.db"));
  db = handle.db;
  closeDb = () => handle.sqlite.close();
  migrateDb(db);

  const hash = await hashPassword("secret");
  const now = Date.now();
  const owner = insertUser(db, {
    id: randomUUID(),
    username: "alice",
    passwordHash: hash,
    role: "user",
    createdAt: now,
  });
  const other = insertUser(db, {
    id: randomUUID(),
    username: "bob",
    passwordHash: hash,
    role: "user",
    createdAt: now,
  });
  ownerId = owner.id;

  datasourceId = randomUUID();
  insertDatasource(db, {
    id: datasourceId,
    name: "分析主库",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "analytics",
    username: "ro",
    passwordCipher: encryptSecret("pw", deriveSecretKey(testConfig.appSecret)),
    sslMode: "disable",
    readOnlyVerified: 1,
    createdBy: owner.id,
    createdAt: now,
    updatedAt: now,
  });
  replaceGrants(db, datasourceId, [owner.id]);

  const conv = createConversation(db, {
    userId: owner.id,
    datasourceId,
    title: "销售分析",
  });
  conversationId = conv.id;

  store = new ArtifactStore(db, path.join(tmpDir, "artifacts"));
  await store.init();

  fakeRows = [
    ["华东", 500],
    ["华北", 800],
  ];
  fakeFields = [{ name: "region" }, { name: "total" }];
  lastExecutedSql = "";
  const fakeMysqlPool = {
    async getConnection() {
      return {
        query(input: unknown) {
          if (typeof input === "string") return Promise.resolve([{}, []]);
          if (input && typeof input === "object" && "sql" in input) {
            lastExecutedSql = String((input as { sql: unknown }).sql);
          }
          const listeners = new Map<string, (value: unknown) => void>();
          return {
            on(event: string, listener: (value: unknown) => void) {
              listeners.set(event, listener);
              return this;
            },
            stream() {
              listeners.get("fields")?.(fakeFields);
              return (async function* rows() {
                for (const row of fakeRows) {
                  yield row;
                }
              })();
            },
          };
        },
        destroy() {},
        release() {},
      };
    },
  };
  const fakePools = {
    get: vi.fn(() => ({ mysql: fakeMysqlPool })),
    invalidate: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
  } as unknown as PoolRegistry;
  fakePoolsRef = fakePools;

  const signer = createSessionSigner(testConfig.appSecret);
  ownerCookie = await signer.sign({ sub: owner.id, username: owner.username, role: owner.role });
  otherCookie = await signer.sign({ sub: other.id, username: other.username, role: other.role });

  app = await buildApp({
    config: { ...testConfig, dataDir: tmpDir },
    db,
    enableRateLimit: false,
    artifacts: store,
    pools: fakePools,
  });
});

afterEach(async () => {
  await app?.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("dashboards api", () => {
  it("pins a chart artifact, refreshes via guarded SQL, and fails closed when grant is revoked", async () => {
    const runId = randomUUID();
    recordAudit(db, {
      runId,
      conversationId,
      userId: ownerId,
      datasourceId,
      action: "query",
      sqlText: "SELECT region, SUM(amount) AS total FROM orders GROUP BY region",
      status: "ok",
    });

    const chart = store.createChart({
      conversationId,
      userId: ownerId,
      runId,
      columns: [
        { name: "region", type: "string" },
        { name: "total", type: "number" },
      ],
      rowCount: 2,
      spec: {
        chart: { type: "bar", x: "region", y: "total", aggregate: "sum", title: "区域销售" },
        option: {
          xAxis: { type: "category", data: ["华东", "华北"] },
          yAxis: { type: "value" },
          series: [{ type: "bar", name: "区域销售", data: [100, 200] }],
        },
      },
    });

    // Create dashboard.
    const createRes = await app.inject({
      method: "POST",
      url: "/api/dashboards",
      cookies: { dc_session: ownerCookie },
      payload: { name: "经营驾驶舱", description: "核心营收指标" },
    });
    expect(createRes.statusCode).toBe(201);
    const dashboardId = (createRes.json() as { dashboard: { id: string } }).dashboard.id;

    // Foreign user cannot access or pin to owner's dashboard.
    const foreignGet = await app.inject({
      method: "GET",
      url: `/api/dashboards/${dashboardId}`,
      cookies: { dc_session: otherCookie },
    });
    expect(foreignGet.statusCode).toBe(404);

    // Pin chart artifact.
    const pinRes = await app.inject({
      method: "POST",
      url: `/api/dashboards/${dashboardId}/cards/from-artifact`,
      cookies: { dc_session: ownerCookie },
      payload: { artifactId: chart.id, title: "区域 GMV", width: 2 },
    });
    expect(pinRes.statusCode).toBe(201);
    const card = (
      pinRes.json() as {
        card: { id: string; title: string; width: number; refreshable: boolean; datasourceName: string };
      }
    ).card;
    expect(card.title).toBe("区域 GMV");
    expect(card.width).toBe(2);
    expect(card.refreshable).toBe(true);
    expect(card.datasourceName).toBe("分析主库");

    // Refresh card re-runs SQL via runGuardedQuery and updates chart values to 800 / 500.
    const refreshRes = await app.inject({
      method: "POST",
      url: `/api/dashboards/${dashboardId}/cards/${card.id}/refresh`,
      cookies: { dc_session: ownerCookie },
    });
    expect(refreshRes.statusCode).toBe(200);
    const refreshedCard = (
      refreshRes.json() as {
        card: { spec: { option: { series: Array<{ data: number[] }> } }; lastError: string | null };
      }
    ).card;
    expect(refreshedCard.lastError).toBeNull();
    expect(refreshedCard.spec.option.series[0]?.data).toEqual([800, 500]);

    // Revoking datasource grant must fail closed on refresh while preserving last good spec.
    replaceGrants(db, datasourceId, []);
    const deniedRefresh = await app.inject({
      method: "POST",
      url: `/api/dashboards/${dashboardId}/cards/${card.id}/refresh`,
      cookies: { dc_session: ownerCookie },
    });
    expect(deniedRefresh.statusCode).toBe(403);
    const deniedBody = deniedRefresh.json() as {
      card: { lastError: string; spec: { option: { series: Array<{ data: number[] }> } } };
    };
    expect(deniedBody.card.lastError).toContain("无权");
    expect(deniedBody.card.spec.option.series[0]?.data).toEqual([800, 500]);

    // Delete card & dashboard.
    const delCard = await app.inject({
      method: "DELETE",
      url: `/api/dashboards/${dashboardId}/cards/${card.id}`,
      cookies: { dc_session: ownerCookie },
    });
    expect(delCard.statusCode).toBe(204);

    const delDash = await app.inject({
      method: "DELETE",
      url: `/api/dashboards/${dashboardId}`,
      cookies: { dc_session: ownerCookie },
    });
    expect(delDash.statusCode).toBe(204);
  });

  it("matches the exact query for a chart in a multi-query run and self-heals stale pinned SQL", async () => {
    const createDash = await app.inject({
      method: "POST",
      url: "/api/dashboards",
      cookies: { dc_session: ownerCookie },
      payload: { name: "多查询看板" },
    });
    const dashboardId = (createDash.json() as { dashboard: { id: string } }).dashboard.id;

    const runId = randomUUID();
    const monthlySql = "SELECT ym, gmv FROM monthly_orders LIMIT 100";
    const dailySql = "SELECT d, paid_orders, gmv FROM daily_orders LIMIT 100";

    const writerMonthly = store.openResult({ userId: ownerId, conversationId, runId });
    await writerMonthly.write(["2026-01", 1000]);
    const monthlyResult = await writerMonthly.finish({
      columns: [
        { name: "ym", type: "string" },
        { name: "gmv", type: "number" },
      ],
      rowCount: 1,
      truncated: false,
    });

    const writerDaily = store.openResult({ userId: ownerId, conversationId, runId });
    await writerDaily.write(["2026-01-01", 10, 500]);
    const dailyResult = await writerDaily.finish({
      columns: [
        { name: "d", type: "string" },
        { name: "paid_orders", type: "number" },
        { name: "gmv", type: "number" },
      ],
      rowCount: 1,
      truncated: false,
    });

    // Record legacy-style audit rows (no detail.artifactId) with dailySql LAST, plus run_events result events.
    recordAudit(db, {
      runId,
      conversationId,
      userId: ownerId,
      datasourceId,
      action: "query",
      sqlText: monthlySql,
      status: "ok",
      rowCount: 1,
    });
    recordAudit(db, {
      runId,
      conversationId,
      userId: ownerId,
      datasourceId,
      action: "query",
      sqlText: dailySql,
      status: "ok",
      rowCount: 1,
    });

    const now = Date.now();
    db.insert(runEvents)
      .values([
        {
          id: randomUUID(),
          runId,
          conversationId,
          seq: 1,
          type: "result",
          payloadJson: JSON.stringify({ artifactId: monthlyResult.id, sql: monthlySql }),
          createdAt: now,
        },
        {
          id: randomUUID(),
          runId,
          conversationId,
          seq: 2,
          type: "result",
          payloadJson: JSON.stringify({ artifactId: dailyResult.id, sql: dailySql }),
          createdAt: now + 1,
        },
      ])
      .run();

    const monthlyChart = store.createChart({
      conversationId,
      userId: ownerId,
      runId,
      columns: [
        { name: "ym", type: "string" },
        { name: "gmv", type: "number" },
      ],
      rowCount: 1,
      spec: {
        sourceArtifactId: monthlyResult.id,
        chart: { type: "bar", x: "ym", y: "gmv", title: "月度 GMV" },
        option: {
          xAxis: { type: "category", data: ["2026-01"] },
          yAxis: { type: "value" },
          series: [{ type: "bar", data: [1000] }],
        },
      },
    });

    const pinRes = await app.inject({
      method: "POST",
      url: `/api/dashboards/${dashboardId}/cards/from-artifact`,
      cookies: { dc_session: ownerCookie },
      payload: { artifactId: monthlyChart.id },
    });
    expect(pinRes.statusCode).toBe(201);
    const cardId = (pinRes.json() as { card: { id: string } }).card.id;

    // Simulate a card pinned BEFORE this fix that mistakenly stored dailySql.
    db.update(dashboardCards)
      .set({ sqlText: dailySql })
      .where(eq(dashboardCards.id, cardId))
      .run();

    fakeFields = [{ name: "ym" }, { name: "gmv" }];
    fakeRows = [
      ["2026-01", 1200],
      ["2026-02", 1500],
    ];

    const refreshRes = await app.inject({
      method: "POST",
      url: `/api/dashboards/${dashboardId}/cards/${cardId}/refresh`,
      cookies: { dc_session: ownerCookie },
    });
    expect(refreshRes.statusCode).toBe(200);
    expect(lastExecutedSql).toContain("monthly_orders");
    const saved = db
      .select({ sqlText: dashboardCards.sqlText })
      .from(dashboardCards)
      .where(eq(dashboardCards.id, cardId))
      .get();
    expect(saved?.sqlText).toBe(monthlySql);
  });

  it("supports dashboard public sharing (with scope guard), scheduled auto-refresh, and guarded card SQL editing", async () => {
    const runId = randomUUID();
    recordAudit(db, {
      runId,
      conversationId,
      userId: ownerId,
      datasourceId,
      action: "query",
      sqlText: "SELECT region, SUM(amount) AS total FROM orders GROUP BY region LIMIT 50",
      status: "ok",
    });
    const chart = store.createChart({
      conversationId,
      userId: ownerId,
      runId,
      columns: [
        { name: "region", type: "string" },
        { name: "total", type: "number" },
      ],
      rowCount: 2,
      spec: {
        chart: { type: "bar", x: "region", y: "total", title: "区域销售" },
        option: {
          xAxis: { type: "category", data: ["华东", "华北"] },
          yAxis: { type: "value" },
          series: [{ type: "bar", data: [100, 200] }],
        },
      },
    });

    const createDash = await app.inject({
      method: "POST",
      url: "/api/dashboards",
      cookies: { dc_session: ownerCookie },
      payload: { name: "经营驾驶舱" },
    });
    const dashboardId = (createDash.json() as { dashboard: { id: string } }).dashboard.id;

    const pinRes = await app.inject({
      method: "POST",
      url: `/api/dashboards/${dashboardId}/cards/from-artifact`,
      cookies: { dc_session: ownerCookie },
      payload: { artifactId: chart.id },
    });
    expect(pinRes.statusCode).toBe(201);
    const cardId = (pinRes.json() as { card: { id: string; sqlText: string } }).card.id;

    // 1. Card SQL edit: rejects unsafe write SQL and accepts valid read-only SELECT.
    const unsafeSql = await app.inject({
      method: "PATCH",
      url: `/api/dashboards/${dashboardId}/cards/${cardId}`,
      cookies: { dc_session: ownerCookie },
      payload: { sqlText: "DELETE FROM orders" },
    });
    expect(unsafeSql.statusCode).toBe(400);
    expect((unsafeSql.json() as { error: { code: string } }).error.code).toBe("INVALID_SQL");

    const updatedSql = "SELECT region, SUM(amount) AS total FROM orders WHERE status = 'paid' GROUP BY region LIMIT 20";
    const okSql = await app.inject({
      method: "PATCH",
      url: `/api/dashboards/${dashboardId}/cards/${cardId}`,
      cookies: { dc_session: ownerCookie },
      payload: { sqlText: updatedSql },
    });
    expect(okSql.statusCode).toBe(200);
    expect((okSql.json() as { card: { sqlText: string } }).card.sqlText).toBe(updatedSql);

    // 2. Scheduled auto-refresh: configure cron, simulate due timestamp, and run sweepDueDashboards.
    const schedRes = await app.inject({
      method: "PATCH",
      url: `/api/dashboards/${dashboardId}`,
      cookies: { dc_session: ownerCookie },
      payload: { refreshCron: "0 8 * * *", refreshTimezone: "Asia/Shanghai" },
    });
    expect(schedRes.statusCode).toBe(200);
    const scheduled = (
      schedRes.json() as { dashboard: { refreshCron: string; nextRefreshAt: number | null } }
    ).dashboard;
    expect(scheduled.refreshCron).toBe("0 8 * * *");
    expect(scheduled.nextRefreshAt).toBeTypeOf("number");

    const now = Date.now();
    db.update(dashboards)
      .set({ nextRefreshAt: now - 1000 })
      .where(eq(dashboards.id, dashboardId))
      .run();

    fakeFields = [{ name: "region" }, { name: "total" }];
    fakeRows = [
      ["华东", 999],
      ["华南", 444],
    ];
    const sweep = await sweepDueDashboards(
      { db, config: { ...testConfig, dataDir: tmpDir }, pools: fakePoolsRef, artifacts: store },
      now,
    );
    expect(sweep).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(lastExecutedSql).toContain("status = 'paid'");

    // 3. Public dashboard sharing: creates public link without leaking SQL, and fails closed when scope is enabled.
    const shareRes = await app.inject({
      method: "POST",
      url: "/api/shares",
      cookies: { dc_session: ownerCookie },
      payload: { dashboardId, expiresInDays: 7 },
    });
    expect(shareRes.statusCode).toBe(201);
    const { token } = (shareRes.json() as { share: { token: string } }).share;

    const pubRes = await app.inject({
      method: "GET",
      url: `/api/public/shares/${token}`,
    });
    expect(pubRes.statusCode).toBe(200);
    const pubJson = pubRes.json() as {
      type: string;
      title: string;
      cards: Array<{ title: string; sqlText?: string }>;
    };
    expect(pubJson.type).toBe("dashboard");
    expect(pubJson.title).toBe("经营驾驶舱");
    expect(pubJson.cards).toHaveLength(1);
    expect(pubJson.cards[0]?.sqlText).toBeUndefined();

    // Once datasource enables data scope, existing dashboard share is immediately refused.
    db.update(datasources)
      .set({ dataScopeMode: "enabled" })
      .where(eq(datasources.id, datasourceId))
      .run();
    const blockedPub = await app.inject({
      method: "GET",
      url: `/api/public/shares/${token}`,
    });
    expect(blockedPub.statusCode).toBe(410);
    expect((blockedPub.json() as { error: { code: string } }).error.code).toBe(
      "SHARE_DISABLED_BY_SCOPE",
    );
  });
});
