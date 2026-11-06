import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { countUsers, findUserByUsername } from "../src/db/repositories/users.js";
import { bootstrapAdmin } from "../src/auth/bootstrap.js";
import { verifyPassword } from "../src/auth/password.js";
import type { AppConfig } from "../src/config.js";

/** Absolute temp dir: mirrors the hardened config, which always resolves dataDir to an absolute path. */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-db-test-"));

const config: AppConfig = {
  port: 0,
  appSecret: "test-secret-test-secret-test-secret-32",
  dataDir,
  dbPath: ":memory:",
  logLevel: "silent",
  siliconflowBaseUrl: "https://api.siliconflow.cn/v1",
  adminUsername: "admin",
  adminPassword: "admin-password",
  isProduction: false,
};

const APP_TABLES = [
  "artifacts",
  "conversations",
  "datasource_grants",
  "datasource_schema_cache",
  "datasources",
  "mcp_servers",
  "query_audit",
  "reports",
  "run_events",
  "runs",
  "settings",
  "shares",
  "skills",
  "users",
];

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function openDb() {
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  return handle;
}

function tableNames(sqlite: ReturnType<typeof createDb>["sqlite"]): string[] {
  const rows = sqlite
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("database", () => {
  it("runs migrations and creates all app tables", () => {
    const { db, sqlite } = openDb();
    const names = tableNames(sqlite);
    expect(names).toEqual(expect.arrayContaining(APP_TABLES));
    expect(countUsers(db)).toBe(0);
    sqlite.close();
  });

  it("is idempotent when migrations run twice", () => {
    const { db, sqlite } = openDb();
    const before = tableNames(sqlite);
    migrateDb(db);
    expect(tableNames(sqlite)).toEqual(before);
    sqlite.close();
  });

  it("seeds one admin once and keeps its password", async () => {
    const { db, sqlite } = openDb();
    await bootstrapAdmin(db, config);
    const first = findUserByUsername(db, config.adminUsername);
    expect(first).toBeDefined();
    expect(first?.role).toBe("admin");
    expect(first?.status).toBe("active");
    expect(first?.displayName).toBe("管理员");

    await bootstrapAdmin(db, config);
    expect(countUsers(db)).toBe(1);
    expect(findUserByUsername(db, config.adminUsername)?.passwordHash).toBe(first?.passwordHash);

    // A later run with a different ADMIN_PASSWORD must not overwrite the stored hash.
    await bootstrapAdmin(db, { ...config, adminPassword: "another-password" });
    expect(countUsers(db)).toBe(1);
    const second = findUserByUsername(db, config.adminUsername);
    expect(second?.passwordHash).toBe(first?.passwordHash);
    expect(await verifyPassword(second!.passwordHash, "admin-password")).toBe(true);
    expect(await verifyPassword(second!.passwordHash, "another-password")).toBe(false);
    sqlite.close();
  });

  it("refuses to bootstrap an empty database without ADMIN_PASSWORD", async () => {
    const { db, sqlite } = openDb();
    await expect(bootstrapAdmin(db, { ...config, adminPassword: undefined })).rejects.toThrow(
      /ADMIN_PASSWORD/,
    );
    expect(countUsers(db)).toBe(0);
    sqlite.close();
  });
});
