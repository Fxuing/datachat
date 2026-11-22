import { describe, expect, it } from "vitest";
import {
  DATASOURCE_SDK_VERSION,
  defineDatasourceDriver,
  normalizeColumnType,
  runDriverConformanceChecks,
  safeDriverErrorMessage,
  validateDatasourceDriver,
} from "../src/index.js";

describe("@datachat/datasource-sdk", () => {
  it("normalizes common warehouse column types", () => {
    expect(normalizeColumnType("Int64")).toBe("number");
    expect(normalizeColumnType("Decimal(18, 2)")).toBe("number");
    expect(normalizeColumnType("DateTime64(3)")).toBe("date");
    expect(normalizeColumnType("VARCHAR(255)")).toBe("string");
    expect(normalizeColumnType("LowCardinality(String)")).toBe("string");
    expect(normalizeColumnType("JSONB")).toBe("json");
    expect(normalizeColumnType("BOOLEAN")).toBe("boolean");
    expect(normalizeColumnType("")).toBe("unknown");
  });

  it("scrubs multiple secrets from driver errors", () => {
    const err = new Error("auth failed for secret-pw and tok-123\nwith details");
    expect(safeDriverErrorMessage(err, ["secret-pw", "tok-123"])).toBe(
      "auth failed for *** and *** with details",
    );
  });

  it("validates manifests and rejects invalid ids or incompatible sdkVersion", () => {
    const badId = validateDatasourceDriver({
      manifest: {
        sdkVersion: DATASOURCE_SDK_VERSION,
        id: "Bad ID!",
        label: "Test",
        connectionMode: "network",
        defaultPort: 8123,
        supportsSsl: true,
        optionsSchema: [],
        capabilities: { explain: false, readOnlyProbe: false, rowScope: false },
      },
      dialect: { parserDialect: "mysql", placeholderStyle: "qmark", quoteChar: "`" },
      probe: async () => ({ ok: true, readOnly: false, warnings: [] }),
      createPool: () => ({
        introspect: async () => ({ tables: [], refreshedAt: Date.now() }),
        executeQuery: async () => undefined,
        close: async () => undefined,
      }),
    });
    expect(badId.ok).toBe(false);
  });

  it("passes conformance checks for a compliant in-memory driver", async () => {
    const driver = defineDatasourceDriver({
      manifest: {
        sdkVersion: DATASOURCE_SDK_VERSION,
        id: "mockdb",
        label: "MockDB",
        connectionMode: "network",
        defaultPort: 9000,
        supportsSsl: false,
        optionsSchema: [],
        capabilities: { explain: true, readOnlyProbe: true, rowScope: true },
      },
      dialect: { parserDialect: "mysql", placeholderStyle: "qmark", quoteChar: "`" },
      async probe(cfg) {
        if (cfg.password === "bad-secret") {
          return {
            ok: false,
            readOnly: false,
            warnings: [],
            error: safeDriverErrorMessage(new Error("wrong password bad-secret"), [cfg.password]),
          };
        }
        return { ok: true, serverVersion: "1.0.0", readOnly: true, warnings: [] };
      },
      createPool() {
        return {
          async introspect() {
            return { tables: [], refreshedAt: Date.now() };
          },
          async executeQuery(_req, emitBatch) {
            await emitBatch({
              columns: [{ name: "value", type: "number" }],
              rows: [[1]],
            });
          },
          async close() {},
        };
      },
    });

    const result = await runDriverConformanceChecks({
      driver,
      config: {
        id: "ds-1",
        type: "mockdb",
        host: "127.0.0.1",
        port: 9000,
        database: "demo",
        username: "ro",
        password: "good",
        sslMode: "disable",
        options: {},
      },
      invalidConfig: {
        id: "ds-1",
        type: "mockdb",
        host: "127.0.0.1",
        port: 9000,
        database: "demo",
        username: "ro",
        password: "bad-secret",
        sslMode: "disable",
        options: {},
      },
    });
    expect(result.ok).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });
});
