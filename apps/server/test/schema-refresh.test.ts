import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";
import type { SchemaSnapshot } from "../src/agent/datasource/introspect.js";
import type { PoolRegistry } from "../src/agent/datasource/pool.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { findDatasource, insertDatasource } from "../src/db/repositories/datasources.js";
import { loadSchemaEntry } from "../src/db/repositories/schema-cache.js";
import {
  SchemaRefreshError,
  refreshDatasourceSchema,
} from "../src/services/schema-refresh.js";
import { testConfig } from "./helpers/config.js";

const snapshot: SchemaSnapshot = {
  refreshedAt: Date.now(),
  tables: [
    {
      schema: "app",
      name: "orders",
      comment: null,
      rowEstimate: 1,
      columns: [],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    },
  ],
};

let db: Db;
let datasourceId: string;

beforeEach(() => {
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  datasourceId = randomUUID();
  insertDatasource(db, {
    id: datasourceId,
    name: "analytics",
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "app",
    username: "reader",
    passwordCipher: encryptSecret("super-secret", deriveSecretKey(testConfig.appSecret)),
    createdBy: randomUUID(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
});

function deps(introspect: () => Promise<SchemaSnapshot>) {
  return {
    db,
    pools: {} as PoolRegistry,
    config: testConfig,
    introspect,
  };
}

describe("refreshDatasourceSchema", () => {
  it("shares one introspection between concurrent callers", async () => {
    let release: (value: SchemaSnapshot) => void = () => undefined;
    const introspect = vi.fn(
      () =>
        new Promise<SchemaSnapshot>((resolve) => {
          release = resolve;
        }),
    );
    const datasource = findDatasource(db, datasourceId)!;

    const first = refreshDatasourceSchema(deps(introspect), datasource);
    const second = refreshDatasourceSchema(deps(introspect), datasource);
    release(snapshot);

    await expect(Promise.all([first, second])).resolves.toEqual([snapshot, snapshot]);
    expect(introspect).toHaveBeenCalledTimes(1);
    expect(loadSchemaEntry(db, datasourceId)?.snapshot.tables[0]?.name).toBe("orders");
  });

  it("records a scrubbed error and allows a later retry", async () => {
    const datasource = findDatasource(db, datasourceId)!;
    const failing = vi
      .fn<() => Promise<SchemaSnapshot>>()
      .mockRejectedValueOnce(new Error("connect failed password=super-secret"))
      .mockResolvedValueOnce(snapshot);

    await expect(refreshDatasourceSchema(deps(failing), datasource)).rejects.toBeInstanceOf(
      SchemaRefreshError,
    );
    expect(loadSchemaEntry(db, datasourceId)?.error ?? "").not.toContain("super-secret");

    await expect(refreshDatasourceSchema(deps(failing), datasource)).resolves.toEqual(snapshot);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(loadSchemaEntry(db, datasourceId)?.error).toBeNull();
  });
});
