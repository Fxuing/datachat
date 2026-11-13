import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";

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
