import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { artifacts, queryAudit } from "../src/db/schema.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { createRun } from "../src/db/repositories/runs.js";
import { insertUser } from "../src/db/repositories/users.js";
import { RunEventBus } from "../src/agent/event-bus.js";
import type { RuntimeManager } from "../src/agent/runtime.js";
import { recordAudit } from "../src/services/audit.js";
import { ArtifactStore, type ColumnInfo } from "../src/services/artifacts.js";
import { testConfig } from "./helpers/config.js";

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
let datasourceId: string;
let conversationId: string;

const fakeRuntime = {
  bus: new RunEventBus(),
  enqueued: [] as unknown[],
  position: 1,
  abort: vi.fn(() => true),
  remove: vi.fn(async () => undefined),
  isBusy: vi.fn(() => false),
  shutdown: vi.fn(async () => undefined),
  getOrCreate: vi.fn(() => ({
    queueLength: 0,
    enqueue: () => 1,
  })),
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-artifacts-api-"));
  const handle = createDb(":memory:");
  db = handle.db;
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

  datasourceId = randomUUID();
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
  conversationId = createConversation(db, { userId, datasourceId, title: "chat" }).id;

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

async function seedResult(
  rows: unknown[][],
  options: {
    owner?: string;
    conversation?: string | null;
    runId?: string | null;
    count?: number;
  } = {},
): Promise<string> {
  const writer = store.openResult({
    userId: options.owner ?? userId,
    conversationId: options.conversation === undefined ? conversationId : options.conversation,
    runId: options.runId ?? null,
  });
  for (const row of rows) await writer.write(row);
  const meta = await writer.finish({
    columns,
    rowCount: options.count ?? rows.length,
    truncated: false,
  });
  return meta.id;
}

function seedRawResult(input: {
  owner?: string;
  conversation?: string | null;
  rowCount: number;
  storagePath?: string | null;
  kind?: "result" | "chart";
}): string {
  const id = randomUUID();
  db.insert(artifacts)
    .values({
      id,
      conversationId: input.conversation === undefined ? conversationId : input.conversation,
      userId: input.owner ?? userId,
      runId: null,
      kind: input.kind ?? "result",
      storagePath: input.storagePath === undefined ? null : input.storagePath,
      columnsJson: JSON.stringify(columns),
      rowCount: input.rowCount,
      truncated: 0,
      specJson: input.kind === "chart" ? JSON.stringify({ series: [] }) : null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

function get(url: string, withCookie = cookie) {
  return app.inject({ method: "GET", url, cookies: { dc_session: withCookie } });
}

/** The audit row is written after the response stream settles, just after inject resolves. */
async function exportAudits(expected = 1) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const rows = db.select().from(queryAudit).where(eq(queryAudit.action, "export")).all();
    if (rows.length >= expected || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("artifact metadata and rows", () => {
  it("returns metadata to the owner and admins, hides it from others", async () => {
    const id = await seedResult([[1, "alice"]]);

    const own = await get(`/api/artifacts/${id}`);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({
      id,
      kind: "result",
      conversationId,
      rowCount: 1,
      truncated: false,
      columns,
      spec: null,
    });

    expect((await get(`/api/artifacts/${id}`, adminCookie)).statusCode).toBe(200);
    expect((await get(`/api/artifacts/${id}`, otherCookie)).statusCode).toBe(404);
    expect((await get("/api/artifacts/not-a-uuid")).statusCode).toBe(400);
    expect((await get(`/api/artifacts/${randomUUID()}`)).statusCode).toBe(404);
  });

  it("paginates rows with a streaming offset and reports the full total", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => [index + 1, `row-${index + 1}`]);
    const id = await seedResult(rows);

    const page = await get(`/api/artifacts/${id}/rows?offset=1&limit=2`);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({
      columns,
      rows: [
        [2, "row-2"],
        [3, "row-3"],
      ],
      total: 5,
    });

    const tail = await get(`/api/artifacts/${id}/rows?offset=99&limit=10`);
    expect(tail.statusCode).toBe(200);
    expect(tail.json()).toEqual({ columns, rows: [], total: 5 });

    const defaults = await get(`/api/artifacts/${id}/rows`);
    expect(defaults.json().rows).toHaveLength(5);

    expect((await get(`/api/artifacts/${id}/rows?limit=0`)).statusCode).toBe(400);
    expect((await get(`/api/artifacts/${id}/rows?limit=1001`)).statusCode).toBe(400);
    expect((await get(`/api/artifacts/${id}/rows?offset=-1`)).statusCode).toBe(400);
    expect((await get(`/api/artifacts/${id}/rows`, otherCookie)).statusCode).toBe(404);
  });

  it("returns 410 when the backing file disappeared", async () => {
    const id = await seedResult([[1, "gone"]]);
    const record = store.get(id);
    expect(record?.storagePath).toBeTruthy();
    fs.rmSync(path.join(root, "artifacts", record!.storagePath));

    const meta = await get(`/api/artifacts/${id}`);
    expect(meta.statusCode).toBe(200);

    const rows = await get(`/api/artifacts/${id}/rows`);
    expect(rows.statusCode).toBe(410);
    expect(rows.json().error.code).toBe("ARTIFACT_GONE");

    const download = await get(`/api/artifacts/${id}/download`);
    expect(download.statusCode).toBe(410);
  });

  it("returns chart artifacts without attempting to read rows", async () => {
    const id = seedRawResult({ rowCount: 12, kind: "chart" });

    const meta = await get(`/api/artifacts/${id}`);
    expect(meta.statusCode).toBe(200);
    expect(meta.json().spec).toEqual({ series: [] });

    const rows = await get(`/api/artifacts/${id}/rows`);
    expect(rows.statusCode).toBe(200);
    expect(rows.json()).toEqual({ columns, rows: [], total: 12 });

    const download = await get(`/api/artifacts/${id}/download`);
    expect(download.statusCode).toBe(400);
    expect(download.json().error.code).toBe("NOT_EXPORTABLE");
  });
});

describe("artifact download", () => {
  it("paginates and exports a 1000-row artifact end to end", async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => [index + 1, `row-${index + 1}`]);
    const id = await seedResult(rows);

    const tail = await get(`/api/artifacts/${id}/rows?offset=500&limit=1000`);
    expect(tail.statusCode).toBe(200);
    expect(tail.json().total).toBe(1000);
    expect(tail.json().rows).toHaveLength(500);
    expect(tail.json().rows[0]).toEqual([501, "row-501"]);
    expect(tail.json().rows.at(-1)).toEqual([1000, "row-1000"]);

    const head = await get(`/api/artifacts/${id}/rows?offset=0&limit=1`);
    expect(head.json()).toEqual({ columns, rows: [[1, "row-1"]], total: 1000 });

    const response = await get(`/api/artifacts/${id}/download?format=csv`);
    expect(response.statusCode).toBe(200);
    const lines = response.body.split("\r\n");
    expect(lines[0]).toBe("\uFEFFid,name");
    expect(lines[1]).toBe("1,row-1");
    expect(lines[1000]).toBe("1000,row-1000");
    // header + 1000 data rows + the trailing empty segment after the final CRLF
    expect(lines).toHaveLength(1002);
    expect(lines.filter((line) => line !== "")).toHaveLength(1001);
  });

  it("streams CSV with a BOM and RFC4180 escaping", async () => {
    const id = await seedResult([
      [1, "a,b"],
      [2, 'x"y'],
      [3, "line\nbreak"],
    ]);

    const response = await get(`/api/artifacts/${id}/download?format=csv`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(String(response.headers["content-disposition"])).toContain("attachment;");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe(
      '\uFEFFid,name\r\n1,"a,b"\r\n2,"x""y"\r\n3,"line\nbreak"\r\n',
    );
  });

  it("streams a readable XLSX workbook", async () => {
    const id = await seedResult([
      [1, "alice"],
      [2, null],
    ]);

    const response = await get(`/api/artifacts/${id}/download?format=xlsx`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(response.rawPayload.subarray(0, 2).toString("latin1")).toBe("PK");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(response.rawPayload) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.worksheets[0];
    expect(sheet).toBeDefined();
    if (!sheet) return;
    expect(sheet.getRow(1).values).toEqual([undefined, "id", "name"]);
    expect(sheet.getRow(3).getCell(2).value).toBeNull();
    expect(sheet.actualRowCount).toBe(3);
  });

  it("rejects exports above the row cap with 413", async () => {
    const id = seedRawResult({ rowCount: 100_001, storagePath: "missing.jsonl.gz" });
    const response = await get(`/api/artifacts/${id}/download?format=csv`);
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("EXPORT_TOO_LARGE");
  });

  it("hides other users' artifacts and audits successful exports", async () => {
    const run = createRun(db, { conversationId, userId });
    const id = await seedResult([[1, "a"]], { runId: run.id });
    recordAudit(db, {
      runId: run.id,
      conversationId,
      userId,
      datasourceId,
      action: "query",
      sqlText: "select 1 as id, 'a' as name",
      status: "ok",
      rowCount: 1,
    });

    expect((await get(`/api/artifacts/${id}/download?format=csv`, otherCookie)).statusCode).toBe(
      404,
    );

    const response = await get(`/api/artifacts/${id}/download?format=csv`);
    expect(response.statusCode).toBe(200);

    const audits = await exportAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      runId: run.id,
      conversationId,
      userId,
      datasourceId,
      action: "export",
      status: "ok",
      rowCount: 1,
      sqlText: "select 1 as id, 'a' as name",
    });
  });

  it("writes the ok export audit only after the stream finishes", async () => {
    const id = await seedResult([[1, "a"]]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.openRows.bind(store);
    const spy = vi.spyOn(store, "openRows").mockImplementation((artifactId) =>
      (async function* () {
        const inner = original(artifactId);
        const first = await inner.next();
        try {
          if (!first.done) yield first.value;
          await gate;
          for (;;) {
            const next = await inner.next();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          await inner.return(undefined);
        }
      })(),
    );

    try {
      const pending = get(`/api/artifacts/${id}/download?format=csv`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        db.select().from(queryAudit).where(eq(queryAudit.action, "export")).all(),
      ).toHaveLength(0);
      release();
      const response = await pending;
      expect(response.statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }

    const audits = await exportAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: "ok", rowCount: 1 });
  });

  it("records exactly one error audit when the export stream breaks", async () => {
    const id = await seedResult([
      [1, "a"],
      [2, "b"],
    ]);
    const spy = vi.spyOn(store, "openRows").mockImplementation(() =>
      (async function* () {
        yield [1, "a"];
        throw new Error("synthetic stream failure");
      })(),
    );

    try {
      const response = await get(`/api/artifacts/${id}/download?format=csv`);
      expect(response.statusCode).toBe(200);
    } catch {
      // Fastify inject surfaces the mid-stream socket error as a rejected request.
    } finally {
      spy.mockRestore();
    }

    const audits = await exportAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: "error" });
    expect(audits[0]?.errorMessage ?? "").toContain("synthetic stream failure");
  });

  it("lets admins download another user's artifact", async () => {
    const id = await seedResult([[1, "a"]]);
    const response = await get(`/api/artifacts/${id}/download?format=csv`, adminCookie);
    expect(response.statusCode).toBe(200);
    const audit = (await exportAudits())[0];
    expect(audit?.userId).toBe(adminId);
  });
});
