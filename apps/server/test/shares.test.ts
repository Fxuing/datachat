import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { appendRunEvent } from "../src/db/repositories/run-events.js";
import { insertUser } from "../src/db/repositories/users.js";
import { reports, shares } from "../src/db/schema.js";
import { RunEventBus } from "../src/agent/event-bus.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import { ArtifactStore, type ColumnInfo } from "../src/services/artifacts.js";
import { createReport } from "../src/services/reports.js";
import {
  createShare,
  hashShareToken,
  resolveShare,
  revokeShare,
  SHARE_MAX_ROWS,
} from "../src/services/shares.js";
import { testConfig } from "./helpers/config.js";

const DAY_MS = 86_400_000;
const columns: ColumnInfo[] = [
  { name: "id", type: "number" },
  { name: "name", type: "string" },
];

let root: string;
let db: Db;
let store: ArtifactStore;
let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
let otherUserId: string;
let adminId: string;
let cookie: string;
let otherCookie: string;
let adminCookie: string;
let conversationId: string;

const fakeRuntime = {
  bus: new RunEventBus(),
  abort: vi.fn(() => true),
  remove: vi.fn(async () => undefined),
  isBusy: vi.fn(() => false),
  shutdown: vi.fn(async () => undefined),
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-shares-"));
  db = createDb(":memory:").db;
  migrateDb(db);

  const signer = createSessionSigner(testConfig.appSecret);
  userId = randomUUID();
  otherUserId = randomUUID();
  adminId = randomUUID();
  for (const [id, username, role] of [
    [userId, "alice", "user"],
    [otherUserId, "bob", "user"],
    [adminId, "root", "admin"],
  ] as const) {
    insertUser(db, {
      id,
      username,
      passwordHash: await hashPassword(`${username}-pass-123`),
      role,
      createdAt: Date.now(),
    });
  }
  cookie = await signer.sign({ sub: userId, username: "alice", role: "user" });
  otherCookie = await signer.sign({ sub: otherUserId, username: "bob", role: "user" });
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });

  const datasourceId = randomUUID();
  insertDatasource(db, {
    id: datasourceId,
    name: "demo",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "demo",
    username: "demo",
    passwordCipher: "cipher",
    createdBy: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  conversationId = createConversation(db, { userId, datasourceId, title: "销售分析" }).id;

  store = new ArtifactStore(db, path.join(root, "artifacts"));
  await store.init();
  app = await buildApp({
    config: {
      ...testConfig,
      dataDir: root,
      agentAuthPath: path.join(root, "agent", "auth.json"),
    },
    db,
    enableRateLimit: false,
    agentRuntime: fakeRuntime as unknown as RuntimeManager,
    artifacts: store,
  });
});

