import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";

const SOURCE_MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));
const JOURNAL_PATH = path.join(SOURCE_MIGRATIONS_DIR, "meta", "_journal.json");

/** Copies migrations up to 0009 so a legacy DB can be seeded before RBAC exists. */
function makePreRbacMigrationsDir(root: string): string {
  const folder = path.join(root, "drizzle-pre-rbac");
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 9);
  for (const entry of journal.entries) {
    fs.copyFileSync(
      path.join(SOURCE_MIGRATIONS_DIR, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`),
    );
  }
  fs.writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  return folder;
}

describe("rbac schema", () => {
  it("seeds the built-in member role with all functional permissions", () => {
    const handle = createDb(":memory:");
    migrateDb(handle.db);
    const role = handle.sqlite
      .prepare("SELECT id, name, builtin FROM roles WHERE id = 'role_member'")
      .get() as { id: string; name: string; builtin: number } | undefined;
    expect(role).toEqual({ id: "role_member", name: "成员", builtin: 1 });
    const permissions = handle.sqlite
      .prepare("SELECT permission FROM role_permissions WHERE role_id = 'role_member' ORDER BY permission")
      .all() as { permission: string }[];
    expect(permissions.map((row) => row.permission)).toEqual([
      "chat.use",
      "export.data",
      "mcp.use",
      "report.create",
      "share.create",
      "skill.use",
    ]);
    handle.sqlite.close();
  });

  it("backfills role_member for legacy users and leaves admins alone", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-rbac-backfill-"));
    const handle = createDb(":memory:");
    try {
      migrateDb(handle.db, { migrationsFolder: makePreRbacMigrationsDir(root) });
      insertUser(handle.db, {
        id: "user-legacy-member",
        username: "legacy-member",
        passwordHash: "$argon2id$fake",
        role: "user",
        createdAt: Date.now(),
      });
      insertUser(handle.db, {
        id: "user-legacy-admin",
        username: "legacy-admin",
        passwordHash: "$argon2id$fake",
        role: "admin",
        createdAt: Date.now(),
      });
      handle.sqlite
        .prepare(
          `INSERT INTO query_audit
            (id, action, sql_text, sql_hash, status, row_count, created_at)
           VALUES ('audit-legacy', 'query', 'SELECT 1', 'hash-legacy', 'ok', 1, 1)`,
        )
        .run();

      migrateDb(handle.db, { migrationsFolder: SOURCE_MIGRATIONS_DIR });

      const memberRoles = handle.sqlite
        .prepare("SELECT user_id FROM user_roles WHERE role_id = 'role_member' ORDER BY user_id")
        .all() as Array<{ user_id: string }>;
      expect(memberRoles.map((row) => row.user_id)).toEqual(["user-legacy-member"]);

      const permissions = handle.sqlite
        .prepare(
          "SELECT permission FROM role_permissions WHERE role_id = 'role_member' ORDER BY permission",
        )
        .all() as Array<{ permission: string }>;
      expect(permissions.map((row) => row.permission)).toEqual([
        "chat.use",
        "export.data",
        "mcp.use",
        "report.create",
        "share.create",
        "skill.use",
      ]);

      // 0011 rebuilds query_audit; existing rows must survive verbatim.
      const audit = handle.sqlite
        .prepare("SELECT id, action, sql_text, sql_hash, status, row_count FROM query_audit WHERE id = 'audit-legacy'")
        .get();
      expect(audit).toEqual({
        id: "audit-legacy",
        action: "query",
        sql_text: "SELECT 1",
        sql_hash: "hash-legacy",
        status: "ok",
        row_count: 1,
      });
    } finally {
      handle.sqlite.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds role_change to the audit action check", () => {
    const handle = createDb(":memory:");
    migrateDb(handle.db);
    const row = handle.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'query_audit'")
      .get() as { sql: string };
    expect(row.sql).toContain("'role_change'");
    handle.sqlite.close();
  });
});
