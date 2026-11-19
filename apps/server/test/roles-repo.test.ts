import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import {
  createRole,
  deleteRole,
  findRole,
  findRoleByName,
  listRoleIdsForUser,
  listRolePermissions,
  listRoles,
  listRolesForUser,
  permissionsForUserRoles,
  replaceRolePermissions,
  roleDetail,
  setUserRoles,
  UnknownRoleError,
  updateRole,
} from "../src/db/repositories/roles.js";

function setup(): Db {
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  return handle.db;
}

describe("roles repository", () => {
  it("creates, edits, and deletes a role with its functional permissions", () => {
    const db = setup();
    const userId = randomUUID();
    insertUser(db, {
      id: userId,
      username: "alice",
      passwordHash: "x",
      role: "user",
      createdAt: Date.now(),
    });

    const role = createRole(db, {
      name: "财务",
      description: "财务分析角色",
      permissions: ["chat.use"],
    });
    expect(role.name).toBe("财务");
    expect(role.builtin).toBe(0);
    expect(findRoleByName(db, "财务")?.id).toBe(role.id);

    const summary = listRoles(db).find((row) => row.id === role.id)!;
    expect(summary).toMatchObject({
      userCount: 0,
      permissionCount: 1,
    });

    replaceRolePermissions(db, role.id, ["chat.use", "export.data", "chat.use"]);
    expect(listRolePermissions(db, role.id)).toEqual(["chat.use", "export.data"]);

    updateRole(db, role.id, { name: "财务组", description: null });
    const detail = roleDetail(db, role.id)!;
    expect(detail.name).toBe("财务组");
    expect(detail.description).toBeNull();
    expect(detail.permissions).toEqual(["chat.use", "export.data"]);
    expect(detail.isBuiltin).toBe(false);

    setUserRoles(db, userId, [role.id]);
    expect(listRoleIdsForUser(db, userId)).toEqual([role.id]);
    expect(listRolesForUser(db, userId).map((row) => row.name)).toEqual(["财务组"]);
    expect(permissionsForUserRoles(db, userId).sort()).toEqual(["chat.use", "export.data"]);

    deleteRole(db, role.id);
    expect(listRoles(db).some((row) => row.id === role.id)).toBe(false);
    expect(findRole(db, role.id)).toBeUndefined();
    // ON DELETE CASCADE removes assignments and permissions.
    expect(listRoleIdsForUser(db, userId)).toEqual([]);
    expect(listRolePermissions(db, role.id)).toEqual([]);
  });

  it("rejects role assignments that reference unknown roles", () => {
    const db = setup();
    const userId = randomUUID();
    insertUser(db, {
      id: userId,
      username: "bob",
      passwordHash: "x",
      role: "user",
      createdAt: Date.now(),
    });
    expect(() => setUserRoles(db, userId, [randomUUID()])).toThrow(UnknownRoleError);
    expect(listRoleIdsForUser(db, userId)).toEqual([]);
  });

  it("returns empty permissions for users without roles", () => {
    const db = setup();
    expect(permissionsForUserRoles(db, "nobody")).toEqual([]);
    expect(roleDetail(db, "missing")).toBeUndefined();
  });
});