afterEach(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function seedResult(rows: unknown[][], runId = "run-1"): Promise<string> {
  const writer = store.openResult({ userId, conversationId, runId });
  for (const row of rows) await writer.write(row);
  const meta = await writer.finish({ columns, rowCount: rows.length, truncated: false });
  return meta.id;
}

function seedConversation(runId: string, rows: unknown[][] = [[1, "alpha"]]): void {
  appendRunEvent(db, { runId, conversationId, type: "user_message", payload: { content: "有多少客户？" } });
  appendRunEvent(db, {
    runId,
    conversationId,
    type: "text_delta",
    payload: { text: "正在查询" },
  });
  appendRunEvent(db, {
    runId,
    conversationId,
    type: "sql",
    payload: { sql: "select id, name from customers", auditId: randomUUID(), status: "ok" },
  });
  appendRunEvent(db, {
    runId,
    conversationId,
    type: "result",
    payload: {
      artifactId: randomUUID(),
      columns,
      rows,
      rowCount: rows.length,
      truncated: false,
    },
  });
  appendRunEvent(db, {
    runId,
    conversationId,
    type: "chart",
    payload: {
      chartArtifactId: randomUUID(),
      spec: { chart: { type: "bar", title: "客户数" }, series: [{ type: "bar", data: [1] }] },
      points: 1,
      title: "客户数",
    },
  });
  appendRunEvent(db, {
    runId,
    conversationId,
    type: "assistant_message",
    payload: { content: "共 1 位客户。" },
  });
}

describe("shares service", () => {
  it("stores only the token hash and returns the plaintext once", () => {
    const now = 1_700_000_000_000;
    const result = createShare({ db, userId, conversationId, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.share.url).toBe(`/s/${result.share.token}`);
    expect(result.share.expiresAt).toBe(now + 7 * DAY_MS);
    expect(result.share.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = db.select().from(shares).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashShareToken(result.share.token));
    expect(rows[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(result.share.token);
  });

  it("requires exactly one target and a 1-365 day expiry", () => {
    expect(createShare({ db, userId }).ok).toBe(false);
    expect(
      createShare({ db, userId, conversationId, reportId: randomUUID() }).ok,
    ).toBe(false);
    expect(createShare({ db, userId, conversationId, expiresInDays: 0 }).ok).toBe(false);
    expect(createShare({ db, userId, conversationId, expiresInDays: 366 }).ok).toBe(false);
    expect(createShare({ db, userId, conversationId, expiresInDays: 365 }).ok).toBe(true);
  });

  it("rejects unknown and foreign targets with NOT_FOUND", () => {
    const missing = createShare({ db, userId, conversationId: randomUUID() });
    expect(missing).toMatchObject({ ok: false, code: "NOT_FOUND" });

    const foreign = createShare({ db, userId: otherUserId, conversationId });
    expect(foreign).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("resolves active links and reports expiry through the clock seam", async () => {
    const now = 1_700_000_000_000;
    const created = createShare({ db, userId, conversationId, expiresInDays: 1, now });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const before = await resolveShare({
      db,
      artifacts: store,
      token: created.share.token,
      now: () => now + DAY_MS - 1,
    });
    expect(before.ok).toBe(true);

    const after = await resolveShare({
      db,
      artifacts: store,
      token: created.share.token,
      now: () => now + DAY_MS,
    });
    expect(after).toMatchObject({ ok: false, code: "SHARE_GONE" });
  });

  it("revokes as owner or admin, and hides foreign or unknown shares", async () => {
    const created = createShare({ db, userId, conversationId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(
      revokeShare({ db, shareId: created.share.id, userId: otherUserId, role: "user" }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(
      revokeShare({ db, shareId: randomUUID(), userId, role: "user" }),
    ).toMatchObject({ ok: false, code: "NOT_FOUND" });

    expect(revokeShare({ db, shareId: created.share.id, userId: adminId, role: "admin" }).ok).toBe(
      true,
    );
    const resolved = await resolveShare({ db, artifacts: store, token: created.share.token });
    expect(resolved).toMatchObject({ ok: false, code: "SHARE_GONE" });
  });

  it("builds a whitelisted conversation transcript with truncated rows", async () => {
    const rows = Array.from({ length: 120 }, (_, index) => [index, `name-${index}`]);
    seedConversation("run-1", rows);

    const created = createShare({ db, userId, conversationId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const resolved = await resolveShare({ db, artifacts: store, token: created.share.token });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.share.type).toBe("conversation");
    if (resolved.share.type !== "conversation") return;
    expect(Object.keys(resolved.share).sort()).toEqual([
      "createdAt",
      "messages",
      "title",
      "type",
    ]);
    expect(resolved.share.title).toBe("销售分析");

    const allowedKeys = new Set(["role", "text", "sql", "columns", "rows", "chart"]);
    for (const message of resolved.share.messages) {
      for (const key of Object.keys(message)) expect(allowedKeys.has(key)).toBe(true);
    }

    expect(resolved.share.messages[0]).toEqual({ role: "user", text: "有多少客户？" });
    const resultMessage = resolved.share.messages.find((message) => message.rows !== undefined);
    expect(resultMessage?.rows).toHaveLength(SHARE_MAX_ROWS);
    expect(resultMessage?.rows?.[0]).toEqual([0, "name-0"]);
    expect(resolved.share.messages.some((message) => message.chart !== undefined)).toBe(true);
    expect(resolved.share.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "共 1 位客户。",
      sql: "select id, name from customers",
    });

    const serialized = JSON.stringify(resolved.share);
    for (const forbidden of ["runId", "auditId", "datasourceId", "storagePath", "host"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("strips inline excel placeholders from conversation shares and skips excel artifacts in report shares", async () => {
    const excelId = randomUUID();
    const resultId = await seedResult([[1, "alpha"]]);
    const report = createReport({
      db,
      artifacts: store,
      userId,
      conversationId,
      artifactIds: [resultId],
      title: "客户报告",
      markdown: "报告正文",
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const excel = store.createExcel({
      conversationId,
      userId,
      runId: "run-excel",
      spec: {
        filename: "导出表",
        sheets: [{ name: "Sheet1", artifactId: resultId, rowCount: 1 }],
        totalRows: 1,
      },
      rowCount: 1,
    });

    appendRunEvent(db, {
      runId: "run-excel",
      conversationId,
      type: "user_message",
      payload: { content: "导出 excel" },
    });
    appendRunEvent(db, {
      runId: "run-excel",
      conversationId,
      type: "assistant_message",
      payload: {
        content: `已生成工作簿与报告。\n\n[[excel:${excelId}]]\n\n[[report:${report.report.id}]]\n\n请下载。`,
      },
    });

    const convShare = createShare({ db, userId, conversationId });
    expect(convShare.ok).toBe(true);
    if (!convShare.ok) return;
    const resolvedConv = await resolveShare({
      db,
      artifacts: store,
      token: convShare.share.token,
    });
    expect(resolvedConv.ok).toBe(true);
    if (!resolvedConv.ok || resolvedConv.share.type !== "conversation") return;
    const last = resolvedConv.share.messages.at(-1);
    expect(last?.text).toBe("已生成工作簿与报告。\n\n请下载。");
    expect(last?.text).not.toContain("[[excel:");
    expect(last?.text).not.toContain("[[report:");

    // Also verify buildReportShare safely skips an excel artifact id if stored in a legacy report row
    db.update(reports)
      .set({ artifactIdsJson: JSON.stringify([resultId, excel.id]) })
      .where(eq(reports.id, report.report.id))
      .run();
    const repShare = createShare({ db, userId, reportId: report.report.id });
    expect(repShare.ok).toBe(true);
    if (!repShare.ok) return;
    const resolvedRep = await resolveShare({ db, artifacts: store, token: repShare.share.token });
    expect(resolvedRep.ok).toBe(true);
    if (!resolvedRep.ok || resolvedRep.share.type !== "report") return;
    expect(resolvedRep.share.artifacts.map((a) => a.id)).toEqual([resultId]);
  });

  it("builds a whitelisted report payload with at most 100 artifact rows", async () => {
    const rows = Array.from({ length: 150 }, (_, index) => [index, `name-${index}`]);
    const artifactId = await seedResult(rows);
    const report = createReport({
      db,
      artifacts: store,
      userId,
      conversationId,
      artifactIds: [artifactId],
      title: "客户报告",
      markdown: "报告正文",
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;

    const created = createShare({ db, userId, reportId: report.report.id, expiresInDays: 30 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const resolved = await resolveShare({ db, artifacts: store, token: created.share.token });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.share.type !== "report") return;

    expect(resolved.share.title).toBe("客户报告");
    expect(resolved.share.markdown).toBe("报告正文");
    expect(resolved.share.artifacts).toHaveLength(1);
    expect(resolved.share.artifacts[0]).toMatchObject({ id: artifactId, kind: "result", columns });
    expect(resolved.share.artifacts[0]!.rows).toHaveLength(SHARE_MAX_ROWS);
    expect(Object.keys(resolved.share.artifacts[0]!).sort()).toEqual([
      "columns",
      "id",
      "kind",
      "rows",
    ]);
    const serialized = JSON.stringify(resolved.share);
    for (const forbidden of ["storagePath", "userId", "conversationId", "runId"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("shares routes", () => {
  it("requires authentication to create a share", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      payload: { conversationId },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 404 when sharing a foreign conversation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      cookies: { dc_session: otherCookie },
      payload: { conversationId },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "分享目标不存在" },
    });
  });

  it("validates the create payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/shares",
      cookies: { dc_session: cookie },
      payload: { conversationId, reportId: randomUUID(), expiresInDays: 0 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("creates a conversation share and serves it publicly without caching", async () => {
    seedConversation("run-1");
    const created = await app.inject({
      method: "POST",
      url: "/api/shares",
      cookies: { dc_session: cookie },
      payload: { conversationId, expiresInDays: 30 },
    });
    expect(created.statusCode).toBe(201);
    const share = created.json().share as { id: string; token: string; url: string; expiresAt: number };
    expect(share.url).toBe(`/s/${share.token}`);
    expect(JSON.stringify(db.select().from(shares).all())).not.toContain(share.token);

    // Public access needs no cookie.
    const response = await app.inject({
      method: "GET",
      url: `/api/public/shares/${share.token}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.type).toBe("conversation");
    expect(body.title).toBe("销售分析");
    expect(body.messages.length).toBeGreaterThan(0);
  });

  it("returns 410 with no-store for unknown or expired tokens", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/api/public/shares/not-a-real-token",
    });
    expect(missing.statusCode).toBe(410);
    expect(missing.headers["cache-control"]).toBe("no-store");
    expect(missing.json()).toEqual({
      error: { code: "SHARE_GONE", message: "分享链接已过期或已撤销" },
    });

    const expired = createShare({
      db,
      userId,
      conversationId,
      expiresInDays: 1,
      now: Date.now() - 2 * DAY_MS,
    });
    expect(expired.ok).toBe(true);
    if (!expired.ok) return;
    const response = await app.inject({
      method: "GET",
      url: `/api/public/shares/${expired.share.token}`,
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("SHARE_GONE");
  });

  it("revokes as owner and rejects foreign revokers", async () => {
    const created = createShare({ db, userId, conversationId });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const foreign = await app.inject({
      method: "DELETE",
      url: `/api/shares/${created.share.id}`,
      cookies: { dc_session: otherCookie },
    });
    expect(foreign.statusCode).toBe(404);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/shares/${created.share.id}`,
      cookies: { dc_session: cookie },
    });
    expect(revoked.statusCode).toBe(204);

    const gone = await app.inject({
      method: "GET",
      url: `/api/public/shares/${created.share.token}`,
    });
    expect(gone.statusCode).toBe(410);
  });

  it("serves a report share with markdown and truncated artifact rows", async () => {
    const rows = Array.from({ length: 150 }, (_, index) => [index, `name-${index}`]);
    const artifactId = await seedResult(rows);
    const report = await app.inject({
      method: "POST",
      url: "/api/reports",
      cookies: { dc_session: cookie },
      payload: { conversationId, artifactIds: [artifactId], title: "客户报告" },
    });
    expect(report.statusCode).toBe(201);
    const reportBody = report.json().report as { id: string; title: string; markdown: string };
    expect(reportBody.title).toBe("客户报告");
    expect(reportBody.markdown.length).toBeGreaterThan(0);

    const created = await app.inject({
      method: "POST",
      url: "/api/shares",
      cookies: { dc_session: cookie },
      payload: { reportId: reportBody.id, expiresInDays: 1 },
    });
    expect(created.statusCode).toBe(201);
    const share = created.json().share as { token: string };

    const response = await app.inject({
      method: "GET",
      url: `/api/public/shares/${share.token}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(body.type).toBe("report");
    expect(body.markdown).toBe(reportBody.markdown);
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].rows).toHaveLength(SHARE_MAX_ROWS);
    expect(body.artifacts[0].columns).toEqual(columns);
  });

});
