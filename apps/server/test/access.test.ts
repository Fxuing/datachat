import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FUNCTIONAL_PERMISSIONS } from "@datachat/shared";
import { createDb, type Db, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { canAccessDatasource, resolveUserAccess } from "../src/auth/access.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";
import {
  datasourceGrants,
  roleDatasourceGrants,
  rolePermissions,
  roles,
  userRoles,
} from "../src/db/schema.js";

function migrate(): DbHandle {
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  return handle;
}

function datasource(db: Db, owner: string, name: string): string {
  const id = randomUUID();
  insertDatasource(db, {
    id,
    name,
    type: "mysql",
    host: "localhost",
    port: 3306,
    database: "demo",
    username: "reader",
    passwordCipher: encryptSecret("secret", deriveSecretKey("test-secret")),
    sslMode: "disable",
    readOnlyVerified: 1,
    allowWriteAccount: 0,
    status: "ok",
    lastCheckedAt: null,
    createdBy: owner,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return id;
}

describe("resolveUserAccess", () => {
  it("unions multiple roles, direct grants, and role grants", () => {
    const handle = migrate();
    const userId = randomUUID();
    insertUser(handle.db, {
      id: userId,
      username: "alice",
      passwordHash: "x",
      role: "user",
      createdAt: Date.now(),
    });
    const analyst = randomUUID();
    const auditor = randomUUID();
    handle.db
      .insert(roles)
      .values([
        { id: analyst, name: "analyst", builtin: 0, createdAt: 1, updatedAt: 1 },
        { id: auditor, name: "auditor", builtin: 0, createdAt: 1, updatedAt: 1 },
      ])
      .run();
    handle.db
      .insert(rolePermissions)
      .values([
        { roleId: analyst, permission: "chat.use" },
        { roleId: analyst, permission: "export.data" },
        { roleId: auditor, permission: "report.create" },
      ])
      .run();
    handle.db
      .insert(userRoles)
      .values([
        { userId, roleId: analyst },
        { userId, roleId: auditor },
      ])
      .run();
    const ds1 = datasource(handle.db, userId, "finance");
    const ds2 = datasource(handle.db, userId, "ops");
    handle.db
      .insert(roleDatasourceGrants)
      .values([
        { roleId: analyst, datasourceId: ds1 },
        { roleId: auditor, datasourceId: ds2 },
      ])
      .run();
    const direct = datasource(handle.db, userId, "direct");
    handle.db
      .insert(datasourceGrants)
      .values({ id: randomUUID(), datasourceId: direct, userId, createdAt: Date.now() })
      .run();

    const access = resolveUserAccess(handle.db, { id: userId, role: "user" });
    expect([...access.permissions].sort()).toEqual(["chat.use", "export.data", "report.create"]);
    expect(access.datasourceIds && [...access.datasourceIds].sort()).toEqual(
      [ds1, ds2, direct].sort(),
    );
    expect(canAccessDatasource(access, direct)).toBe(true);
    expect(canAccessDatasource(access, randomUUID())).toBe(false);
    handle.sqlite.close();
  });

  it("gives admins every permission and every datasource", () => {
    const handle = migrate();
    const userId = randomUUID();
    insertUser(handle.db, {
      id: userId,
      username: "root",
      passwordHash: "x",
      role: "admin",
      createdAt: Date.now(),
    });
    const access = resolveUserAccess(handle.db, { id: userId, role: "admin" });
    expect(access.isAdmin).toBe(true);
    expect(access.datasourceIds).toBeNull();
    expect(access.permissions.has("admin.roles")).toBe(true);
    expect(access.permissions.has("chat.use")).toBe(true);
    expect(canAccessDatasource(access, randomUUID())).toBe(true);
    handle.sqlite.close();
  });

  it("falls back to the member permission preset when a user has no roles", () => {
    const handle = migrate();
    const userId = randomUUID();
    insertUser(handle.db, {
      id: userId,
      username: "legacy",
      passwordHash: "x",
      role: "user",
      createdAt: Date.now(),
    });
    const access = resolveUserAccess(handle.db, { id: userId, role: "user" });
    expect(access.isAdmin).toBe(false);
    expect([...access.permissions].sort()).toEqual([...FUNCTIONAL_PERMISSIONS].sort());
    expect(access.datasourceIds?.size).toBe(0);
    handle.sqlite.close();
  });
});
