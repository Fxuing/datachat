import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { queryAudit } from "../src/db/schema.js";
import { insertUser } from "../src/db/repositories/users.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { insertDatasource, type DatasourceRow } from "../src/db/repositories/datasources.js";
import { saveSchema } from "../src/db/repositories/schema-cache.js";
import { deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import type { SchemaSnapshot, SchemaTable } from "../src/agent/datasource/introspect.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { buildAgentTools } from "../src/agent/tools/index.js";
import { MAX_SCHEMA_BYTES } from "../src/agent/tools/db-schema.js";
import { MAX_EXPLAIN_BYTES } from "../src/agent/tools/db-explain.js";
import type { AgentToolContext } from "../src/agent/tools/context.js";
import { testConfig as config } from "./helpers/config.js";

let root: string;
let handle: DbHandle;
let artifacts: ArtifactStore;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-tools-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
  artifacts = new ArtifactStore(handle.db, path.join(root, "artifacts"));
  await artifacts.init();
  insertUser(handle.db, {
    id: "u1",
    username: "alice",
    passwordHash: "not-used",
    role: "admin",
    createdAt: Date.now(),
  });
  insertDatasource(handle.db, datasourceRow());
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function datasourceRow(overrides: Partial<DatasourceRow> = {}): DatasourceRow {
  const now = Date.now();
  return {
    id: "d1",
    name: "test",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "app",
    username: "app",
    passwordCipher: encryptSecret("super-secret", deriveSecretKey(config.appSecret)),
    sslMode: "disable",
    optionsJson: null,
    readOnlyVerified: 1,
    allowWriteAccount: 0,
    status: "ok",
    lastCheckedAt: null,
    createdBy: "u1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function column(name: string, comment: string | null = null) {
  return { name, type: "varchar(255)", nullable: true, defaultValue: null, comment };
}

function table(name: string, columns = [column("id")], extra: Partial<SchemaTable> = {}): SchemaTable {
  return {
    schema: "app",
    name,
    comment: null,
    rowEstimate: 10,
    columns,
    primaryKey: columns.length > 0 ? [columns[0]!.name] : [],
    indexes: [],
    foreignKeys: [],
    ...extra,
  };
}

function snapshot(tables: SchemaTable[]): SchemaSnapshot {
  return { tables, refreshedAt: Date.now() };
}

/** Registry stub that counts acquisitions; the fake pool streams `rows` rows. */
function fakeMysqlPool(rowCount = 25) {
  const calls = { gets: 0, connections: 0 };
  const pool = {
    async getConnection() {
      calls.connections += 1;
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
              listeners.get("fields")?.([{ name: "id" }, { name: "name" }]);
              return (async function* rows() {
                for (let index = 1; index <= rowCount; index += 1) {
                  yield [index, `name-${index}`];
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
  const registry = {
    get() {
      calls.gets += 1;
      return { mysql: pool };
    },
    evict() {},
    async closeAll() {},
  } as unknown as PoolRegistry;
  return { registry, calls };
}

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  const skillsDir = path.join(root, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  return {
    db: handle.db,
    config,
    pools: fakeMysqlPool().registry,
    artifacts,
    userId: "u1",
    conversationId: "c1",
    datasourceId: "d1",
    runId: "r1",
    skillsDir,
    ...overrides,
  };
}

type AnyTool = ReturnType<typeof buildAgentTools>[number];

function tool(ctx: AgentToolContext, name: string): AnyTool {
  const found = buildAgentTools(ctx).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

function run(target: AnyTool, params: unknown, ctx?: AgentToolContext) {
  return target.execute("call-1", params as never, undefined, undefined, ctx as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

describe("db_schema", () => {
  it("searches by table and column names case-insensitively", async () => {
    saveSchema(
      handle.db,
      "d1",
      snapshot([
        table("users", [column("id"), column("email")]),
        table("orders", [column("id"), column("user_id")]),
      ]),
    );

    const ctx = context();
    const byTable = JSON.parse(textOf(await run(tool(ctx, "db_schema"), { search: "USERS" })));
    expect(byTable.tables.map((item: { name: string }) => item.name)).toEqual(["users"]);

    const byColumn = JSON.parse(textOf(await run(tool(ctx, "db_schema"), { search: "user_id" })));
    expect(byColumn.tables.map((item: { name: string }) => item.name)).toEqual(["orders"]);

    const exact = JSON.parse(textOf(await run(tool(ctx, "db_schema"), { table: "orders" })));
    expect(exact.tables).toHaveLength(1);
    expect(exact.tables[0].columns[0]).toEqual({
      name: "id",
      type: "varchar(255)",
      nullable: true,
      pk: true,
      comment: null,
    });
  });

  it("caps the JSON output at 8KB and flags truncation", async () => {
    const wideColumns = Array.from({ length: 120 }, (_, index) =>
      column(`column_${index}`, "很长的列注释".repeat(20)),
    );
    saveSchema(handle.db, "d1", snapshot([table("wide", wideColumns)]));

    const result = await run(tool(context(), "db_schema"), {});
    const text = textOf(result);
    const parsed = JSON.parse(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.tables[0].columns.length).toBeLessThan(120);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_SCHEMA_BYTES);
    expect((result as { details: { truncated: boolean } }).details.truncated).toBe(true);
  });
});

describe("db_query", () => {
  it("returns a compact preview and full details for the event bridge", async () => {
    const ctx = context();
    const result = await run(tool(ctx, "db_query"), { sql: "SELECT id, name FROM t" });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result));
    expect(payload.rowCount).toBe(25);
    expect(payload.previewRows).toHaveLength(20);
    expect(payload.previewRows[0]).toEqual([1, "name-1"]);
    expect(payload.columns.map((item: { name: string }) => item.name)).toEqual(["id", "name"]);

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.artifactId).toBe(payload.artifactId);
    expect(details.guard).toBe("ok");
    expect(details.sql).toMatch(/LIMIT 1001/i);
    expect(details.auditId).toBeTypeOf("string");
    expect((details.auditId as string).length).toBeGreaterThan(0);

    const record = artifacts.getForUser(payload.artifactId, "u1");
    expect(record?.conversationId).toBe("c1");
    expect(record?.runId).toBe("r1");
    expect(record?.rowCount).toBe(25);
  });

  it("returns isError for a guard rejection without acquiring a connection", async () => {
    const { registry, calls } = fakeMysqlPool();
    const ctx = context({ pools: registry });
    const result = await run(tool(ctx, "db_query"), { sql: "DELETE FROM t" });

    expect(result.isError).toBe(true);
    expect(calls.gets).toBe(0);
    const payload = JSON.parse(textOf(result));
    expect(payload.code).toBe("FORBIDDEN_STATEMENT");
    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.guard).toBe("rejected");
    expect(details.auditId).toBeTypeOf("string");
  });
});

describe("db_explain", () => {
  it("returns the explain output as capped text", async () => {
    const result = await run(tool(context(), "db_explain"), { sql: "SELECT id FROM t" });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("id | name");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_EXPLAIN_BYTES);
  });

  it("rejects unsafe explain SQL before connecting", async () => {
    const { registry, calls } = fakeMysqlPool();
    const result = await run(tool(context({ pools: registry }), "db_explain"), {
      sql: "UPDATE t SET id = 1",
    });
    expect(result.isError).toBe(true);
    expect(calls.gets).toBe(0);
  });
});

describe("datasource authorization", () => {
  function insertNonAdmin() {
    insertUser(handle.db, {
      id: "u2",
      username: "bob",
      passwordHash: "not-used",
      role: "user",
      createdAt: Date.now(),
    });
  }

  it("denies db_schema after the grant is revoked", async () => {
    insertNonAdmin();
    saveSchema(handle.db, "d1", snapshot([table("users")]));
    replaceGrants(handle.db, "d1", ["u2"]);
    const ctx = context({ userId: "u2" });
    expect(textOf(await run(tool(ctx, "db_schema"), {}))).toContain("users");

    replaceGrants(handle.db, "d1", []);
    const denied = await run(tool(ctx, "db_schema"), {});
    expect(denied.isError).toBe(true);
    expect(JSON.parse(textOf(denied))).toMatchObject({
      code: "DATASOURCE_FORBIDDEN",
      message: "无权访问该数据源",
    });
  });

  it("denies db_explain after the grant is revoked", async () => {
    insertNonAdmin();
    replaceGrants(handle.db, "d1", ["u2"]);
    const ctx = context({ userId: "u2" });

    replaceGrants(handle.db, "d1", []);
    const denied = await run(tool(ctx, "db_explain"), { sql: "SELECT id FROM t" });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(textOf(denied))).toMatchObject({
      code: "DATASOURCE_FORBIDDEN",
      message: "无权访问该数据源",
    });

    const audits = handle.db.select().from(queryAudit).all();
    expect(audits.at(-1)).toMatchObject({
      action: "explain",
      status: "rejected",
      userId: "u2",
      datasourceId: "d1",
    });
  });

  it("records a successful explain in query_audit", async () => {
    const result = await run(tool(context(), "db_explain"), { sql: "SELECT id FROM t" });
    expect(result.isError).toBeFalsy();

    const audits = handle.db.select().from(queryAudit).all();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "explain",
      status: "ok",
      userId: "u1",
      conversationId: "c1",
      datasourceId: "d1",
      runId: "r1",
      sqlText: "SELECT id FROM t",
    });
    expect(audits[0]!.durationMs).toBeTypeOf("number");
  });
});

describe("list_artifacts", () => {
  it("only lists artifacts from the current conversation", async () => {
    const own = artifacts.openResult({ userId: "u1", conversationId: "c1", runId: "r1" });
    await own.write([1, "a"]);
    const ownMeta = await own.finish({
      columns: [{ name: "id", type: "number" }],
      rowCount: 1,
      truncated: false,
    });
    const other = artifacts.openResult({ userId: "u1", conversationId: "c2", runId: "r2" });
    await other.write([2, "b"]);
    await other.finish({
      columns: [{ name: "id", type: "number" }],
      rowCount: 1,
      truncated: false,
    });

    const payload = JSON.parse(textOf(await run(tool(context(), "list_artifacts"), {})));
    expect(payload.artifacts).toHaveLength(1);
    expect(payload.artifacts[0]).toMatchObject({
      id: ownMeta.id,
      kind: "query_result",
      rowCount: 1,
      truncated: false,
    });
  });
});

describe("sandbox read", () => {
  it("reads SKILL.md inside the skills directory", async () => {
    const ctx = context();
    fs.mkdirSync(path.join(ctx.skillsDir, "sql"), { recursive: true });
    fs.writeFileSync(
      path.join(ctx.skillsDir, "sql", "SKILL.md"),
      "---\nname: sql\ndescription: test skill\n---\n\nUse LIMIT.\n",
    );

    const result = await run(tool(ctx, "read"), { path: "sql/SKILL.md" });
    const text = textOf(result);
    expect(text).toContain("name: sql");
    expect(text).toContain("Use LIMIT.");
  });

  it("rejects parent traversal and absolute paths outside the sandbox", async () => {
    const ctx = context();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "top secret");

    await expect(run(tool(ctx, "read"), { path: "../outside.txt" })).rejects.toThrow(/EACCES/);
    await expect(run(tool(ctx, "read"), { path: outside })).rejects.toThrow(/EACCES/);
  });

  it("rejects a symlink that points outside the sandbox", async () => {
    const ctx = context();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "top secret");
    const link = path.join(ctx.skillsDir, "leak.txt");
    try {
      fs.symlinkSync(outside, link, "file");
    } catch {
      // Windows without developer mode cannot create file symlinks; nothing to assert.
      return;
    }

    await expect(run(tool(ctx, "read"), { path: "leak.txt" })).rejects.toThrow(/EACCES/);
  });
});
