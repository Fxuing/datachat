import { asc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { roleDatasourceGrants, rolePermissions, roles, userRoles } from "../schema.js";

export type RoleRow = typeof roles.$inferSelect;

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
