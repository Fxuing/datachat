import { randomUUID } from "node:crypto";
import { asc, count, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { roleDatasourceGrants, rolePermissions, roles, userRoles } from "../schema.js";

export type RoleRow = typeof roles.$inferSelect;

export interface RoleSummary extends RoleRow {
  userCount: number;
  permissionCount: number;
  datasourceCount: number;
}

export interface RoleDetail extends RoleSummary {
  permissions: string[];
  datasourceIds: string[];
  isBuiltin: boolean;
}

/** Thrown by setUserRoles when an assignment references a missing role. */
export class UnknownRoleError extends Error {
  readonly code = "UNKNOWN_ROLE";

  constructor(readonly roleId: string) {
    super(`Role not found: ${roleId}`);
    this.name = "UnknownRoleError";
  }
}

function toRoleSummary(db: Db, row: RoleRow): RoleSummary {
  const userCount =
    db.select({ value: count() }).from(userRoles).where(eq(userRoles.roleId, row.id)).get()
      ?.value ?? 0;
  const permissionCount =
    db
      .select({ value: count() })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, row.id))
      .get()?.value ?? 0;
  const datasourceCount =
    db
      .select({ value: count() })
      .from(roleDatasourceGrants)
      .where(eq(roleDatasourceGrants.roleId, row.id))
      .get()?.value ?? 0;
  return { ...row, userCount, permissionCount, datasourceCount };
}

export function listRoles(db: Db): RoleSummary[] {
  return db
    .select()
    .from(roles)
    .orderBy(asc(roles.name))
    .all()
    .map((row) => toRoleSummary(db, row));
}

export function findRole(db: Db, id: string): RoleRow | undefined {
  return db.select().from(roles).where(eq(roles.id, id)).get();
}

export function findRoleByName(db: Db, name: string): RoleRow | undefined {
  return db.select().from(roles).where(eq(roles.name, name)).get();
}

export function listRolesForUser(db: Db, userId: string): RoleRow[] {
  return db
    .select({ role: roles })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId))
    .orderBy(asc(roles.name))
    .all()
    .map((row) => row.role);
}

export function listRoleIdsForUser(db: Db, userId: string): string[] {
  return db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all()
    .map((row) => row.roleId);
}

export function permissionsForUserRoles(db: Db, userId: string): string[] {
  return db
    .selectDistinct({ permission: rolePermissions.permission })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .where(eq(userRoles.userId, userId))
    .all()
    .map((row) => row.permission);
}

export function datasourceIdsForUserRoles(db: Db, userId: string): string[] {
  return db
    .selectDistinct({ datasourceId: roleDatasourceGrants.datasourceId })
    .from(userRoles)
    .innerJoin(roleDatasourceGrants, eq(userRoles.roleId, roleDatasourceGrants.roleId))
    .where(eq(userRoles.userId, userId))
    .all()
    .map((row) => row.datasourceId);
}

export function listRolePermissions(db: Db, roleId: string): string[] {
  return db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId))
    .orderBy(asc(rolePermissions.permission))
    .all()
    .map((row) => row.permission);
}

export function listRoleDatasourceIds(db: Db, roleId: string): string[] {
  return db
    .select({ datasourceId: roleDatasourceGrants.datasourceId })
    .from(roleDatasourceGrants)
    .where(eq(roleDatasourceGrants.roleId, roleId))
    .orderBy(asc(roleDatasourceGrants.datasourceId))
    .all()
    .map((row) => row.datasourceId);
}

export function createRole(
  db: Db,
  input: { name: string; description?: string | null; permissions: string[]; datasourceIds: string[] },
): RoleRow {
  const id = randomUUID();
  const now = Date.now();
  const permissions = [...new Set(input.permissions)];
  const datasourceIds = [...new Set(input.datasourceIds)];
  db.transaction((tx) => {
    tx.insert(roles)
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        builtin: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (permissions.length > 0) {
      tx.insert(rolePermissions)
        .values(permissions.map((permission) => ({ roleId: id, permission })))
        .run();
    }
    if (datasourceIds.length > 0) {
      tx.insert(roleDatasourceGrants)
        .values(datasourceIds.map((datasourceId) => ({ roleId: id, datasourceId })))
        .run();
    }
  });
  return findRole(db, id)!;
}

export function updateRole(
  db: Db,
  id: string,
  input: { name?: string; description?: string | null },
): RoleRow {
  const patch: Partial<typeof roles.$inferInsert> = { updatedAt: Date.now() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  db.update(roles).set(patch).where(eq(roles.id, id)).run();
  return findRole(db, id)!;
}

export function replaceRolePermissions(db: Db, roleId: string, permissions: string[]): void {
  const unique = [...new Set(permissions)];
  db.transaction((tx) => {
    tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId)).run();
    if (unique.length > 0) {
      tx.insert(rolePermissions)
        .values(unique.map((permission) => ({ roleId, permission })))
        .run();
    }
    tx.update(roles).set({ updatedAt: Date.now() }).where(eq(roles.id, roleId)).run();
  });
}

export function replaceRoleDatasources(db: Db, roleId: string, datasourceIds: string[]): void {
  const unique = [...new Set(datasourceIds)];
  db.transaction((tx) => {
    tx.delete(roleDatasourceGrants).where(eq(roleDatasourceGrants.roleId, roleId)).run();
    if (unique.length > 0) {
      tx.insert(roleDatasourceGrants)
        .values(unique.map((datasourceId) => ({ roleId, datasourceId })))
        .run();
    }
    tx.update(roles).set({ updatedAt: Date.now() }).where(eq(roles.id, roleId)).run();
  });
}

/** Role grants and assignments disappear via ON DELETE CASCADE. */
export function deleteRole(db: Db, id: string): void {
  db.delete(roles).where(eq(roles.id, id)).run();
}

export function setUserRoles(db: Db, userId: string, roleIds: string[]): void {
  const unique = [...new Set(roleIds)];
  db.transaction((tx) => {
    // Re-check inside the transaction so a concurrent role delete maps to
    // UnknownRoleError instead of surfacing a raw foreign-key failure.
    const missing = unique.find((roleId) => !findRole(tx, roleId));
    if (missing) throw new UnknownRoleError(missing);
    tx.delete(userRoles).where(eq(userRoles.userId, userId)).run();
    if (unique.length > 0) {
      tx.insert(userRoles)
        .values(unique.map((roleId) => ({ userId, roleId })))
        .run();
    }
  });
}

export function roleDetail(db: Db, id: string): RoleDetail | undefined {
  const row = findRole(db, id);
  if (!row) return undefined;
  return {
    ...toRoleSummary(db, row),
    permissions: listRolePermissions(db, id),
    datasourceIds: listRoleDatasourceIds(db, id),
    isBuiltin: row.builtin === 1,
  };
}
