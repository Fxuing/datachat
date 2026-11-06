import { beforeEach, describe, expect, it, vi } from "vitest";

const driverMocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  mysqlQuery: vi.fn(),
  mysqlEnd: vi.fn(async () => undefined),
  pgConnect: vi.fn(async () => undefined),
  pgQuery: vi.fn(),
  pgEnd: vi.fn(async () => undefined),
  pgConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("mysql2/promise", () => ({
  default: { createConnection: driverMocks.createConnection },
}));

vi.mock("pg", () => ({
  Client: class {
    constructor(config: Record<string, unknown>) {
      driverMocks.pgConfigs.push(config);
    }
    connect = driverMocks.pgConnect;
    end = driverMocks.pgEnd;
    query = driverMocks.pgQuery;
  },
}));

import { probeDatasource } from "../src/agent/datasource/probe.js";

const baseInput = {
  type: "mysql" as const,
  host: "db.internal",
  port: 3306,
  database: "app",
  username: "reader",
  password: "super-secret",
  sslMode: "disable" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  driverMocks.pgConfigs = [];
  driverMocks.createConnection.mockResolvedValue({
    query: driverMocks.mysqlQuery,
    end: driverMocks.mysqlEnd,
  });
  driverMocks.pgConnect.mockResolvedValue(undefined);
  driverMocks.pgEnd.mockResolvedValue(undefined);
  driverMocks.mysqlEnd.mockResolvedValue(undefined);
});

describe("probeDatasource", () => {
  it("detects a read-only mysql account", async () => {
    driverMocks.mysqlQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("VERSION()")) return [[{ version: "8.0.36" }], []];
      if (sql.includes("SHOW GRANTS")) {
        return [[{ "Grants for reader@%": "GRANT SELECT ON `app`.* TO `reader`@`%`" }], []];
      }
      return [[], []];
    });

    const result = await probeDatasource(baseInput);
    expect(result).toMatchObject({ ok: true, serverVersion: "8.0.36", readOnly: true });
    expect(result.warnings).toEqual([]);
    expect(driverMocks.mysqlEnd).toHaveBeenCalled();
  });

  it("warns about write grants on mysql", async () => {
    driverMocks.mysqlQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("VERSION()")) return [[{ version: "8.0.36" }], []];
      if (sql.includes("SHOW GRANTS")) {
        return [[{ grants: "GRANT ALL PRIVILEGES ON *.* TO `reader`@`%`" }], []];
      }
      return [[], []];
    });

    const result = await probeDatasource(baseInput);
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  it("returns a scrubbed error when mysql is unreachable", async () => {
    driverMocks.createConnection.mockRejectedValueOnce(
      new Error("Access denied for super-secret"),
    );
    const result = await probeDatasource(baseInput);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Access denied for ***");
  });

  it("verifies TLS certificates for require and only skips verification for no-verify", async () => {
    driverMocks.mysqlQuery.mockResolvedValue([[], []]);
    driverMocks.pgQuery.mockResolvedValue({ rows: [] });

    await probeDatasource({ ...baseInput, sslMode: "require" });
    expect(driverMocks.createConnection.mock.calls[0]?.[0]).toMatchObject({
      ssl: { rejectUnauthorized: true },
    });

    await probeDatasource({ ...baseInput, sslMode: "no-verify" });
    expect(driverMocks.createConnection.mock.calls[1]?.[0]).toMatchObject({
      ssl: { rejectUnauthorized: false },
    });

    await probeDatasource({ ...baseInput, type: "postgres", port: 5432, sslMode: "require" });
    expect(driverMocks.pgConfigs[0]).toMatchObject({ ssl: { rejectUnauthorized: true } });
    await probeDatasource({ ...baseInput, type: "postgres", port: 5432, sslMode: "no-verify" });
    expect(driverMocks.pgConfigs[1]).toMatchObject({ ssl: { rejectUnauthorized: false } });
  });

  it("reports postgres session read-only state", async () => {
    driverMocks.pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT version()")) {
        return { rows: [{ version: "PostgreSQL 16.2" }] };
      }
      if (sql.includes("SHOW default_transaction_read_only")) {
        return { rows: [{ default_transaction_read_only: "on" }] };
      }
      if (sql.includes("has_database_privilege")) {
        return { rows: [{ can_create: false }] };
      }
      return { rows: [] };
    });

    const result = await probeDatasource({ ...baseInput, type: "postgres", port: 5432 });
    expect(result).toMatchObject({ ok: true, serverVersion: "PostgreSQL 16.2", readOnly: true });
    expect(driverMocks.pgConfigs[0]).toMatchObject({ host: "db.internal", port: 5432 });
    expect(driverMocks.pgEnd).toHaveBeenCalled();
  });

  it("warns when postgres can create tables and scrubs failures", async () => {
    driverMocks.pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT version()")) return { rows: [{ version: "PostgreSQL 16.2" }] };
      if (sql.includes("SHOW default_transaction_read_only")) {
        return { rows: [{ default_transaction_read_only: "off" }] };
      }
      if (sql.includes("has_database_privilege")) {
        return { rows: [{ can_create: true }] };
      }
      return { rows: [] };
    });

    const writeResult = await probeDatasource({ ...baseInput, type: "postgres", port: 5432 });
    expect(writeResult.readOnly).toBe(false);
    expect(writeResult.warnings).toHaveLength(1);

    driverMocks.pgConnect.mockRejectedValueOnce(new Error("bad password super-secret"));
    const failed = await probeDatasource({ ...baseInput, type: "postgres", port: 5432 });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("bad password ***");
  });
});
