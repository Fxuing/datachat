import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { buildAgentTools } from "../src/agent/tools/index.js";
import type { AgentToolContext } from "../src/agent/tools/context.js";
import { RunEventBus } from "../src/agent/event-bus.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { insertUser } from "../src/db/repositories/users.js";
import { createRun } from "../src/db/repositories/runs.js";
import { saveSettings } from "../src/services/app-settings.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { getOpsMetrics } from "../src/services/ops-metrics.js";
import { createRetentionService } from "../src/services/ops-retention.js";
import { resolveConversationSqlitePath } from "../src/services/file-store.js";
import { conversations, queryAudit, skills } from "../src/db/schema.js";
import { testConfig } from "./helpers/config.js";

function encodeMultipart(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType?: string; content: Buffer | string }
  >,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----DataChatTest${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if ("filename" in part) {
      const content = typeof part.content === "string" ? Buffer.from(part.content, "utf8") : part.content;
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`,
          "utf8",
        ),
        content,
        Buffer.from("\r\n", "utf8"),
      );
    } else {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          "utf8",
        ),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

let root: string;
let db: Db;
let sqlite: ReturnType<typeof createDb>["sqlite"];
let artifacts: ArtifactStore;
let userId: string;
let otherUserId: string;
let cookie: string;
let otherCookie: string;

const fakeRuntime = {
  bus: new RunEventBus(),
  isBusy: vi.fn(() => false),
  remove: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
  getOrCreate: vi.fn(() => ({
    queueLength: 0,
    enqueue: () => 1,
  })),
};

const unusedPools = {
  get() {
    throw new Error("should not acquire DB pool in file mode");
  },
  evict() {},
  async closeAll() {},
} as unknown as PoolRegistry;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-conv-files-"));
  const handle = createDb(path.join(root, "datachat.db"));
  db = handle.db;
  sqlite = handle.sqlite;
  migrateDb(db);
  artifacts = new ArtifactStore(db, path.join(root, "artifacts"));
  await artifacts.init();

  userId = randomUUID();
  otherUserId = randomUUID();
  for (const [id, username] of [
    [userId, "alice"],
    [otherUserId, "bob"],
  ] as const) {
    insertUser(db, {
      id,
      username,
      passwordHash: await hashPassword(`${username}-pass-123`),
      role: "user",
      createdAt: Date.now(),
    });
  }
  cookie = await createSessionSigner(testConfig.appSecret).sign({
    sub: userId,
    username: "alice",
    role: "user",
  });
  otherCookie = await createSessionSigner(testConfig.appSecret).sign({
    sub: otherUserId,
    username: "bob",
    role: "user",
  });

  fakeRuntime.isBusy.mockReturnValue(false);
  fakeRuntime.remove.mockClear();
});

afterEach(() => {
  try {
    sqlite.close();
  } catch {
    // ignore
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function cfg() {
  return {
    ...testConfig,
    dataDir: root,
    dbPath: path.join(root, "datachat.db"),
    siliconflowApiKey: "sk-test",
    agentAuthPath: path.join(root, "agent", "auth.json"),
  };
}

async function makeApp() {
  return buildApp({
    config: cfg(),
    db,
    artifacts,
    pools: unusedPools,
    enableRateLimit: false,
    agentRuntime: fakeRuntime as unknown as RuntimeManager,
  });
}

describe("file-analysis conversations API and tools", () => {
  it("previews files without creating conversations or disk files, and honors headerRows overrides", async () => {
    const app = await makeApp();
    try {
      const dirtyCsv = '2026年报表\n部门,销售额\n华东,"¥1,200.50"\n华北,¥800';
      const req = encodeMultipart([
        { name: "files", filename: "sales.csv", content: dirtyCsv },
      ]);
      const res = await app.inject({
        method: "POST",
        url: "/api/files/preview",
        cookies: { dc_session: cookie },
        headers: req.headers,
        payload: req.payload,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalTables).toBe(1);
      expect(body.totalRows).toBe(2);
      expect(body.files[0].headerRow).toBe(2);
      expect(body.files[0].tables[0].tableName).toBe("sales");
      expect(body.files[0].tables[0].columns[1]).toMatchObject({
        name: "销售额",
        type: "REAL",
        formatHint: "currency",
      });
      expect(body.files[0].tables[0].sampleRows).toEqual([
        ["华东", 1200.5],
        ["华北", 800],
      ]);
      expect(db.select().from(conversations).all()).toHaveLength(0);
      expect(fs.existsSync(path.join(root, "files"))).toBe(false);

      // Manual headerRow override (row 1)
      const manual = encodeMultipart([
        { name: "files", filename: "sales.csv", content: dirtyCsv },
        { name: "headerRows", value: JSON.stringify([1]) },
      ]);
      const manualRes = await app.inject({
        method: "POST",
        url: "/api/files/preview",
        cookies: { dc_session: cookie },
        headers: manual.headers,
        payload: manual.payload,
      });
      expect(manualRes.statusCode).toBe(200);
      expect(manualRes.json().files[0].headerRow).toBe(1);
      expect(manualRes.json().files[0].tables[0].rowCount).toBe(3);

      // Rejects .xls
      const bad = encodeMultipart([
        { name: "files", filename: "legacy.xls", content: "bad" },
      ]);
      const badRes = await app.inject({
        method: "POST",
        url: "/api/files/preview",
        cookies: { dc_session: cookie },
        headers: bad.headers,
        payload: bad.payload,
      });
      expect(badRes.statusCode).toBe(400);
      expect(badRes.json().error.code).toBe("UNSUPPORTED_FILE_TYPE");
    } finally {
      await app.close();
    }
  });

  it("creates file conversations without DB datasources, appends tables for JOINs, executes guarded tools, and cleans up on delete", async () => {
    const app = await makeApp();
    try {
      const ordersCsv = "订单号,部门,金额\n001,华东,120\n002,华北,80";
      const createReq = encodeMultipart([
        { name: "title", value: "8月销售分析" },
        { name: "files", filename: "orders.csv", content: ordersCsv },
      ]);
      const createRes = await app.inject({
        method: "POST",
        url: "/api/conversations/file",
        cookies: { dc_session: cookie },
        headers: createReq.headers,
        payload: createReq.payload,
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      const conversationId = created.conversation.id as string;
      expect(created.conversation.sourceKind).toBe("file");
      expect(created.conversation.datasourceId).toBeNull();
      expect(created.files).toHaveLength(1);
      expect(created.tables).toHaveLength(1);
      expect(created.tables[0].tableName).toBe("orders");

      const sqlitePath = resolveConversationSqlitePath(root, conversationId);
      expect(fs.existsSync(sqlitePath)).toBe(true);

      // Other user gets 404 on detail, list files, and append
      const otherGet = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversationId}/files`,
        cookies: { dc_session: otherCookie },
      });
      expect(otherGet.statusCode).toBe(404);

      const detailRes = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: cookie },
      });
      expect(detailRes.statusCode).toBe(200);
      expect(detailRes.json().files).toHaveLength(1);
      expect(detailRes.json().tables).toHaveLength(1);

      // Build Agent tools targeting the file conversation
      const run = createRun(db, { conversationId, userId });
      const ctx: AgentToolContext = {
        db,
        config: cfg(),
        pools: unusedPools,
        artifacts,
        userId,
        conversationId,
        datasourceId: null,
        sourceKind: "file",
        runId: run.id,
        skillsDir: path.join(root, "skills", conversationId),
      };
      const tools = buildAgentTools(ctx);
      const dbSchema = tools.find((t) => t.name === "db_schema")!;
      const dbQuery = tools.find((t) => t.name === "db_query")!;
      const dbExplain = tools.find((t) => t.name === "db_explain")!;

      const schemaRes1 = await dbSchema.execute("s1", {} as never, undefined, undefined, ctx as never);
      const schemaPayload1 = JSON.parse(
        (schemaRes1.content[0] as { text: string }).text,
      );
      expect(schemaPayload1.tables.map((t: { name: string }) => t.name)).toEqual(["orders"]);
      expect(schemaPayload1.tables[0].columns[0].comment).toContain("示例：001 / 002");

      // Explain works
      const explainRes = await dbExplain.execute(
        "e1",
        { sql: `SELECT "部门", SUM("金额") FROM "orders" GROUP BY "部门"` } as never,
        undefined,
        undefined,
        ctx as never,
      );
      expect(explainRes.isError).toBeFalsy();
      expect((explainRes.content[0] as { text: string }).text).toContain("orders");

      // Busy check blocks append with 409
      fakeRuntime.isBusy.mockReturnValue(true);
      const busyReq = encodeMultipart([
        { name: "files", filename: "targets.csv", content: "部门,目标\n华东,100" },
      ]);
      const busyRes = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/files`,
        cookies: { dc_session: cookie },
        headers: busyReq.headers,
        payload: busyReq.payload,
      });
      expect(busyRes.statusCode).toBe(409);
      fakeRuntime.isBusy.mockReturnValue(false);

      // Append a second CSV table for JOIN analysis
      const appendReq = encodeMultipart([
        { name: "files", filename: "targets.csv", content: "部门,目标\n华东,100\n华北,90" },
      ]);
      const appendRes = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/files`,
        cookies: { dc_session: cookie },
        headers: appendReq.headers,
        payload: appendReq.payload,
      });
      expect(appendRes.statusCode).toBe(201);
      expect(appendRes.json().tables.map((t: { tableName: string }) => t.tableName)).toEqual([
        "orders",
        "targets",
      ]);

      // db_schema immediately sees the newly appended table without recreating the session!
      const schemaRes2 = await dbSchema.execute("s2", {} as never, undefined, undefined, ctx as never);
      const schemaPayload2 = JSON.parse(
        (schemaRes2.content[0] as { text: string }).text,
      );
      expect(schemaPayload2.tables.map((t: { name: string }) => t.name)).toEqual([
        "orders",
        "targets",
      ]);

      // Cross-table JOIN query succeeds through runGuardedFileQuery + writes artifact & audit
      const queryRes = await dbQuery.execute(
        "q1",
        {
          sql: `SELECT o."部门", o."金额", t."目标" FROM "orders" o JOIN "targets" t ON o."部门" = t."部门" ORDER BY o."金额" DESC`,
        } as never,
        undefined,
        undefined,
        ctx as never,
      );
      expect(queryRes.isError).toBeFalsy();
      const queryPayload = JSON.parse((queryRes.content[0] as { text: string }).text);
      expect(queryPayload.rows ?? queryPayload.previewRows).toEqual([
        ["华东", 120, 100],
        ["华北", 80, 90],
      ]);

      // Rejected dangerous query records audit with datasourceId: null
      const badQueryRes = await dbQuery.execute(
        "q2",
        { sql: "SELECT * FROM sqlite_master" } as never,
        undefined,
        undefined,
        ctx as never,
      );
      expect(badQueryRes.isError).toBe(true);
      const audits = db.select().from(queryAudit).all();
      expect(audits.some((a) => a.status === "ok" && a.datasourceId === null)).toBe(true);
      expect(audits.some((a) => a.status === "rejected" && a.datasourceId === null)).toBe(true);

      // Ops metrics aggregates file runs under dedicated bucket instead of "deleted datasource"
      const metrics = getOpsMetrics({ db, days: 7 });
      expect(metrics.datasources).toContainEqual(
        expect.objectContaining({ datasourceId: "__file__", name: "文件分析（Excel/CSV）" }),
      );

      // Delete conversation cleans up sqlite file directory and metadata rows
      const delRes = await app.inject({
        method: "DELETE",
        url: `/api/conversations/${conversationId}`,
        cookies: { dc_session: cookie },
      });
      expect(delRes.statusCode).toBe(204);
      expect(fs.existsSync(path.join(root, "files", conversationId))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("exposes only global skills from GET /api/skills/global", async () => {
    const now = Date.now();
    const dsId = randomUUID();
    insertDatasource(db, {
      id: dsId,
      name: "ds",
      type: "mysql",
      host: "127.0.0.1",
      port: 3306,
      database: "ds",
      username: "ds",
      passwordCipher: "cipher",
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    db.insert(skills)
      .values([
        {
          id: randomUUID(),
          scope: "global",
          datasourceId: null,
          name: "global-analysis",
          description: "全局规范",
          content: "# global",
          enabled: 1,
          updatedBy: userId,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: randomUUID(),
          scope: "datasource",
          datasourceId: dsId,
          name: "ds-only",
          description: "数据源专属",
          content: "# ds",
          enabled: 1,
          updatedBy: userId,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/skills/global",
        cookies: { dc_session: cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().skills.map((s: { name: string }) => s.name)).toEqual([
        "global-analysis",
      ]);
    } finally {
      await app.close();
    }
  });

  it("includes uploaded SQLite file bytes in retention preview and deletes file directories on retention run", async () => {
    const app = await makeApp();
    try {
      const createReq = encodeMultipart([
        { name: "files", filename: "old.csv", content: "k,v\na,1\nb,2" },
      ]);
      const createRes = await app.inject({
        method: "POST",
        url: "/api/conversations/file",
        cookies: { dc_session: cookie },
        headers: createReq.headers,
        payload: createReq.payload,
      });
      const conversationId = createRes.json().conversation.id as string;
      const fileDir = path.join(root, "files", conversationId);
      expect(fs.existsSync(fileDir)).toBe(true);

      const DAY = 86_400_000;
      saveSettings(db, { retentionConversationDays: 7, retentionAuditDays: 7 });
      db.update(conversations)
        .set({ lastMessageAt: Date.now() - 30 * DAY })
        .where(eq(conversations.id, conversationId))
        .run();

      const retention = createRetentionService({
        db,
        config: cfg(),
        runtime: {
          isBusy: () => false,
          remove: async () => undefined,
        },
        artifacts,
      });

      const preview = await retention.preview();
      expect(preview.conversations.willDelete).toBe(1);
      expect(preview.conversations.artifactBytes).toBeGreaterThan(0);

      const runResult = await retention.run(userId);
      expect(runResult.deletedConversations).toBe(1);
      expect(fs.existsSync(fileDir)).toBe(false);
    } finally {
      await app.close();
    }
  });
});
