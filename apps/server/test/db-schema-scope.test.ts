import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { insertDatasource, type DatasourceRow } from "../src/db/repositories/datasources.js";
import { saveSchema } from "../src/db/repositories/schema-cache.js";
import {
  createDepartment,
  setUserDepartments,
} from "../src/db/repositories/departments.js";
import { upsertScopePolicy } from "../src/db/repositories/data-scope.js";
import { deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import type { SchemaSnapshot, SchemaTable } from "../src/agent/datasource/introspect.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { buildAgentTools } from "../src/agent/tools/index.js";
import type { AgentToolContext } from "../src/agent/tools/context.js";
import { testConfig as config } from "./helpers/config.js";

let root: string;
let handle: DbHandle;
let artifacts: ArtifactStore;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-schema-scope-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
  artifacts = new ArtifactStore(handle.db, path.join(root, "artifacts"));
  await artifacts.init();
  insertUser(handle.db, {
    id: "admin",
    username: "admin",
    passwordHash: "not-used",
    role: "admin",
    createdAt: Date.now(),
  });
  insertUser(handle.db, {
    id: "u1",
    username: "alice",
    passwordHash: "not-used",
    role: "user",
    createdAt: Date.now(),
  });
  replaceGrants(handle.db, "d1", ["u1"]);
  insertDatasource(handle.db, datasourceRow({ dataScopeMode: "enabled" }));
  saveSchema(
    handle.db,
    "d1",
    snapshot([
      table("orders", [column("dept_id")]),
      table("products"),
      table("salaries"),
      table("secrets"),
    ]),
  );
  const sales = createDepartment(handle.db, { name: "销售", code: "sales" });
  setUserDepartments(handle.db, "u1", [sales.id]);
  upsertScopePolicy(handle.db, {
    datasourceId: "d1",
    tableName: "orders",
    mode: "scoped",
    rules: [{ columnName: "dept_id", operator: "in", valueMode: "department_id" }],
  });
  upsertScopePolicy(handle.db, { datasourceId: "d1", tableName: "products", mode: "public" });
  upsertScopePolicy(handle.db, { datasourceId: "d1", tableName: "salaries", mode: "denied" });
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
    dataScopeMode: "off",
    status: "ok",
    lastCheckedAt: null,
    createdBy: "admin",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function column(name: string) {
  return { name, type: "varchar(255)", nullable: true, defaultValue: null, comment: null };
}

function table(name: string, columns = [column("id")]): SchemaTable {
  return {
    schema: "app",
    name,
    comment: null,
    rowEstimate: 10,
    columns,
    primaryKey: columns.length > 0 ? [columns[0]!.name] : [],
    indexes: [],
    foreignKeys: [],
  };
}

function snapshot(tables: SchemaTable[]): SchemaSnapshot {
  return { tables, refreshedAt: Date.now() };
}

function context(userId: string): AgentToolContext {
  const skillsDir = path.join(root, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  const pools = {
    get: () => ({}),
    evict() {},
    async closeAll() {},
  } as unknown as PoolRegistry;
  return {
    db: handle.db,
    config,
    pools,
    artifacts,
    userId,
    conversationId: "c1",
    datasourceId: "d1",
    runId: "r1",
    skillsDir,
  };
}

async function schemaNames(userId: string): Promise<string[]> {
  const tool = buildAgentTools(context(userId)).find((item) => item.name === "db_schema");
  if (!tool) throw new Error("db_schema not found");
  const result = (await tool.execute("call-1", {} as never, undefined, undefined, undefined as never)) as {
    content: Array<{ type: "text"; text?: string }>;
  };
  const payload = JSON.parse(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join(""),
  );
  return payload.tables.map((item: { name: string }) => item.name);
}

describe("db_schema with department scope", () => {
  it("only exposes tables classified public or scoped", async () => {
    expect(await schemaNames("u1")).toEqual(["orders", "products"]);
  });

  it("hides denied and unclassified tables alike", async () => {
    const names = await schemaNames("u1");
    expect(names).not.toContain("salaries");
    expect(names).not.toContain("secrets");
  });

  it("shows the full schema to admins", async () => {
    expect((await schemaNames("admin")).sort()).toEqual(
      ["orders", "products", "salaries", "secrets"].sort(),
    );
  });

  it("fails with a structured error when the user has no department", async () => {
    insertUser(handle.db, {
      id: "u2",
      username: "bob",
      passwordHash: "not-used",
      role: "user",
      createdAt: Date.now(),
    });
    replaceGrants(handle.db, "d1", ["u1", "u2"]);
    const tool = buildAgentTools(context("u2")).find((item) => item.name === "db_schema");
    if (!tool) throw new Error("db_schema not found");
    const result = (await tool.execute(
      "call-1",
      {} as never,
      undefined,
      undefined,
      undefined as never,
    )) as { isError?: boolean; content: Array<{ type: "text"; text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DATA_SCOPE_NO_DEPARTMENT");
  });
});
