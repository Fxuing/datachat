import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATASOURCE_SDK_VERSION,
  defineDatasourceDriver,
  runDriverConformanceChecks,
  validateDatasourceDriver,
  type ResolvedConnectionConfig,
} from "@datachat/datasource-sdk";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { findDatasource } from "../src/db/repositories/datasources.js";
import { insertUser } from "../src/db/repositories/users.js";
import { DriverRegistry } from "../src/drivers/registry.js";
import { PoolRegistry } from "../src/agent/datasource/pool.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { runGuardedQuery } from "../src/services/query-service.js";
import { rewriteSqlForScope } from "../src/agent/sql/scope.js";
import { testConfig } from "./helpers/config.js";

let tmpDir: string;
let db: Db;
let closeDb: () => void;
let adminCookie: string;
let adminId: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-plugin-test-"));
  const handle = createDb(path.join(tmpDir, "app.db"));
  db = handle.db;
  closeDb = () => handle.sqlite.close();
  migrateDb(db);

  const hash = await hashPassword("secret");
  const now = Date.now();
  const admin = insertUser(db, {
    id: randomUUID(),
    username: "root",
    passwordHash: hash,
    role: "admin",
    createdAt: now,
  });
  adminId = admin.id;
  const signer = createSessionSigner(testConfig.appSecret);
  adminCookie = await signer.sign({ sub: admin.id, username: admin.username, role: admin.role });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("datasource driver plugin architecture", () => {
  it("loads an external plugin module from disk and rejects duplicate built-in ids", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const registry = new DriverRegistry();
    const loaded = await registry.loadExternalPlugins(
      ["./examples/driver-clickhouse/index.mjs", "./examples/driver-trino/index.mjs"],
      {
        strict: true,
        baseDir: repoRoot,
      },
    );
    expect(loaded.loaded).toEqual(["clickhouse", "trino"]);
    expect(registry.has("clickhouse")).toBe(true);
    expect(registry.has("trino")).toBe(true);
    expect(registry.listPublic().map((d) => d.id)).toEqual([
      "mysql",
      "postgres",
      "clickhouse",
      "trino",
    ]);

    expect(validateDatasourceDriver(registry.get("clickhouse")).ok).toBe(true);
    expect(validateDatasourceDriver(registry.get("trino")).ok).toBe(true);

    // Overriding a built-in driver id is rejected.
    expect(() =>
      registry.register({
        manifest: {
          sdkVersion: DATASOURCE_SDK_VERSION,
          id: "mysql",
          label: "Fake MySQL",
          connectionMode: "network",
          defaultPort: 3306,
          supportsSsl: false,
          optionsSchema: [],
          capabilities: { explain: true, readOnlyProbe: true, rowScope: true },
        },
        dialect: { parserDialect: "mysql", placeholderStyle: "qmark", quoteChar: "`" },
        probe: async () => ({ ok: true, readOnly: true, warnings: [] }),
        createPool: () => ({
          introspect: async () => ({ tables: [], refreshedAt: Date.now() }),
          executeQuery: async () => undefined,
          close: async () => undefined,
        }),
      }),
    ).toThrow(/冲突/);
  });

  it("encrypts secret plugin options, runs guarded queries, enforces extra guard rules, and degrades cleanly when uninstalled", async () => {
    const receivedConfigs: ResolvedConnectionConfig[] = [];
    const customDriver = defineDatasourceDriver({
      manifest: {
        sdkVersion: DATASOURCE_SDK_VERSION,
        id: "clickhouse",
        label: "ClickHouse",
        connectionMode: "network",
        defaultPort: 8123,
        supportsSsl: true,
        optionsSchema: [
          {
            key: "protocol",
            label: "协议",
            type: "select",
            defaultValue: "http",
            options: [
              { value: "http", label: "HTTP" },
              { value: "https", label: "HTTPS" },
            ],
          },
          { key: "apiToken", label: "访问令牌", type: "text", secret: true, required: true },
        ],
        capabilities: { explain: false, readOnlyProbe: true, rowScope: false },
      },
      dialect: {
        parserDialect: "mysql",
        placeholderStyle: "qmark",
        quoteChar: "`",
        extraForbiddenFunctions: ["url", "s3"],
        extraSystemSchemas: ["system"],
      },
      async probe(cfg) {
        receivedConfigs.push(cfg);
        return { ok: true, serverVersion: "24.8", readOnly: true, warnings: [] };
      },
      createPool(cfg) {
        receivedConfigs.push(cfg);
        return {
          async introspect() {
            return {
              tables: [
                {
                  schema: "analytics",
                  name: "events",
                  comment: "埋点事件",
                  rowEstimate: 100,
                  columns: [
                    { name: "id", type: "UInt64", nullable: false, defaultValue: null, comment: null },
                  ],
                  primaryKey: ["id"],
                  indexes: [],
                  foreignKeys: [],
                },
              ],
              refreshedAt: Date.now(),
            };
          },
          async executeQuery(_req, emitBatch) {
            await emitBatch({
              columns: [{ name: "cnt", type: "number" }],
              rows: [[123]],
            });
          },
          async close() {},
        };
      },
    });

    const drivers = new DriverRegistry();
    drivers.register(customDriver);
    const pools = new PoolRegistry(drivers);
    const artifacts = new ArtifactStore(db, path.join(tmpDir, "artifacts"));
    await artifacts.init();

    const app = await buildApp({
      config: { ...testConfig, dataDir: tmpDir },
      db,
      enableRateLimit: false,
      drivers,
      pools,
      artifacts,
    });

    try {
      // GET /api/datasources/drivers exposes the plugin descriptor.
      const driversRes = await app.inject({
        method: "GET",
        url: "/api/datasources/drivers",
        cookies: { dc_session: adminCookie },
      });
      expect(driversRes.statusCode).toBe(200);
      const driverList = (driversRes.json() as { drivers: Array<{ id: string; builtin: boolean }> }).drivers;
      expect(driverList.find((d) => d.id === "clickhouse")?.builtin).toBe(false);

      const conformance = await runDriverConformanceChecks({
        driver: drivers.get("clickhouse")!,
        config: {
          id: "ck-conformance",
          type: "clickhouse",
          host: "127.0.0.1",
          port: 8123,
          database: "analytics",
          username: "ro",
          password: "pw",
          sslMode: "disable",
          options: { protocol: "https", apiToken: "super-secret-token" },
        },
      });
      expect(conformance.ok).toBe(true);

      // Creating a datasource validates required secret options and encrypts them at rest.
      const createRes = await app.inject({
        method: "POST",
        url: "/api/datasources",
        cookies: { dc_session: adminCookie },
        payload: {
          name: "CK 埋点库",
          type: "clickhouse",
          host: "127.0.0.1",
          port: 8123,
          database: "analytics",
          username: "ro",
          password: "pw",
          sslMode: "disable",
          options: { protocol: "https", apiToken: "super-secret-token" },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const dsId = (createRes.json() as { id: string }).id;

      const rawRow = findDatasource(db, dsId)!;
      expect(rawRow.optionsJson).not.toContain("super-secret-token");
      expect(rawRow.optionsJson).toContain("__enc");

      // GET /api/datasources never returns secret values, only non-secret options + secretOptionKeys.
      const listRes = await app.inject({
        method: "GET",
        url: "/api/datasources",
        cookies: { dc_session: adminCookie },
      });
      const listed = (
        listRes.json() as {
          datasources: Array<{
            id: string;
            driverLabel: string;
            driverAvailable: boolean;
            options: Record<string, unknown>;
            secretOptionKeys: string[];
          }>;
        }
      ).datasources.find((d) => d.id === dsId)!;
      expect(listed.driverLabel).toBe("ClickHouse");
      expect(listed.driverAvailable).toBe(true);
      expect(listed.options).toEqual({ protocol: "https" });
      expect(listed.secretOptionKeys).toEqual(["apiToken"]);

      // Extra forbidden function and system schema declared by plugin are blocked by core guardSql.
      const blockedFn = await runGuardedQuery(
        { db, config: { ...testConfig, dataDir: tmpDir }, pools, artifacts, drivers },
        { datasource: rawRow, userId: adminId, conversationId: null, runId: null, sql: "SELECT url('http://evil')" },
      );
      expect(blockedFn.ok).toBe(false);
      if (!blockedFn.ok) expect(blockedFn.code).toBe("FORBIDDEN_CONSTRUCT");

      const blockedSys = await runGuardedQuery(
        { db, config: { ...testConfig, dataDir: tmpDir }, pools, artifacts, drivers },
        { datasource: rawRow, userId: adminId, conversationId: null, runId: null, sql: "SELECT name FROM system.tables" },
      );
      expect(blockedSys.ok).toBe(false);
      if (!blockedSys.ok) expect(blockedSys.code).toBe("FORBIDDEN_CONSTRUCT");

      // Valid read-only SELECT runs through the plugin pool and streams into an artifact.
      const okRes = await runGuardedQuery(
        { db, config: { ...testConfig, dataDir: tmpDir }, pools, artifacts, drivers },
        { datasource: rawRow, userId: adminId, conversationId: null, runId: null, sql: "SELECT COUNT(*) AS cnt FROM events" },
      );
      expect(okRes.ok).toBe(true);
      if (okRes.ok) {
        expect(okRes.previewRows).toEqual([[123]]);
      }
      // Driver received decrypted apiToken.
      expect(receivedConfigs.at(-1)?.options.apiToken).toBe("super-secret-token");

      // Enabling row-level scope on a driver with rowScope=false fails closed.
      const scopeEnable = await app.inject({
        method: "POST",
        url: `/api/admin/datasources/${dsId}/scope/enable`,
        cookies: { dc_session: adminCookie },
      });
      expect(scopeEnable.statusCode).toBe(400);
      expect((scopeEnable.json() as { error: { code: string } }).error.code).toBe(
        "SCOPE_UNSUPPORTED_BY_DRIVER",
      );

      // When the plugin is uninstalled on next boot, queries and tests fail closed with DRIVER_NOT_INSTALLED.
      const bareDrivers = new DriverRegistry();
      const missingRes = await runGuardedQuery(
        { db, config: { ...testConfig, dataDir: tmpDir }, pools: new PoolRegistry(bareDrivers), artifacts, drivers: bareDrivers },
        { datasource: rawRow, userId: adminId, conversationId: null, runId: null, sql: "SELECT 1" },
      );
      expect(missingRes.ok).toBe(false);
      if (!missingRes.ok) expect(missingRes.code).toBe("DRIVER_NOT_INSTALLED");
    } finally {
      await app.close();
    }
  });

  it("supports custom placeholder styles (@p1 and :1) in row-level scope rewrites", () => {
    const plan = {
      tables: new Map([
        [
          "orders",
          {
            kind: "scoped" as const,
            conditions: [
              { column: "dept_id", operator: "in" as const, values: ["d1", "d2"], nullVisible: false },
            ],
          },
        ],
      ]),
    };

    const mssql = rewriteSqlForScope(
      "SELECT id FROM orders",
      { parserDialect: "transactsql", placeholderStyle: "at", quoteChar: "[" },
      plan,
    );
    expect(mssql.sql.toLowerCase()).toContain("@p1");
    expect(mssql.sql.toLowerCase()).toContain("@p2");
    expect(mssql.params).toEqual(["d1", "d2"]);

    const oracle = rewriteSqlForScope(
      "SELECT id FROM orders",
      { parserDialect: "postgresql", placeholderStyle: "colon", quoteChar: '"' },
      plan,
    );
    expect(oracle.sql).toContain(":1");
    expect(oracle.sql).toContain(":2");
    expect(oracle.params).toEqual(["d1", "d2"]);
  });
});
