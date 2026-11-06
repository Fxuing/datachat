import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { queryAudit } from "../src/db/schema.js";
import { insertUser } from "../src/db/repositories/users.js";
import { hashPassword } from "../src/auth/password.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { recordAudit } from "../src/services/audit.js";
import { testConfig } from "./helpers/config.js";

const DS_A = "11111111-1111-4111-8111-111111111111";
const DS_B = "22222222-2222-4222-8222-222222222222";

let db: Db;
let adminId: string;
let aliceId: string;
let adminCookie: string;
let userCookie: string;

beforeEach(async () => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  adminId = randomUUID();
  aliceId = randomUUID();
  insertUser(db, {
    id: adminId,
    username: "root",
    passwordHash: await hashPassword("admin-pass"),
    role: "admin",
    createdAt: Date.now(),
  });
  insertUser(db, {
    id: aliceId,
    username: "alice",
    passwordHash: await hashPassword("alice-pass"),
    role: "user",
    createdAt: Date.now(),
  });
  const signer = createSessionSigner(testConfig.appSecret);
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });
  userCookie = await signer.sign({ sub: aliceId, username: "alice", role: "user" });
});

function app() {
  return buildApp({ config: testConfig, db, enableRateLimit: false });
}

interface SeedAudit {
  id?: string;
  userId?: string | null;
  datasourceId?: string | null;
  action?: "query" | "export" | "login" | "login_failed";
  status?: "ok" | "rejected" | "error" | "timeout";
  sql?: string;
  createdAt: number;
  detail?: Record<string, unknown> | null;
  errorMessage?: string | null;
}

function seedAudit(overrides: SeedAudit): string {
  const id = overrides.id ?? randomUUID();
  db.insert(queryAudit)
    .values({
      id,
      userId: overrides.userId === undefined ? aliceId : overrides.userId,
      datasourceId: overrides.datasourceId === undefined ? DS_A : overrides.datasourceId,
      action: overrides.action ?? "query",
      sqlText: overrides.sql ?? "select 1",
      sqlHash: "hash",
      status: overrides.status ?? "ok",
      errorMessage: overrides.errorMessage ?? null,
      detailJson: overrides.detail ? JSON.stringify(overrides.detail) : null,
      createdAt: overrides.createdAt,
    })
    .run();
  return id;
}

async function getAudit(url: string, cookie = adminCookie) {
  const a = await app();
  try {
    const response = await a.inject({
      method: "GET",
      url,
      cookies: cookie ? { dc_session: cookie } : {},
    });
    return { statusCode: response.statusCode, body: response.json() };
  } finally {
    await a.close();
  }
}

