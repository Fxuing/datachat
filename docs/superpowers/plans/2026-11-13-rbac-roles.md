# RBAC Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add custom roles with a functional-permission matrix, multi-role assignment, role datasource grants, server-side enforcement, and admin UI.

**Architecture:** Keep `users.role` as the system-admin flag. Add `roles`, `role_permissions`, `user_roles`, and `role_datasource_grants`; resolve permissions and datasource access per request; gate HTTP routes, agent Skills/MCP resources, and UI actions. Existing direct datasource grants stay and are unioned with role grants.

**Tech Stack:** TypeScript, Fastify 5, Drizzle + SQLite, Zod, React 19, TanStack Query, Radix/shadcn, Vitest.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/permissions.ts` | Permission constants, labels, groups, type guards |
| `packages/shared/src/index.ts` | Re-export permissions |
| `apps/server/src/db/schema.ts` | Drizzle tables for roles and joins |
| `apps/server/drizzle/0010_rbac.sql` | Tables, indexes, member seed, backfill |
| `apps/server/drizzle/0011_role_audit.sql` | Rebuild `query_audit` with `role_change` |
| `apps/server/src/db/repositories/roles.ts` | Role CRUD, assignments, grants, permission queries |
| `apps/server/src/auth/access.ts` | Resolve `UserAccess` |
| `apps/server/src/auth/guard.ts` | Load access per request; `requirePermission` |
| `apps/server/src/routes/auth.ts` | `/api/auth/me` includes permissions and roles |
| `apps/server/src/routes/admin-roles.ts` | `/api/admin/roles` CRUD |
| `apps/server/src/routes/admin-users.ts` | Role assignment in create/update/list |
| `apps/server/src/routes/*.ts` | Replace/add permission guards |
| `apps/server/src/agent/resources.ts` | Conditional Skills/MCP resources |
| `apps/server/src/agent/runtime.ts` | Resolve access before session creation |
| `apps/web/src/lib/api.ts` | MeResponse, roles/permissions types, admin role APIs |
| `apps/web/src/lib/use-can.ts` | `useCan(permission)` hook |
| `apps/web/src/pages/admin/RolesPage.tsx` | Role list/editor |
| `apps/web/src/pages/admin/UsersPage.tsx` | User list/editor with roles |
| `apps/web/src/components/AppShell.tsx` | Admin nav entries for users/roles |
| `apps/web/src/pages/ChatPage.tsx` | Pass permission flags to chat UI |

---

### Task 1: Permission Catalog, Tables, and Migrations

**Files:**
- Create: `packages/shared/src/permissions.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0010_rbac.sql`
- Create: `apps/server/drizzle/0011_role_audit.sql`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Test: `apps/server/test/rbac-schema.test.ts`
- Modify: `apps/server/test/db.test.ts`

- [ ] **Step 1: Write the failing schema test**

`apps/server/test/rbac-schema.test.ts`:

```ts
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
```

Update `apps/server/test/db.test.ts` migration count from `10` to `12`, and assert `roles`, `role_permissions`, `user_roles`, `role_datasource_grants` exist.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @datachat/server exec vitest run test/rbac-schema.test.ts test/db.test.ts`
Expected: FAIL — no `roles` table / migration count still 10.

- [ ] **Step 3: Add the shared permission catalog**

`packages/shared/src/permissions.ts`:

```ts
export const FUNCTIONAL_PERMISSIONS = [
  "chat.use",
  "skill.use",
  "mcp.use",
  "report.create",
  "share.create",
  "export.data",
] as const;

export const SYSTEM_PERMISSIONS = [
  "admin.users",
  "admin.roles",
  "admin.datasources",
  "admin.skills",
  "admin.mcp",
  "admin.settings",
  "admin.audit",
  "admin.ops",
] as const;

export const ALL_PERMISSIONS = [...FUNCTIONAL_PERMISSIONS, ...SYSTEM_PERMISSIONS] as const;

export type FunctionalPermission = (typeof FUNCTIONAL_PERMISSIONS)[number];
export type SystemPermission = (typeof SYSTEM_PERMISSIONS)[number];
export type Permission = (typeof ALL_PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  "chat.use": "使用对话",
  "skill.use": "使用技能",
  "mcp.use": "使用 MCP 工具",
  "report.create": "生成报告",
  "share.create": "创建分享链接",
  "export.data": "导出 CSV / Excel",
  "admin.users": "用户管理",
  "admin.roles": "角色管理",
  "admin.datasources": "数据源管理",
  "admin.skills": "技能管理",
  "admin.mcp": "MCP 管理",
  "admin.settings": "系统设置",
  "admin.audit": "审计日志",
  "admin.ops": "运维",
};

export const PERMISSION_GROUPS = [
  {
    label: "功能权限",
    permissions: FUNCTIONAL_PERMISSIONS.map((permission) => ({
      permission,
      label: PERMISSION_LABELS[permission],
    })),
  },
  {
    label: "系统权限（仅内置管理员）",
    permissions: SYSTEM_PERMISSIONS.map((permission) => ({
      permission,
      label: PERMISSION_LABELS[permission],
    })),
  },
] as const;

const permissionSet = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return permissionSet.has(value);
}

export function isSystemPermission(value: string): value is SystemPermission {
  return (SYSTEM_PERMISSIONS as readonly string[]).includes(value);
}
```

Add `export * from "./permissions.js";` to `packages/shared/src/index.ts`.

- [ ] **Step 4: Add Drizzle tables**

In `apps/server/src/db/schema.ts`, import `primaryKey` from `drizzle-orm/sqlite-core`, then add:

```ts
export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    builtin: integer("builtin").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("roles_name_unique").on(t.name)],
);

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    roleId: text("role_id").notNull(),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id").notNull(),
    roleId: text("role_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index("user_roles_role_idx").on(t.roleId),
  ],
);

export const roleDatasourceGrants = sqliteTable(
  "role_datasource_grants",
  {
    roleId: text("role_id").notNull(),
    datasourceId: text("datasource_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.datasourceId] }),
    index("role_datasource_grants_datasource_idx").on(t.datasourceId),
  ],
);
```

- [ ] **Step 5: Write migration 0010**

`apps/server/drizzle/0010_rbac.sql`:

```sql
CREATE TABLE `roles` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `builtin` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_unique` ON `roles` (`name`);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
  `role_id` text NOT NULL REFERENCES `roles`(`id`) ON DELETE CASCADE,
  `permission` text NOT NULL,
  PRIMARY KEY (`role_id`, `permission`)
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `role_id` text NOT NULL REFERENCES `roles`(`id`) ON DELETE CASCADE,
  PRIMARY KEY (`user_id`, `role_id`)
);
--> statement-breakpoint
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role_id`);
--> statement-breakpoint
CREATE TABLE `role_datasource_grants` (
  `role_id` text NOT NULL REFERENCES `roles`(`id`) ON DELETE CASCADE,
  `datasource_id` text NOT NULL REFERENCES `datasources`(`id`) ON DELETE CASCADE,
  PRIMARY KEY (`role_id`, `datasource_id`)
);
--> statement-breakpoint
CREATE INDEX `role_datasource_grants_datasource_idx` ON `role_datasource_grants` (`datasource_id`);
--> statement-breakpoint
INSERT INTO `roles` (`id`,`name`,`description`,`builtin`,`created_at`,`updated_at`)
VALUES ('role_member','成员','默认角色，拥有全部功能权限',1,1794000000000,1794000000000);
--> statement-breakpoint
INSERT INTO `role_permissions` (`role_id`,`permission`) VALUES
  ('role_member','chat.use'),
  ('role_member','skill.use'),
  ('role_member','mcp.use'),
  ('role_member','report.create'),
  ('role_member','share.create'),
  ('role_member','export.data');
--> statement-breakpoint
INSERT OR IGNORE INTO `user_roles` (`user_id`,`role_id`)
SELECT `id`, 'role_member' FROM `users` WHERE `role` = 'user';
```

- [ ] **Step 6: Write migration 0011**

`apps/server/drizzle/0011_role_audit.sql`:

```sql
-- Allow role changes in the audit log without losing existing rows.
CREATE TABLE `query_audit_new` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`conversation_id` text,
	`user_id` text,
	`datasource_id` text,
	`action` text DEFAULT 'query' NOT NULL,
	`sql_text` text NOT NULL,
	`sql_hash` text NOT NULL,
	`status` text NOT NULL,
	`row_count` integer,
	`duration_ms` integer,
	`error_message` text,
	`detail_json` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `query_audit_action_check` CHECK (`action` in (
		'query','explain','export','login','login_failed',
		'user_create','user_update','datasource_create','datasource_update',
		'datasource_delete','grant_update','skill_change','mcp_change','role_change','ops'
	))
);
--> statement-breakpoint
INSERT INTO `query_audit_new` (
	`id`,`run_id`,`conversation_id`,`user_id`,`datasource_id`,`action`,
	`sql_text`,`sql_hash`,`status`,`row_count`,`duration_ms`,`error_message`,
	`detail_json`,`created_at`
)
SELECT
	`id`,`run_id`,`conversation_id`,`user_id`,`datasource_id`,`action`,
	`sql_text`,`sql_hash`,`status`,`row_count`,`duration_ms`,`error_message`,
	`detail_json`,`created_at`
FROM `query_audit`;
--> statement-breakpoint
DROP TABLE `query_audit`;
--> statement-breakpoint
ALTER TABLE `query_audit_new` RENAME TO `query_audit`;
--> statement-breakpoint
CREATE INDEX `query_audit_datasource_created_idx` ON `query_audit` (`datasource_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `query_audit_created_idx` ON `query_audit` (`created_at`);
```

Add journal entries:

```json
{ "idx": 10, "version": "6", "when": 1794000000000, "tag": "0010_rbac", "breakpoints": true },
{ "idx": 11, "version": "6", "when": 1794001000000, "tag": "0011_role_audit", "breakpoints": true }
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @datachat/server exec vitest run test/rbac-schema.test.ts test/db.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/permissions.ts packages/shared/src/index.ts apps/server/src/db/schema.ts apps/server/drizzle/0010_rbac.sql apps/server/drizzle/0011_role_audit.sql apps/server/drizzle/meta/_journal.json apps/server/test/rbac-schema.test.ts apps/server/test/db.test.ts
git commit -m "feat(rbac): add roles and permission tables"
```

---

### Task 2: Access Resolver, Guards, and `/api/auth/me`

**Files:**
- Create: `apps/server/src/auth/access.ts`
- Modify: `apps/server/src/auth/guard.ts`
- Modify: `apps/server/src/types/fastify.d.ts`
- Modify: `apps/server/src/routes/auth.ts`
- Test: `apps/server/test/access.test.ts`
- Test: `apps/server/test/auth-me.test.ts`

- [ ] **Step 1: Write the failing access test**

`apps/server/test/access.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { resolveUserAccess } from "../src/auth/access.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";
import { roles, rolePermissions, userRoles, roleDatasourceGrants } from "../src/db/schema.js";

function datasource(db: ReturnType<typeof createDb>["db"], owner: string, name: string) {
  const id = randomUUID();
  insertDatasource(db, {
    id, name, type: "mysql", host: "localhost", port: 3306, database: "demo",
    username: "reader", passwordCipher: encryptSecret("secret", deriveSecretKey("test-secret")),
    sslMode: "disable", readOnlyVerified: 1, allowWriteAccount: 0, status: "ok",
    lastCheckedAt: null, createdBy: owner, createdAt: Date.now(), updatedAt: Date.now(),
  });
  return id;
}

describe("resolveUserAccess", () => {
  it("unions multiple roles, direct grants, and role grants", () => {
    const handle = createDb(":memory:");
    migrateDb(handle.db);
    const userId = randomUUID();
    insertUser(handle.db, {
      id: userId, username: "alice", passwordHash: "x", role: "user", createdAt: Date.now(),
    });
    const analyst = randomUUID();
    const auditor = randomUUID();
    handle.db.insert(roles).values([
      { id: analyst, name: "analyst", builtin: 0, createdAt: 1, updatedAt: 1 },
      { id: auditor, name: "auditor", builtin: 0, createdAt: 1, updatedAt: 1 },
    ]).run();
    handle.db.insert(rolePermissions).values([
      { roleId: analyst, permission: "chat.use" },
      { roleId: analyst, permission: "export.data" },
      { roleId: auditor, permission: "report.create" },
    ]).run();
    handle.db.insert(userRoles).values([
      { userId, roleId: analyst },
      { userId, roleId: auditor },
    ]).run();
    const ds1 = datasource(handle.db, userId, "finance");
    const ds2 = datasource(handle.db, userId, "ops");
    handle.db.insert(roleDatasourceGrants).values([{ roleId: analyst, datasourceId: ds1 }]).run();
    handle.db.insert(roleDatasourceGrants).values([{ roleId: auditor, datasourceId: ds2 }]).run();
    const direct = datasource(handle.db, userId, "direct");

    const access = resolveUserAccess(handle.db, {
      id: userId, role: "user", status: "active",
    } as never);
    expect([...access.permissions].sort()).toEqual(["chat.use", "export.data", "report.create"]);
    expect(access.datasourceIds && [...access.datasourceIds].sort()).toEqual([ds1, ds2, direct].sort());
    handle.sqlite.close();
  });

  it("gives admins every permission and every datasource", () => {
    const handle = createDb(":memory:");
    migrateDb(handle.db);
    const userId = randomUUID();
    insertUser(handle.db, {
      id: userId, username: "root", passwordHash: "x", role: "admin", createdAt: Date.now(),
    });
    const access = resolveUserAccess(handle.db, { id: userId, role: "admin" } as never);
    expect(access.isAdmin).toBe(true);
    expect(access.datasourceIds).toBeNull();
    expect(access.permissions.has("admin.roles")).toBe(true);
    expect(access.permissions.has("chat.use")).toBe(true);
    handle.sqlite.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @datachat/server exec vitest run test/access.test.ts`
Expected: FAIL — cannot resolve `../src/auth/access.js`.

- [ ] **Step 3: Implement `resolveUserAccess`**

`apps/server/src/auth/access.ts`:

```ts
import { eq, inArray } from "drizzle-orm";
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
  const permissions = new Set(
    permissionsForUserRoles(db, user.id).filter(isPermission),
  );
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
```

`permissionsForUserRoles` and `datasourceIdsForUserRoles` are added in Task 3; for this task, add them to `roles.ts` now with the minimal implementation shown in Task 3 Step 3.

- [ ] **Step 4: Wire access into the guard**

In `guard.ts`:

```ts
import { resolveUserAccess, type UserAccess } from "./access.js";

app.decorateRequest("access", undefined);

// inside authenticate, after request.authUser = user:
request.access = resolveUserAccess(db, user);

app.decorate("requirePermission", (permission: Permission) => {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!request.access?.permissions.has(permission)) {
      return reply.code(403).send({
        error: {
          code: "PERMISSION_DENIED",
          message: `缺少权限：${PERMISSION_LABELS[permission]}`,
          permission,
        },
      });
    }
  };
});
```

Add imports for `FastifyRequest`, `FastifyReply`, `Permission`, `PERMISSION_LABELS`. Keep `requireAdmin`.

In `apps/server/src/types/fastify.d.ts` add:

```ts
import type { UserAccess } from "../auth/access.js";
import type { Permission } from "@datachat/shared";

interface FastifyRequest {
  access?: UserAccess;
}
interface FastifyInstance {
  requirePermission: (permission: Permission) =>
    (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}
```

- [ ] **Step 5: Extend `/api/auth/me`**

In `routes/auth.ts`:

```ts
const roles = listRolesForUser(db, request.authUser!.id).map((role) => ({
  id: role.id,
  name: role.name,
}));
return {
  user: toPublicUser(request.authUser!),
  permissions: [...resolveUserAccess(db, request.authUser!).permissions],
  roles,
};
```

- [ ] **Step 6: Write `/api/auth/me` test**

`apps/server/test/auth-me.test.ts`: insert a member-assigned user, log in, GET `/api/auth/me`, expect `permissions` contains `chat.use`, `roles` contains `{ id: "role_member", name: "成员" }`.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @datachat/server exec vitest run test/access.test.ts test/auth-me.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/auth/access.ts apps/server/src/auth/guard.ts apps/server/src/types/fastify.d.ts apps/server/src/routes/auth.ts apps/server/test/access.test.ts apps/server/test/auth-me.test.ts
git commit -m "feat(rbac): resolve user permissions per request"
```

---

### Task 3: Role Repository, Admin Role API, and Audit

**Files:**
- Create: `apps/server/src/db/repositories/roles.ts`
- Create: `apps/server/src/routes/admin-roles.ts`
- Modify: `apps/server/src/services/audit.ts`
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/admin-roles.test.ts`
- Test: `apps/server/test/roles-repo.test.ts`

- [ ] **Step 1: Write the failing repo test**

`apps/server/test/roles-repo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  createRole, deleteRole, listRoles, replaceRolePermissions, replaceRoleDatasources,
  permissionsForUserRoles, datasourceIdsForUserRoles,
} from "../src/db/repositories/roles.js";

describe("roles repository", () => {
  it("creates, edits, and deletes a role with its grants", () => {
    const handle = createDb(":memory:");
    migrateDb(handle.db);
    const role = createRole(handle.db, { name: "财务", description: "财务库", permissions: ["chat.use"], datasourceIds: [] });
    expect(listRoles(handle.db).map((row) => row.name)).toContain("财务");
    replaceRolePermissions(handle.db, role.id, ["chat.use", "export.data"]);
    replaceRoleDatasources(handle.db, role.id, ["ds-1"]);
    expect([...permissionsForUserRoles(handle.db, "nobody")]).toEqual([]);
    expect(datasourceIdsForUserRoles(handle.db, "nobody")).toEqual([]);
    deleteRole(handle.db, role.id);
    expect(listRoles(handle.db).some((row) => row.id === role.id)).toBe(false);
    handle.sqlite.close();
  });
});
```

- [ ] **Step 2: Implement `roles.ts`**

Exports:

```ts
export interface RoleRow { id: string; name: string; description: string | null; builtin: number; createdAt: number; updatedAt: number }
export interface RoleSummary extends RoleRow { userCount: number; permissionCount: number; datasourceCount: number }
export interface RoleDetail extends RoleSummary { permissions: string[]; datasourceIds: string[] }

export function listRoles(db: Db): RoleSummary[]
export function findRole(db: Db, id: string): RoleRow | undefined
export function findRoleByName(db: Db, name: string): RoleRow | undefined
export function listRolesForUser(db: Db, userId: string): RoleRow[]
export function listRoleIdsForUser(db: Db, userId: string): string[]
export function permissionsForUserRoles(db: Db, userId: string): string[]
export function datasourceIdsForUserRoles(db: Db, userId: string): string[]
export function listRolePermissions(db: Db, roleId: string): string[]
export function listRoleDatasourceIds(db: Db, roleId: string): string[]
export function createRole(db: Db, input: { name: string; description?: string | null; permissions: string[]; datasourceIds: string[] }): RoleRow
export function updateRole(db: Db, id: string, input: { name?: string; description?: string | null }): RoleRow
export function replaceRolePermissions(db: Db, roleId: string, permissions: string[]): void
export function replaceRoleDatasources(db: Db, roleId: string, datasourceIds: string[]): void
export function deleteRole(db: Db, id: string): void
```

Core implementations:

```ts
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

export function listRoleIdsForUser(db: Db, userId: string): string[] {
  return db.select({ roleId: userRoles.roleId }).from(userRoles)
    .where(eq(userRoles.userId, userId)).all().map((row) => row.roleId);
}

export function replaceUserRoles(db: Db, userId: string, roleIds: string[]): void {
  db.transaction((tx) => {
    tx.delete(userRoles).where(eq(userRoles.userId, userId)).run();
    if (roleIds.length > 0) {
      tx.insert(userRoles).values(roleIds.map((roleId) => ({ userId, roleId }))).run();
    }
  });
}

export function createRole(db: Db, input: {
  name: string; description?: string | null; permissions: string[]; datasourceIds: string[];
}): RoleRow {
  const id = randomUUID();
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(roles).values({ id, name: input.name, description: input.description ?? null, builtin: 0, createdAt: now, updatedAt: now }).run();
    if (input.permissions.length > 0) {
      tx.insert(rolePermissions).values(input.permissions.map((permission) => ({ roleId: id, permission }))).run();
    }
    if (input.datasourceIds.length > 0) {
      tx.insert(roleDatasourceGrants).values(input.datasourceIds.map((datasourceId) => ({ roleId: id, datasourceId }))).run();
    }
  });
  return findRole(db, id)!;
}

export function replaceRolePermissions(db: Db, roleId: string, permissions: string[]): void {
  db.transaction((tx) => {
    tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId)).run();
    if (permissions.length > 0) {
      tx.insert(rolePermissions).values(permissions.map((permission) => ({ roleId, permission }))).run();
    }
    tx.update(roles).set({ updatedAt: Date.now() }).where(eq(roles.id, roleId)).run();
  });
}

// replaceRoleDatasources mirrors replaceRolePermissions against roleDatasourceGrants.
// deleteRole relies on the ON DELETE CASCADE constraints from migration 0010.
```

`listRolesForUser` joins `roles` through `userRoles` and returns role rows ordered by name.

- [ ] **Step 3: Add audit action**

In `services/audit.ts` add `"role_change"` to `AuditAction`; in `db/schema.ts` add to the `queryAudit.action` enum; in `apps/web/src/lib/api.ts` add to `AuditActionValue`; in `components/admin/AuditDetailDrawer.tsx` add label `role_change: "角色变更"`.

- [ ] **Step 4: Add admin role routes**

`apps/server/src/routes/admin-roles.ts`:

```ts
const permissionsSchema = z.array(z.string()).max(20);
const roleInput = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).nullable().optional(),
  permissions: permissionsSchema,
  datasourceIds: z.array(z.string().uuid()).max(200),
});

app.get("/api/admin/roles", { preHandler: app.requirePermission("admin.roles") }, async () => ({
  roles: listRoles(db).map((role) => ({ ...role, isBuiltin: role.builtin === 1 })),
}));

app.get("/api/admin/roles/:id", { preHandler: app.requirePermission("admin.roles") }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const role = roleDetail(db, id);
  if (!role) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "角色不存在" } });
  return { role };
});

app.post("/api/admin/roles", { preHandler: app.requirePermission("admin.roles") }, async (request, reply) => {
  const parsed = roleInput.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: { code: "VALIDATION", message: "参数不合法" } });
  if (findRoleByName(db, parsed.data.name)) {
    return reply.code(409).send({ error: { code: "CONFLICT", message: "角色名称已存在" } });
  }
  for (const permission of parsed.data.permissions) {
    if (!isPermission(permission)) return reply.code(400).send({ error: { code: "VALIDATION", message: `未知权限：${permission}` } });
    if (isSystemPermission(permission)) return reply.code(400).send({ error: { code: "SYSTEM_PERMISSION_NOT_ALLOWED", message: "自定义角色不能包含系统权限" } });
  }
  const role = createRole(db, parsed.data);
  safeRecordAuditEvent(db, { actorUserId: request.authUser!.id, action: "role_change", ip: request.ip, detail: { roleId: role.id, action: "create", permissions: parsed.data.permissions, datasourceIds: parsed.data.datasourceIds }, sqlText: `role:${role.name}` });
  return reply.code(201).send({ role: roleDetail(db, role.id) });
});
```

`PATCH` validates the same, forbids renaming `builtin === 1`, rejects duplicate name, replaces permissions/datasources in a transaction, writes audit. `DELETE` rejects `builtin === 1` with `BUILTIN_ROLE`, otherwise deletes and audits. `datasourceIds` must all exist (`findDatasource`), else 400 `DATASOURCE_NOT_FOUND`.

`roleDetail(db,id)` returns summary + `permissions` + `datasourceIds` + `isBuiltin`.

Register in `app.ts`: `await adminRoleRoutes(app, { db });` after adminUserRoutes.

- [ ] **Step 5: Write route tests**

`apps/server/test/admin-roles.test.ts`:
- admin creates role with `chat.use`, `export.data`, one datasource → 201
- create with `admin.users` → 400 `SYSTEM_PERMISSION_NOT_ALLOWED`
- duplicate name → 409
- non-admin GET → 403
- PATCH member name → 400 `BUILTIN_ROLE`
- DELETE role assigned to user → 200 and assignment gone
- audit row `action = "role_change"` exists.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @datachat/server exec vitest run test/roles-repo.test.ts test/admin-roles.test.ts && pnpm --filter @datachat/server typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/repositories/roles.ts apps/server/src/routes/admin-roles.ts apps/server/src/services/audit.ts apps/server/src/db/schema.ts apps/server/src/app.ts apps/web/src/lib/api.ts apps/web/src/components/admin/AuditDetailDrawer.tsx apps/server/test/roles-repo.test.ts apps/server/test/admin-roles.test.ts
git commit -m "feat(rbac): add role management api"
```

---

### Task 4: User Role Assignment

**Files:**
- Modify: `apps/server/src/routes/admin-users.ts`
- Modify: `apps/server/src/db/repositories/roles.ts`
- Modify: `apps/server/src/db/repositories/users.ts` (only if a public-user helper is needed)
- Test: `apps/server/test/admin-users-roles.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/server/test/admin-users-roles.test.ts`:

```ts
it("assigns multiple roles and does not assign the member role twice", async () => {
  const app = await buildTestApp();
  const admin = await loginAsAdmin(app);
  const role = createRole(app.db, {
    name: "analyst",
    permissions: ["chat.use", "export.data"],
    datasourceIds: [],
  });
  const create = await app.inject({
    method: "POST", url: "/api/admin/users", cookies: admin.cookies,
    payload: { username: "bob", password: "password123", roleIds: [role.id] },
  });
  expect(create.statusCode).toBe(201);
  const update = await app.inject({
    method: "PATCH", url: `/api/admin/users/${create.json().user.id}`, cookies: admin.cookies,
    payload: { roleIds: [role.id, "role_member"] },
  });
  expect(update.statusCode).toBe(200);
  const list = await app.inject({ method: "GET", url: "/api/admin/users", cookies: admin.cookies });
  expect(list.json().users.find((u: { username: string }) => u.username === "bob").roleIds.sort())
    .toEqual([role.id, "role_member"].sort());
});
```

- [ ] **Step 2: Extend API schemas**

`createUserSchema` adds `roleIds: z.array(z.string()).max(20).optional()`.
`updateUserSchema` adds the same.
On create with no `roleIds`, use `["role_member"]`; on create with `roleIds`, validate all IDs and do **not** implicitly add member. Reject `roleIds: []` on create and PATCH with 400 `ROLE_REQUIRED`.
`setUserRoles(db, userId, roleIds)` validates role existence and replaces rows in a transaction.

`GET /api/admin/users` returns:

```ts
{
  users: rows.map((row) => ({
    ...toPublicUser(row),
    roleIds: listRoleIdsForUser(db, row.id),
    roles: listRolesForUser(db, row.id).map((role) => ({ id: role.id, name: role.name })),
  })),
}
```

Create/update responses include the same fields.

- [ ] **Step 3: Audit assignments**

For create and update, include `roleIds: listRoleIdsForUser(db, row.id)` in the `user_create` / `user_update` audit detail.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @datachat/server exec vitest run test/admin-users-roles.test.ts test/admin-users.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/admin-users.ts apps/server/src/db/repositories/roles.ts apps/server/test/admin-users-roles.test.ts
git commit -m "feat(rbac): assign roles to users"
```

---

### Task 5: Datasource Filtering and HTTP Permission Gates

**Files:**
- Modify: `apps/server/src/db/repositories/datasources.ts`
- Modify: `apps/server/src/routes/datasources.ts`
- Modify: `apps/server/src/routes/datasource-schema.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Modify: `apps/server/src/routes/questions.ts`
- Modify: `apps/server/src/routes/reports.ts`
- Modify: `apps/server/src/routes/shares.ts`
- Modify: `apps/server/src/routes/artifacts.ts`
- Modify: `apps/server/src/routes/models.ts`
- Modify: `apps/server/src/routes/admin-*.ts`, `ops.ts`, `audit.ts`
- Test: `apps/server/test/rbac-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

`apps/server/test/rbac-routes.test.ts`: seed a role with only `chat.use` and one datasource; assign to user; assert:

```ts
expect((await get("/api/conversations")).statusCode).toBe(200);
expect((await post("/api/reports", body)).statusCode).toBe(403);
expect((await post("/api/shares", body)).statusCode).toBe(403);
expect((await get(`/api/artifacts/${id}/download?format=csv`)).statusCode).toBe(403);
expect((await get("/api/admin/roles")).statusCode).toBe(403);
```

Add a second case: user without `chat.use` gets 403 on `/api/conversations` and `/api/conversations/:id/messages`.

- [ ] **Step 2: Replace datasource list filter**

`listDatasourcesForUser(db, access: UserAccess)`:

```ts
if (access.datasourceIds === null) return db.select().from(datasources).all();
const ids = [...access.datasourceIds];
if (ids.length === 0) return [];
return db.select().from(datasources).where(inArray(datasources.id, ids)).all();
```

Update `routes/datasources.ts` to `listDatasourcesForUser(db, request.access!)`. Update all `userCanAccess` call sites to `canAccessDatasource(request.access!, id)`; remove `role === "admin"` checks for datasource access.

- [ ] **Step 3: Gate conversation routes**

In `routes/conversations.ts`, replace `preHandler: app.authenticate` with `preHandler: app.requirePermission("chat.use")` on all user-facing routes (list, create, detail, patch title/model/thinking, delete, message, retry, abort). In the message handler, if `body.skill` is present and the user lacks `skill.use`, return 403.

In `routes/questions.ts`, use `chat.use`.

- [ ] **Step 4: Gate reports, shares, artifacts**

- `POST /api/reports`: `report.create`
- `GET/DELETE /api/reports/:id`: keep `authenticate` + owner/admin
- `POST /api/shares`: `share.create`
- `DELETE /api/shares/:id`: keep `authenticate` + owner/admin
- `GET /api/artifacts/:id`: `chat.use` + owner/admin
- `GET /api/artifacts/:id/download`: `export.data` + owner/admin

For `report.create`, also verify the referenced artifact belongs to the user/conversation, as today.

- [ ] **Step 5: Gate admin routes**

Replace `app.requireAdmin` with:

| Route file | Permission |
| --- | --- |
| `admin-users.ts` | `admin.users` |
| `admin-roles.ts` | `admin.roles` |
| `datasources.ts` admin handlers, `admin-users.ts` grant handlers, `datasource-schema.ts` refresh | `admin.datasources` |
| `admin-skills.ts` | `admin.skills` |
| `admin-mcp.ts` | `admin.mcp` |
| `admin-settings.ts`, `admin-llm-providers.ts` | `admin.settings` |
| `admin-audit.ts` / `audit.ts` | `admin.audit` |
| `ops.ts` | `admin.ops` |

`admin-users.ts` grant routes must use `admin.datasources`, not `admin.users`.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @datachat/server exec vitest run test/rbac-routes.test.ts test/conversations-api.test.ts test/reports-api.test.ts test/shares-api.test.ts test/artifacts-api.test.ts test/admin-users.test.ts`
Expected: PASS; fix tests that assumed any logged-in user could access a route.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/db/repositories/datasources.ts apps/server/src/routes apps/server/test/rbac-routes.test.ts
git commit -m "feat(rbac): enforce permissions on http routes"
```

---

### Task 6: Agent Skills and MCP Gates

**Files:**
- Modify: `apps/server/src/agent/resources.ts`
- Modify: `apps/server/src/agent/session.ts`
- Modify: `apps/server/src/agent/runtime.ts`
- Modify: `apps/server/src/routes/conversations.ts` (skills list)
- Test: `apps/server/test/rbac-agent.test.ts`
- Modify: `apps/server/test/helpers/*` to assign the member role to test users by default

- [ ] **Step 1: Write the failing agent test**

`apps/server/test/rbac-agent.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildResourceSettings } from "../src/agent/resources.js";

describe("agent resource settings", () => {
  it("drops skills and mcp when permissions are absent", () => {
    expect(buildResourceSettings({ canUseSkills: false, canUseMcp: false, skillsDir: "/tmp/skills" })).toEqual({
      additionalSkillPaths: [],
      mcpEnabled: false,
    });
  });

  it("keeps skills and mcp when permissions are present", () => {
    expect(buildResourceSettings({ canUseSkills: true, canUseMcp: true, skillsDir: "/tmp/skills" })).toEqual({
      additionalSkillPaths: ["/tmp/skills"],
      mcpEnabled: true,
    });
  });
});
```

- [ ] **Step 2: Make resources conditional**

`ConversationResourcesInput` adds `skillsDir?: string; canUseSkills: boolean; canUseMcp: boolean`.
Export a pure helper used by `createConversationResources`:

```ts
export function buildResourceSettings(input: {
  canUseSkills: boolean;
  canUseMcp: boolean;
  skillsDir?: string;
}): { additionalSkillPaths: string[]; mcpEnabled: boolean } {
  return {
    additionalSkillPaths:
      input.canUseSkills && input.skillsDir ? [input.skillsDir] : [],
    mcpEnabled: input.canUseMcp,
  };
}
```

In `createConversationResources`:

```ts
const settings = buildResourceSettings(input);
const loader = new DefaultResourceLoader({
  cwd: workspaceDir,
  agentDir: input.config.agentDir,
  eventBus,
  additionalSkillPaths: settings.additionalSkillPaths,
  ...(settings.mcpEnabled
    ? {
        extensionFactories: [
          createMcpExtension({
            loadConfig: () =>
              loadMcpFor({
                db: input.db,
                config: input.config,
                datasourceId: input.datasourceId,
              }),
          }),
        ],
      }
    : {}),
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  systemPrompt: renderSystemPrompt({
    datasourceName: input.datasourceName,
    datasourceType: input.datasourceType,
    database: input.database,
  }),
});
```

`CreateConversationSessionInput.skillsDir` becomes `skillsDir?: string`.

- [ ] **Step 3: Resolve access in RuntimeManager**

In the default `createSession` factory:

```ts
const user = findUserById(this.db, userId);
const access = user ? resolveUserAccess(this.db, user) : undefined;
const canUseSkills = access?.permissions.has("skill.use") ?? false;
const canUseMcp = access?.permissions.has("mcp.use") ?? false;
const skillsDir = canUseSkills
  ? await materializeSkills(this.db, { conversationId: conversation.id, datasourceId: conversation.datasourceId, dataDir: this.config.dataDir })
  : undefined;
return createConversationSession({ ..., skillsDir, canUseSkills, canUseMcp, ... });
```

Pass booleans through to `createConversationResources`.

- [ ] **Step 4: Gate the skills list and skill sends**

`GET /api/conversations/:id/skills`: if no `skill.use`, return `{ skills: [] }`.
`POST /messages` with `skill`: require `skill.use` (Task 5) and reject unknown skills as today.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @datachat/server exec vitest run test/rbac-agent.test.ts test/agent-e2e.test.ts test/skills.test.ts`
Expected: PASS. Update test user helpers to assign `role_member` so existing tests keep skills/MCP.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent apps/server/src/routes/conversations.ts apps/server/test apps/server/src/db/repositories/roles.ts
git commit -m "feat(rbac): gate agent skills and mcp by permission"
```

---

### Task 7: Web Permission Plumbing, Roles Page, and Users Page

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/query.ts`
- Create: `apps/web/src/lib/use-can.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Create: `apps/web/src/pages/admin/RolesPage.tsx`
- Create: `apps/web/src/pages/admin/UsersPage.tsx`
- Test: `apps/web/src/pages/admin/RolesPage.test.tsx`
- Test: `apps/web/src/pages/admin/UsersPage.test.tsx`

- [ ] **Step 1: Extend API types**

```ts
export interface MeResponse {
  user: SessionUser;
  permissions: Permission[];
  roles: { id: string; name: string }[];
}

export interface AdminRole {
  id: string; name: string; description: string | null; builtin: boolean;
  userCount: number; permissionCount: number; datasourceCount: number;
  permissions: string[]; datasourceIds: string[];
}

export function fetchMe(): Promise<MeResponse>
export function listAdminRoles(): Promise<{ roles: AdminRole[] }>
export function getAdminRole(id: string): Promise<{ role: AdminRole }>
export function createAdminRole(input: RoleInput): Promise<{ role: AdminRole }>
export function updateAdminRole(id: string, input: Partial<RoleInput>): Promise<{ role: AdminRole }>
export function deleteAdminRole(id: string): Promise<{ ok: true }>
```

Add `roles: queryKeys.adminRoles`, `role: (id) => ...`.

- [ ] **Step 2: Add `useCan`**

`apps/web/src/lib/use-can.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import type { Permission } from "@datachat/shared";
import { fetchMe } from "./api";
import { queryKeys } from "./query";

export function useCan(permission: Permission): boolean {
  const { data } = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  return data?.permissions.includes(permission) ?? false;
}

export function usePermissions(): Set<Permission> {
  const { data } = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  return new Set(data?.permissions ?? []);
}
```

- [ ] **Step 3: Add admin routes and nav**

`App.tsx` adds lazy routes `/admin/roles` and `/admin/users`, both under `RequireAdmin` (the page itself calls admin APIs; system permissions remain admin-only).
`AppShell` adds links:
- 用户管理 → `/admin/users` (`Users` icon)
- 角色管理 → `/admin/roles` (`ShieldCheck` icon)
before 数据源.

`AppShell` keeps the existing `user.role === "admin"` check (system permissions are admin-only, so this is equivalent) and adds links:
- 用户管理 → `/admin/users` (`Users` icon)
- 角色管理 → `/admin/roles` (`ShieldCheck` icon)
before 数据源.

- [ ] **Step 4: Build `RolesPage`**

Layout:
- header + “新建角色”
- table/cards: name, description, `permissionCount`, `datasourceCount`, `userCount`, builtin badge
- editor Drawer/Dialog:
  - name/description inputs
  - permission groups from `PERMISSION_GROUPS`; system group rendered disabled with note
  - datasource checkboxes from `listDatasources()`
  - builtin member: name input disabled, delete hidden
  - save mutation; 409/400 error via `describeApiError`

No placeholder UI: every checkbox toggles state, `onSubmit` sends `{ name, description, permissions, datasourceIds }`.

- [ ] **Step 5: Build `UsersPage`**

- table: username, displayName, role badge, roles, status
- create dialog: username/password/displayName/role (`user`/`admin`)/roleIds
- edit dialog: displayName, role, status, password reset, roleIds
- role checkboxes loaded from `listAdminRoles()`
- preserve last-admin error display
- link to datasource grant editing remains on data source page

- [ ] **Step 6: Web tests**

`RolesPage.test.tsx`: render with mocked `listAdminRoles`/`listDatasources`; assert system permission is disabled; create sends checked functional permissions and datasource IDs.
`UsersPage.test.tsx`: assert roleIds from API render checked; save sends selected roleIds.

Run: `pnpm --filter @datachat/web test -- RolesPage UsersPage`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib apps/web/src/App.tsx apps/web/src/components/AppShell.tsx apps/web/src/pages/admin/RolesPage.tsx apps/web/src/pages/admin/UsersPage.tsx apps/web/src/pages/admin/RolesPage.test.tsx apps/web/src/pages/admin/UsersPage.test.tsx apps/web/src/pages/admin/UsersPage.tsx
git commit -m "feat(web): add role and user administration"
```

---

### Task 8: Chat UI Permission Gates

**Files:**
- Modify: `apps/web/src/pages/ChatPage.tsx`
- Modify: `apps/web/src/components/chat/MessageList.tsx`
- Modify: `apps/web/src/components/chat/MessageItem.tsx`
- Modify: `apps/web/src/components/chat/ResultTable.tsx` (or its action wrapper)
- Modify: `apps/web/src/components/chat/ShareDialog.tsx` (only if it renders its own trigger)
- Test: `apps/web/src/pages/ChatPage.test.tsx`
- Test: `apps/web/src/components/chat/MessageItem.test.tsx`

- [ ] **Step 1: Write failing UI tests**

In `MessageItem.test.tsx`, render a result with `canCreateReport={false}` and `canExport={false}`; expect no “生成报告” and no “下载 CSV”. Render with true; expect both.

In `ChatPage.test.tsx`, mock `fetchMe` with only `["chat.use"]`; expect the share button absent and skills query not requested.

- [ ] **Step 2: Pass flags from ChatPage**

Compute:

```ts
const permissions = new Set(meQuery.data?.permissions ?? []);
const canReport = permissions.has("report.create");
const canShare = permissions.has("share.create");
const canExport = permissions.has("export.data");
const canUseSkills = permissions.has("skill.use");
```

Pass `canReport`, `canExport` through `MessageList` → `MessageItem` → result actions.
Pass `canShare` to the topbar share button (render only when true).
Set `skillsQuery.enabled = Boolean(conversationId) && canUseSkills`; pass `skills={canUseSkills ? skills : []}`.

- [ ] **Step 3: Gate actions**

- Share button: `{canShare && <Button ...>分享</Button>}`
- Result actions: hide “生成报告” when `!canReport`; hide download buttons when `!canExport`.
- Composer `/` menu naturally disappears with empty skills.
- If `permissions` lacks `chat.use`, render a centered “当前角色没有对话权限，请联系管理员” page instead of the composer.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @datachat/web test -- ChatPage MessageItem`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/ChatPage.tsx apps/web/src/components/chat/MessageList.tsx apps/web/src/components/chat/MessageItem.tsx apps/web/src/components/chat/ResultTable.tsx apps/web/src/components/chat/ShareDialog.tsx apps/web/src/pages/ChatPage.test.tsx apps/web/src/components/chat/MessageItem.test.tsx
git commit -m "feat(web): honor role permissions in chat ui"
```

---

### Task 9: Documentation, Full Verification, and Push

**Files:**
- Modify: `README.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/feature-map.md` (if it lists admin routes)
- Modify: `docs/superpowers/specs/2026-11-13-rbac-roles-design.md` (status → 已实现)
- Modify: `docs/superpowers/plans/2026-11-13-rbac-roles.md` (check boxes)

- [ ] **Step 1: Document**

README add “角色与权限”:
- 14 permissions table (or link spec)
- built-in admin/member behavior
- multi-role union; direct grants union
- role UI paths `/admin/roles`, `/admin/users`
- permission changes immediate for HTTP/UI; Skills/MCP next session
- backup before upgrade

Roadmap mark RBAC delivered and move scheduled tasks to next.

- [ ] **Step 2: Run full verification**

```bash
pnpm lint
pnpm verify
```

Expected: lint 0 errors, all tests pass, build succeeds. Fix any snapshots/tests affected by new `/api/auth/me` fields and route guards.

- [ ] **Step 3: Browser smoke**

Login as admin → create role “财务” with `chat.use` + one datasource → create user with that role → login as user → only that datasource visible → chat works → report/share/export buttons absent → direct API calls 403. Revoke `chat.use` → chat page shows no-permission.

- [ ] **Step 4: Commit and push**

```bash
git add README.md docs/roadmap.md docs/feature-map.md docs/superpowers/specs/2026-11-13-rbac-roles-design.md docs/superpowers/plans/2026-11-13-rbac-roles.md
git commit -m "docs: document rbac roles and permissions"
git push origin main
```

---

## Self-Review

- Every spec section maps to Tasks 1–9: permissions/data model (1), resolver/guards (2), roles API (3), users (4), HTTP gates (5), agent gates (6), UI (7–8), docs/verification (9).
- Type names are consistent: `Permission`, `UserAccess`, `RoleSummary`, `RoleDetail`, `MeResponse`, `canReport/canExport/canShare/canUseSkills`.
- No task allows custom roles to hold `admin.*`; role route validation enforces it.
- Existing direct grants remain in `resolveUserAccess` and role deletion only removes `role_*` rows.
- Migration ordering: 0010 creates tables and member seed before 0011 rebuilds audit; tests expect 12 migrations.
