import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { insertUser } from "../src/db/repositories/users.js";
import {
  createRole,
  datasourceIdsForUserRoles,
  deleteRole,
  findRole,
  findRoleByName,
  listRoleDatasourceIds,
  listRoleIdsForUser,
  listRolePermissions,
  listRoles,
  listRolesForUser,
  permissionsForUserRoles,
  replaceRoleDatasources,
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

function insertDatasourceRow(db: Db, id: string, name: string, ownerId: string): void {
  insertDatasource(db, {
    id,
    name,
    type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "demo",
    username: "demo",
    passwordCipher: "cipher",
    createdBy: ownerId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

describe("roles repository", () => {
  it("creates, edits, and deletes a role with its grants", () => {
    const db = setup();
    const userId = randomUUID();
    insertUser(db, {
      id: userId,
      username: "alice",
      passwordHash: "x",
      role: "user",
      createdAt: Date.now(),
    });
    const datasourceId = randomUUID();
    insertDatasourceRow(db, datasourceId, "finance", userId);

    const role = createRole(db, {
      name: "财务",
      description: "财务库",
      permissions: ["chat.use"],
      datasourceIds: [datasourceId],
    });
    expect(role.name).toBe("财务");
    expect(role.builtin).toBe(0);
    expect(findRoleByName(db, "财务")?.id).toBe(role.id);

    const summary = listRoles(db).find((row) => row.id === role.id)!;
    expect(summary).toMatchObject({
      userCount: 0,
      permissionCount: 1,
      datasourceCount: 1,
    });

    replaceRolePermissions(db, role.id, ["chat.use", "export.data", "chat.use"]);
    replaceRoleDatasources(db, role.id, [datasourceId]);
    expect(listRolePermissions(db, role.id)).toEqual(["chat.use", "export.data"]);
    expect(listRoleDatasourceIds(db, role.id)).toEqual([datasourceId]);

    updateRole(db, role.id, { name: "财务组", description: null });
    const detail = roleDetail(db, role.id)!;
    expect(detail.name).toBe("财务组");
    expect(detail.description).toBeNull();
    expect(detail.permissions).toEqual(["chat.use", "export.data"]);
    expect(detail.datasourceIds).toEqual([datasourceId]);
    expect(detail.isBuiltin).toBe(false);

    setUserRoles(db, userId, [role.id]);
    expect(listRoleIdsForUser(db, userId)).toEqual([role.id]);
    expect(listRolesForUser(db, userId).map((row) => row.name)).toEqual(["财务组"]);
    expect(permissionsForUserRoles(db, userId).sort()).toEqual(["chat.use", "export.data"]);
    expect(datasourceIdsForUserRoles(db, userId)).toEqual([datasourceId]);

    deleteRole(db, role.id);
    expect(listRoles(db).some((row) => row.id === role.id)).toBe(false);
    expect(findRole(db, role.id)).toBeUndefined();
    // ON DELETE CASCADE removes assignments and grants.
    expect(listRoleIdsForUser(db, userId)).toEqual([]);
    expect(listRolePermissions(db, role.id)).toEqual([]);
    expect(listRoleDatasourceIds(db, role.id)).toEqual([]);
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

  it("returns empty grants for users without roles", () => {
    const db = setup();
    expect(permissionsForUserRoles(db, "nobody")).toEqual([]);
    expect(datasourceIdsForUserRoles(db, "nobody")).toEqual([]);
    expect(roleDetail(db, "missing")).toBeUndefined();
  });
});
