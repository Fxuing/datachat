import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeUsername } from "@datachat/shared";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  countAdmins,
  countUsers,
  DuplicateUsernameError,
  findUserByUsername,
  insertUser,
  toPublicUser,
} from "../src/db/repositories/users.js";
import { bootstrapAdmin } from "../src/auth/bootstrap.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import type { AppConfig } from "../src/config.js";
import { testConfig } from "./helpers/config.js";

const SOURCE_MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));
const JOURNAL_PATH = path.join(SOURCE_MIGRATIONS_DIR, "meta", "_journal.json");

const APP_TABLES = [
  "artifacts",
  "conversations",
  "datasource_grants",
  "datasource_schema_cache",
  "datasources",
  "llm_providers",
  "mcp_servers",
  "notifications",
  "query_audit",
  "reports",
  "role_datasource_grants",
  "role_permissions",
  "roles",
  "run_feedback",
  "run_events",
  "runs",
  "scheduled_task_runs",
  "scheduled_tasks",
  "settings",
  "shares",
  "skills",
  "user_memories",
  "user_memory_settings",
  "user_roles",
  "users",
];

const INTEGRITY_INDEXES: Record<string, string[]> = {
  artifacts: ["artifacts_run_idx", "artifacts_user_idx"],
  conversations: ["conversations_user_last_message_idx"],
  datasource_grants: [
    "datasource_grants_datasource_user_unique",
    "datasource_grants_user_idx",
  ],
  datasources: ["datasources_name_nocase_unique"],
  query_audit: [
    "query_audit_datasource_created_idx",
    "query_audit_created_idx",
  ],
  role_datasource_grants: ["role_datasource_grants_datasource_idx"],
  roles: ["roles_name_unique"],
  user_roles: ["user_roles_role_idx"],
  run_events: ["run_events_conversation_seq_idx", "run_events_run_seq_unique"],
  runs: ["runs_conversation_idx", "runs_conversation_created_idx"],
  users: ["users_username_nocase_unique"],
};

let dataDir: string;
let config: AppConfig;
let handles: DbHandle[] = [];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-db-test-"));
  config = {
    ...testConfig,
    dataDir,
    dbPath: path.join(dataDir, "datachat.db"),
    adminPassword: "admin-password",
  };
});