describe("GET /api/admin/audit", () => {
  it("is admin-only", async () => {
    const denied = await getAudit("/api/admin/audit", userCookie);
    expect(denied.statusCode).toBe(403);

    const anonymous = await getAudit("/api/admin/audit", "");
    expect(anonymous.statusCode).toBe(401);
  });

  it("combines filters and reports the filtered total", async () => {
    const now = 1_760_000_000_000;
    seedAudit({ action: "query", status: "ok", createdAt: now - 3_000 });
    seedAudit({ action: "query", status: "error", createdAt: now - 2_000 });
    seedAudit({ action: "export", status: "error", createdAt: now - 1_000 });
    seedAudit({ action: "query", status: "error", datasourceId: DS_B, createdAt: now - 500 });
    seedAudit({ action: "query", status: "error", userId: adminId, createdAt: now - 100 });

    const { statusCode, body } = await getAudit(
      `/api/admin/audit?action=query&status=error&datasourceId=${DS_A}`,
    );
    expect(statusCode).toBe(200);
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item: { action: string }) => item.action === "query")).toBe(true);
    expect(body.items.every((item: { status: string }) => item.status === "error")).toBe(true);
    expect(body.items.every((item: { datasourceId: string }) => item.datasourceId === DS_A)).toBe(
      true,
    );
  });

  it("filters by user and time range (epoch ms or ISO)", async () => {
    const base = Date.parse("2026-11-01T00:00:00.000Z");
    seedAudit({ userId: aliceId, createdAt: base, sql: "select 'alice-early'" });
    seedAudit({ userId: aliceId, createdAt: base + 60_000, sql: "select 'alice-late'" });
    seedAudit({ userId: adminId, createdAt: base + 60_000, sql: "select 'admin-late'" });

    const ms = await getAudit(
      `/api/admin/audit?userId=${aliceId}&from=${base + 1}&to=${base + 120_000}`,
    );
    expect(ms.statusCode).toBe(200);
    expect(ms.body.total).toBe(1);
    expect(ms.body.items[0].userId).toBe(aliceId);
    expect(ms.body.items[0].sqlText).toBe("select 'alice-late'");

    const iso = await getAudit(
      `/api/admin/audit?from=${encodeURIComponent("2026-11-01T00:00:30.000Z")}&to=${encodeURIComponent("2026-11-01T00:02:00.000Z")}`,
    );
    expect(iso.statusCode).toBe(200);
    expect(iso.body.total).toBe(2);
    // Both rows share the same created_at, so the id tiebreaker decides order.
    expect(
      [...iso.body.items.map((item: { userId: string }) => item.userId)].sort(),
    ).toEqual([adminId, aliceId].sort());
  });

  it("paginates newest-first with the id tiebreaker", async () => {
    const createdAt = 1_760_000_000_000;
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000005",
    ];
    for (const id of ids) seedAudit({ id, createdAt, sql: `select '${id.slice(-1)}'` });

    const first = await getAudit("/api/admin/audit?limit=2");
    expect(first.body.total).toBe(5);
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual([
      ids[4],
      ids[3],
    ]);

    const second = await getAudit("/api/admin/audit?limit=2&offset=2");
    expect(second.body.total).toBe(5);
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual([
      ids[2],
      ids[1],
    ]);

    const last = await getAudit("/api/admin/audit?limit=2&offset=4");
    expect(last.body.items.map((item: { id: string }) => item.id)).toEqual([ids[0]]);
  });

  it("parses detail JSON and omits secrets from stored errors", async () => {
    const createdAt = Date.now();
    seedAudit({
      createdAt,
      detail: { ip: "10.0.0.7", username: "alice" },
    });
    seedAudit({ createdAt: createdAt + 1, detail: null });
    recordAudit(db, {
      runId: null,
      conversationId: null,
      userId: aliceId,
      datasourceId: DS_A,
      action: "query",
      sqlText: "select 1",
      status: "error",
      errorMessage: "Access denied for mysql://root:supersecret@localhost:3306/app",
    });

    const { body } = await getAudit("/api/admin/audit?limit=10");
    expect(body.total).toBe(3);
    const empty = body.items.find((item: { detailJson: unknown }) => item.detailJson === null);
    expect(empty).toBeDefined();
    const withDetail = body.items.find(
      (item: { detailJson: { ip?: string } | null }) => item.detailJson?.ip === "10.0.0.7",
    );
    expect(withDetail.detailJson).toMatchObject({ ip: "10.0.0.7", username: "alice" });
    expect(JSON.stringify(body)).not.toContain("supersecret");
    expect(JSON.stringify(body)).toContain("***@");
  });

  it("rejects invalid filters", async () => {
    const badLimit = await getAudit("/api/admin/audit?limit=201");
    expect(badLimit.statusCode).toBe(400);

    const badAction = await getAudit("/api/admin/audit?action=drop");
    expect(badAction.statusCode).toBe(400);

    const badBoundary = await getAudit("/api/admin/audit?from=yesterday");
    expect(badBoundary.statusCode).toBe(400);

    const reversed = await getAudit("/api/admin/audit?from=2000&to=1000");
    expect(reversed.statusCode).toBe(400);
  });
});
