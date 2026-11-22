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
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { insertUser } from "../src/db/repositories/users.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { recordAudit } from "../src/services/audit.js";
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
  const fakeMysqlPool = {
    async getConnection() {
      return {
        query(input: unknown) {
          if (typeof input === "string") return Promise.resolve([{}, []]);
          const listeners = new Map<string, (value: unknown) => void>();
          return {
            on(event: string, listener: (value: unknown) => void) {
              listeners.set(event, listener);
              return this;
            },
            stream() {
              listeners.get("fields")?.([{ name: "region" }, { name: "total" }]);
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
});
