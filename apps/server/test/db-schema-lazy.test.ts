import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.hoisted(() => ({ refreshDatasourceSchema: vi.fn() }));

vi.mock("../src/services/schema-refresh.js", () => refreshMock);

import { deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import type { SchemaSnapshot, SchemaTable } from "../src/agent/datasource/introspect.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { buildAgentTools } from "../src/agent/tools/index.js";
import type { AgentToolContext } from "../src/agent/tools/context.js";
import type { ArtifactStore } from "../src/services/artifacts.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { replaceGrants } from "../src/db/repositories/grants.js";
import { saveSchema, SCHEMA_CACHE_TTL_MS } from "../src/db/repositories/schema-cache.js";
import { insertUser } from "../src/db/repositories/users.js";
import { testConfig as config } from "./helpers/config.js";

let root: string;
let handle: DbHandle;

function table(name: string): SchemaTable {
  return {
    schema: "app",
    name,
    comment: null,
    rowEstimate: 1,
    columns: [{ name: "id", type: "int", nullable: false, defaultValue: null, comment: null }],
    primaryKey: ["id"],
    indexes: [],
    foreignKeys: [],
  };
}

function snapshot(name: string, refreshedAt = Date.now()): SchemaSnapshot {
  return { tables: [table(name)], refreshedAt };
}

function context(): AgentToolContext {
  return {
    db: handle.db,
    config,
    pools: {} as PoolRegistry,
    artifacts: {} as ArtifactStore,
    userId: "u1",
    conversationId: "c1",
    datasourceId: "d1",
    runId: "r1",
    skillsDir: path.join(root, "skills"),
  };
}

async function execute(params: Record<string, unknown> = {}) {
  const tool = buildAgentTools(context()).find((item) => item.name === "db_schema");
  if (!tool) throw new Error("db_schema missing");
  return tool.execute("call-1", params as never, undefined, undefined, undefined as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-db-schema-lazy-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
  insertUser(handle.db, {
    id: "u1",
    username: "alice",
    passwordHash: "not-used",
    role: "admin",
    createdAt: Date.now(),
  });
  insertDatasource(handle.db, {
    id: "d1",
    name: "test",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "app",
    username: "app",
    passwordCipher: encryptSecret("secret", deriveSecretKey(config.appSecret)),
    sslMode: "disable",
    optionsJson: null,
    readOnlyVerified: 1,
    allowWriteAccount: 0,
    status: "ok",
    lastCheckedAt: null,
    createdBy: "u1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  replaceGrants(handle.db, "d1", ["u1"]);
  refreshMock.refreshDatasourceSchema.mockReset();
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("db_schema lazy refresh", () => {
  it("loads the schema when the cache is empty", async () => {
    refreshMock.refreshDatasourceSchema.mockResolvedValue(snapshot("orders"));

    const result = await execute({});
    expect(refreshMock.refreshDatasourceSchema).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain("orders");
    expect((result as { details: { stale?: boolean } }).details.stale).toBeUndefined();
  });

  it("does not refresh a fresh cache", async () => {
    saveSchema(handle.db, "d1", snapshot("users"));

    const result = await execute({});
    expect(refreshMock.refreshDatasourceSchema).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("users");
  });

  it("falls back to a stale snapshot when refresh fails", async () => {
    saveSchema(handle.db, "d1", snapshot("legacy", Date.now() - SCHEMA_CACHE_TTL_MS - 1));
    refreshMock.refreshDatasourceSchema.mockRejectedValue(new Error("connection refused"));

    const result = await execute({});
    expect(textOf(result)).toContain("legacy");
    expect((result as { details: { stale?: boolean } }).details.stale).toBe(true);
  });

  it("returns a tool error when a cold refresh fails", async () => {
    refreshMock.refreshDatasourceSchema.mockRejectedValue(new Error("connection refused"));

    const result = await execute({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("SCHEMA_UNAVAILABLE");
    expect(textOf(result)).toContain("connection refused");
  });
});
