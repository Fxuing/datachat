import { eq } from "drizzle-orm";
import {
  ALL_PERMISSIONS,
  FUNCTIONAL_PERMISSIONS,
  isPermission,
  type Permission,
} from "@datachat/shared";
import type { Db } from "../db/client.js";
import type { UserRow } from "../db/repositories/users.js";
import { datasourceGrants } from "../db/schema.js";
import {
  datasourceIdsForUserRoles,
  listRoleIdsForUser,
  permissionsForUserRoles,
} from "../db/repositories/roles.js";

export interface UserAccess {
  isAdmin: boolean;
  permissions: Set<Permission>;
  /** null means every datasource. */
  datasourceIds: Set<string> | null;
}

export function resolveUserAccess(db: Db, user: Pick<UserRow, "id" | "role">): UserAccess {
  if (user.role === "admin") {
    return { isAdmin: true, permissions: new Set(ALL_PERMISSIONS), datasourceIds: null };
  }
  const permissions = new Set(permissionsForUserRoles(db, user.id).filter(isPermission));
  // Legacy rows created before migration 0010 had no explicit assignment. The
  // migration assigns role_member, but tests/imported data may still hit this
  // path; treat "no roles at all" as the member preset.
  if (listRoleIdsForUser(db, user.id).length === 0) {
    for (const permission of FUNCTIONAL_PERMISSIONS) permissions.add(permission);
  }
  const ids = new Set<string>(datasourceIdsForUserRoles(db, user.id));
  const direct = db
    .select({ id: datasourceGrants.datasourceId })
    .from(datasourceGrants)
    .where(eq(datasourceGrants.userId, user.id))
    .all();
  for (const row of direct) ids.add(row.id);
  return { isAdmin: false, permissions, datasourceIds: ids };
}

export function canAccessDatasource(access: UserAccess, datasourceId: string): boolean {
  return access.datasourceIds === null || access.datasourceIds.has(datasourceId);
}