afterEach(() => {
  // Close every handle before deleting the temp dir, otherwise Windows keeps the
  // WAL/SHM files locked and rmSync fails.
  for (const handle of handles) {
    try {
      handle.sqlite.close();
    } catch {
      // already closed by the test
    }
  }
  handles = [];
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function openDb(): DbHandle {
  const handle = createDb(config.dbPath);
  handles.push(handle);
  migrateDb(handle.db);
  return handle;
}

function tableNames(sqlite: DbHandle["sqlite"]): string[] {
  const rows = sqlite
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexNames(sqlite: DbHandle["sqlite"]): string[] {
  const rows = sqlite
    .prepare("select name from sqlite_master where type = 'index' order by name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexList(sqlite: DbHandle["sqlite"], table: string): string[] {
  const rows = sqlite.pragma(`index_list("${table}")`) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function assertIntegrityIndexes(sqlite: DbHandle["sqlite"]): void {
  for (const [table, expected] of Object.entries(INTEGRITY_INDEXES)) {
    expect(indexList(sqlite, table), `indexes on ${table}`).toEqual(
      expect.arrayContaining(expected),
    );
  }
}

function columnNames(sqlite: DbHandle["sqlite"], table: string): string[] {
  const rows = sqlite.prepare(`pragma table_info("${table}")`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function countAppliedMigrations(sqlite: DbHandle["sqlite"]): number {
  const row = sqlite.prepare("select count(*) as count from __drizzle_migrations").get() as {
    count: number;
  };
  return row.count;
}

function insertRawUser(
  sqlite: DbHandle["sqlite"],
  input: { id: string; username: string; role?: string },
): void {
  sqlite
    .prepare(
      "insert into users (id, username, password_hash, role, status, created_at) values (?, ?, ?, ?, ?, ?)",
    )
    .run(input.id, input.username, "$argon2id$fake", input.role ?? "user", "active", Date.now());
}

/** Migrations folder containing only 0000, used to simulate an existing pre-hardening DB. */
function makeV0MigrationsDir(): string {
  const folder = path.join(dataDir, "drizzle-v0");
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  const v0File = fs
    .readdirSync(SOURCE_MIGRATIONS_DIR)
    .find((name) => /^0000_.*\.sql$/.test(name));
  if (!v0File) throw new Error("0000 migration file not found");
  fs.copyFileSync(path.join(SOURCE_MIGRATIONS_DIR, v0File), path.join(folder, v0File));

  const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: Array<{ idx: number }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx === 0);
  fs.writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  return folder;
}

describe("database lifecycle", () => {
  it("runs migrations, creates all app tables, and hardens the connection", () => {
    const { db, sqlite } = openDb();

    expect(tableNames(sqlite)).toEqual(expect.arrayContaining(APP_TABLES));
    assertIntegrityIndexes(sqlite);
    expect(columnNames(sqlite, "datasources")).toContain("options_json");
    expect(columnNames(sqlite, "artifacts")).toEqual(
      expect.arrayContaining(["user_id", "conversation_id"]),
    );
    expect(columnNames(sqlite, "runs")).toContain("retry_of_run_id");
    expect(columnNames(sqlite, "runs")).toContain("memory_extracted_at");
    expect(columnNames(sqlite, "conversations")).toContain("kind");
    expect(columnNames(sqlite, "query_audit")).toEqual(
      expect.arrayContaining(["detail_json", "user_id", "datasource_id"]),
    );
    const artifactColumns = sqlite.pragma("table_info(\"artifacts\")") as Array<{
      name: string;
      notnull: number;
    }>;
    expect(artifactColumns.find((column) => column.name === "conversation_id")?.notnull).toBe(0);
    const auditColumns = sqlite.pragma("table_info(\"query_audit\")") as Array<{
      name: string;
      notnull: number;
    }>;
    expect(auditColumns.find((column) => column.name === "user_id")?.notnull).toBe(0);
    expect(auditColumns.find((column) => column.name === "datasource_id")?.notnull).toBe(0);

    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(countUsers(db)).toBe(0);
  });

  it("enforces case-insensitive datasource names and extended audit actions", () => {
    const { sqlite } = openDb();
    const insertDatasource = sqlite.prepare(
      `insert into datasources
        (id, name, type, host, port, database, username, password_cipher, created_by, created_at, updated_at)
       values (?, ?, 'mysql', '127.0.0.1', 3306, 'analytics', 'app', 'cipher', 'admin', 1, 1)`,
    );
    insertDatasource.run("ds-1", "Analytics");
    expect(() => insertDatasource.run("ds-2", "analytics")).toThrow(/UNIQUE constraint failed/);

    const insertAudit = sqlite.prepare(
      `insert into query_audit (id, action, sql_text, sql_hash, status, created_at)
       values (?, ?, '', 'hash', 'ok', 1)`,
    );
    insertAudit.run("audit-1", "login_failed");
    insertAudit.run("audit-2", "skill_change");
    insertAudit.run("audit-4", "mcp_change");
    expect(() => insertAudit.run("audit-3", "not-an-action")).toThrow(/CHECK constraint failed/);
  });

  it("is idempotent when migrations run twice", () => {
    const handle = openDb();
    const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8")) as {
      entries: unknown[];
    };
    const expected = journal.entries.length;

    expect(countAppliedMigrations(handle.sqlite)).toBe(expected);
    const before = tableNames(handle.sqlite);

    const applied = migrateDb(handle.db);

    expect(applied).toBe(expected);
    expect(countAppliedMigrations(handle.sqlite)).toBe(expected);
    expect(tableNames(handle.sqlite)).toEqual(before);
  });

  it("upgrades a database created by migration 0000", () => {
    const handle = createDb(config.dbPath);
    handles.push(handle);

    const v0Dir = makeV0MigrationsDir();
    expect(migrateDb(handle.db, { migrationsFolder: v0Dir })).toBe(1);
    insertRawUser(handle.sqlite, { id: "legacy-admin", username: "legacy", role: "admin" });

    expect(migrateDb(handle.db)).toBe(14);
    expect(migrateDb(handle.db)).toBe(14);

    expect(findUserByUsername(handle.db, "legacy")?.id).toBe("legacy-admin");
    expect(indexNames(handle.sqlite)).toContain("users_username_nocase_unique");
    assertIntegrityIndexes(handle.sqlite);
    expect(columnNames(handle.sqlite, "datasources")).toContain("options_json");
    expect(columnNames(handle.sqlite, "datasources")).toContain("allow_write_account");
    expect(() =>
      insertRawUser(handle.sqlite, { id: "bad", username: "bad", role: "superadmin" }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("fails with a path-aware error when the migrations journal is missing", () => {
    const handle = createDb(config.dbPath);
    handles.push(handle);
    const missing = path.join(dataDir, "no-migrations");

    expect(() => migrateDb(handle.db, { migrationsFolder: missing })).toThrow(
      /meta[/\\]_journal\.json/,
    );
    expect(() => migrateDb(handle.db, { migrationsFolder: missing })).toThrow(missing);
  });
});

describe("bootstrapAdmin", () => {
  it("seeds one admin once, keeps its password, and logs only the username", async () => {
    const { db } = openDb();
    const logs: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const logger = {
      info(fields: Record<string, unknown>, message: string) {
        logs.push({ fields, message });
      },
    };

    await bootstrapAdmin(db, config, logger);
    const first = findUserByUsername(db, config.adminUsername);
    expect(first).toBeDefined();
    expect(first?.role).toBe("admin");
    expect(first?.status).toBe("active");
    expect(first?.displayName).toBe("管理员");
    expect(logs[0]?.fields).toEqual({ username: "admin" });
    expect(JSON.stringify(logs)).not.toContain("admin-password");

    await bootstrapAdmin(db, config, logger);
    expect(countAdmins(db)).toBe(1);
    expect(findUserByUsername(db, config.adminUsername)?.passwordHash).toBe(first?.passwordHash);

    // A later run with a different ADMIN_PASSWORD must not overwrite the stored hash.
    await bootstrapAdmin(db, { ...config, adminPassword: "another-password" }, logger);
    expect(countAdmins(db)).toBe(1);
    const second = findUserByUsername(db, config.adminUsername);
    expect(second?.passwordHash).toBe(first?.passwordHash);
    expect(await verifyPassword(second!.passwordHash, "admin-password")).toBe(true);
    expect(await verifyPassword(second!.passwordHash, "another-password")).toBe(false);
    expect(logs.at(-1)?.message).toMatch(/skipped/);
  });

  it("gates on the admin count, not the total user count", async () => {
    const { db } = openDb();
    insertUser(db, {
      id: "regular-user",
      username: "alice",
      passwordHash: "not-used-here",
      role: "user",
      createdAt: Date.now(),
    });
    expect(countUsers(db)).toBe(1);
    expect(countAdmins(db)).toBe(0);

    await expect(bootstrapAdmin(db, { ...config, adminPassword: undefined })).rejects.toThrow(
      /ADMIN_PASSWORD/,
    );

    await bootstrapAdmin(db, config);
    expect(countAdmins(db)).toBe(1);
    expect(countUsers(db)).toBe(2);
  });

  it("refuses to bootstrap an empty database without ADMIN_PASSWORD", async () => {
    const { db } = openDb();
    await expect(bootstrapAdmin(db, { ...config, adminPassword: undefined })).rejects.toThrow(
      /ADMIN_PASSWORD/,
    );
    expect(countUsers(db)).toBe(0);
  });
});

describe("users repository", () => {
  it("normalizes usernames at the DB boundary", () => {
    const { db } = openDb();
    const inserted = insertUser(db, {
      id: "u1",
      username: "  Admin ",
      passwordHash: "$argon2id$fake",
      role: "admin",
      createdAt: Date.now(),
    });

    expect(inserted.username).toBe("admin");
    expect(findUserByUsername(db, "ADMIN")?.id).toBe("u1");
    expect(normalizeUsername("  MiXeD ")).toBe("mixed");
  });

  it("rejects duplicate usernames through the repository and at the SQLite level", () => {
    const { db, sqlite } = openDb();
    insertUser(db, {
      id: "u1",
      username: "admin",
      passwordHash: "$argon2id$fake",
      role: "admin",
      createdAt: Date.now(),
    });

    expect(() =>
      insertUser(db, {
        id: "u2",
        username: " Admin ",
        passwordHash: "$argon2id$fake",
        role: "user",
        createdAt: Date.now(),
      }),
    ).toThrow(DuplicateUsernameError);

    // Bypass normalizeUsername entirely: the NOCASE unique index still rejects it.
    expect(() => insertRawUser(sqlite, { id: "u3", username: "Admin" })).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(countUsers(db)).toBe(1);
  });

  it("projects the public user shape without passwordHash", () => {
    const { db } = openDb();
    insertUser(db, {
      id: "u1",
      username: "admin",
      passwordHash: "$argon2id$fake",
      role: "admin",
      createdAt: Date.now(),
    });
    const row = findUserByUsername(db, "admin");
    expect(row).toBeDefined();

    const publicUser = toPublicUser(row!);

    expect(Object.keys(publicUser).sort()).toEqual([
      "displayName",
      "id",
      "role",
      "status",
      "username",
    ]);
    expect(publicUser).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(publicUser)).not.toContain("passwordHash");
  });
});

describe("password helpers", () => {
  it("hashes with argon2id and verifies only matching passwords", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");
    expect(passwordHash.startsWith("$argon2id$")).toBe(true);

    expect(await verifyPassword(passwordHash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(passwordHash, "wrong password")).toBe(false);
  });

  it("returns false for empty and malformed hashes instead of throwing", async () => {
    expect(await verifyPassword("", "whatever")).toBe(false);
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
    expect(await verifyPassword("$argon2id$v=19$m=1,t=1,p=1$not$valid", "whatever")).toBe(false);
  });
});

describe("data integrity constraints", () => {
  it("enforces the users role check", () => {
    const { sqlite } = openDb();
    insertRawUser(sqlite, { id: "u1", username: "admin", role: "admin" });
    expect(() => insertRawUser(sqlite, { id: "u2", username: "user", role: "superadmin" })).toThrow(
      /CHECK constraint failed/,
    );
  });

  it("enforces unique datasource grants and run event sequence numbers", () => {
    const { sqlite } = openDb();
    const insertGrant = sqlite.prepare(
      "insert into datasource_grants (id, datasource_id, user_id, created_at) values (?, ?, ?, ?)",
    );
    insertGrant.run("g1", "ds1", "u1", 1);
    expect(() => insertGrant.run("g2", "ds1", "u1", 2)).toThrow(/UNIQUE constraint failed/);
    insertGrant.run("g3", "ds1", "u2", 3);

    const insertEvent = sqlite.prepare(
      "insert into run_events (id, run_id, conversation_id, seq, type, payload_json, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    );
    insertEvent.run("e1", "r1", "c1", 1, "token", "{}", 1);
    expect(() => insertEvent.run("e2", "r1", "c1", 1, "token", "{}", 2)).toThrow(
      /UNIQUE constraint failed/,
    );
    insertEvent.run("e3", "r1", "c1", 2, "token", "{}", 3);
  });

  it("requires shares to target exactly one of conversation or report", () => {
    const { sqlite } = openDb();
    const insertShare = sqlite.prepare(
      "insert into shares (id, token_hash, conversation_id, report_id, created_by, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    );

    expect(() => insertShare.run("s1", "h1", null, null, "u1", 1, 1)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertShare.run("s2", "h2", "c1", "r1", "u1", 1, 1)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insertShare.run("s3", "h3", "c1", null, "u1", 1, 1)).not.toThrow();
    expect(() => insertShare.run("s4", "h4", null, "r1", "u1", 1, 1)).not.toThrow();
  });

  it("keeps skill scope and datasource_id consistent", () => {
    const { sqlite } = openDb();
    const insertSkill = sqlite.prepare(
      "insert into skills (id, scope, datasource_id, name, description, content, updated_by, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    expect(() => insertSkill.run("k1", "global", "ds1", "n", "d", "c", "u1", 1, 1)).toThrow(
      /CHECK constraint failed/,
    );
    expect(() =>
      insertSkill.run("k2", "datasource", null, "n", "d", "c", "u1", 1, 1),
    ).toThrow(/CHECK constraint failed/);
    expect(() => insertSkill.run("k3", "global", null, "n", "d", "c", "u1", 1, 1)).not.toThrow();
    expect(() =>
      insertSkill.run("k4", "datasource", "ds1", "n", "d", "c", "u1", 1, 1),
    ).not.toThrow();
  });
});
