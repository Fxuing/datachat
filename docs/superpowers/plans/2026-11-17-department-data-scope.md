# 部门与行级数据权限实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DataChat 中落地部门树、部门数据源授权与按部门行级过滤，并保证 SQL、Schema、结果文件、分享和定时任务使用同一套数据边界。

**Architecture:** 部门树用闭包表；角色继续管功能权限，部门只决定数据边界。受控数据源按表配置 `public/scoped/denied`，SQL 在 `guardSql` 之后、执行之前用 AST 改成带过滤的派生表；每次 run 记录范围快照，结果文件与分享按快照二次校验。管理端提供覆盖门禁、映射导入、预览与诊断，用户侧给结构化拒绝原因。

**Tech Stack:** TypeScript、Fastify、Drizzle/SQLite、node-sql-parser、React 19、TanStack Query、Radix UI、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-17-department-data-scope-design.md`

---

## 文件结构

**服务端新增**
- `apps/server/src/db/repositories/departments.ts`：部门树、闭包、用户部门、部门授权、有效部门子树。
- `apps/server/src/db/repositories/data-scope.ts`：表策略、部门映射、覆盖检查、诊断。
- `apps/server/src/services/data-scope.ts`：把用户/部门/策略解析成一次查询的 `DataScopePlan`。
- `apps/server/src/agent/sql/scope.ts`：纯函数，按计划改写 SQL AST。
- `apps/server/src/services/scope-access.ts`：run 快照与结果可见性校验。
- `apps/server/src/routes/admin-departments.ts`：部门树、成员、部门授权、导入。
- `apps/server/src/routes/admin-data-scope.ts`：策略、映射、覆盖、预览、开关、诊断。
- `apps/server/test/departments.test.ts`、`data-scope.test.ts`、`scope-rewrite.test.ts`、`scope-access.test.ts`、`admin-departments.test.ts`、`admin-data-scope.test.ts`。

**服务端修改**
- `packages/shared/src/permissions.ts`：新增 `admin.departments`。
- `apps/server/src/db/schema.ts`、`apps/server/drizzle/0013_departments_scope.sql`、journal。
- `apps/server/src/auth/access.ts`：`UserAccess.departmentIds`，合并部门数据源授权。
- `apps/server/src/services/query-service.ts`：查询前解析范围并改写 SQL，保存 run 快照。
- `apps/server/src/agent/tools/db-schema.ts`：按策略过滤表。
- `apps/server/src/routes/{artifacts,reports,shares,admin-users,app}.ts`。
- `apps/server/src/services/audit.ts`、`apps/web/src/lib/api.ts`：审计 action 类型。

**前端新增**
- `apps/web/src/pages/admin/DepartmentsPage.tsx`：部门树、成员、数据源授权、导入。
- `apps/web/src/pages/admin/DatasourceScopePage.tsx`：策略向导、映射导入、覆盖检查、诊断。
- `apps/web/src/components/admin/{DepartmentTree,ScopePolicyTable,ScopeDiagnostics}.tsx`。
- 对应测试：`DepartmentsPage.test.tsx`、`DatasourceScopePage.test.tsx`。

**前端修改**
- `apps/web/src/App.tsx`、`components/admin/AdminShell.tsx`：新增两个路由与菜单。
- `apps/web/src/pages/admin/UsersPage.tsx`：用户部门多选。
- `apps/web/src/pages/ChatPage.tsx`、`components/chat/MessageItem.tsx`：范围徽标与拒绝提示。
- `apps/web/src/lib/api.ts`、`lib/query.ts`：API 类型与 query keys。

---

## Task 1: 权限常量、表结构与迁移

**Files:**
- Modify: `packages/shared/src/permissions.ts`
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0013_departments_scope.sql`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Modify: `apps/server/test/db.test.ts`
- Test: `apps/server/test/data-scope-schema.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/data-scope-schema.test.ts
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, isSystemPermission } from "@datachat/shared";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { departmentClosure, departments, dataScopePolicies, runs } from "../src/db/schema.js";

describe("department data scope schema", () => {
  it("registers the department permission", () => {
    expect(ALL_PERMISSIONS).toContain("admin.departments");
    expect(isSystemPermission("admin.departments")).toBe(true);
  });

  it("creates organization and policy tables", () => {
    const handle = createDb(":memory:");
    migrateDb(handle.db);
    const names = handle.db
      .prepare("select name from sqlite_master where type='table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toEqual(
      expect.arrayContaining([
        "departments",
        "department_closure",
        "user_departments",
        "department_datasource_grants",
        "department_org_map",
        "data_scope_policies",
      ]),
    );
    expect(departments).toBeDefined();
    expect(departmentClosure).toBeDefined();
    expect(dataScopePolicies).toBeDefined();
    expect(runs.scopeSnapshot).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @datachat/shared build && pnpm exec vitest run apps/server/test/data-scope-schema.test.ts`

Expected: FAIL，`ALL_PERMISSIONS` 不包含 `admin.departments`，或表不存在。

- [ ] **Step 3: 新增权限常量**

```ts
// packages/shared/src/permissions.ts（在系统权限区追加）
export const SYSTEM_PERMISSIONS = [
  "admin.users",
  "admin.roles",
  "admin.departments",
  "admin.datasources",
  "admin.skills",
  "admin.mcp",
  "admin.settings",
  "admin.audit",
  "admin.ops",
] as const;
```

同时把标签加入 `PERMISSION_LABELS`、`PERMISSION_GROUPS`：

```ts
"admin.departments": "管理部门与数据范围",
```

- [ ] **Step 4: 写迁移**

```sql
-- apps/server/drizzle/0013_departments_scope.sql
CREATE TABLE `departments` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `parent_id` text REFERENCES `departments`(`id`),
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `departments_parent_idx` ON `departments` (`parent_id`);
--> statement-breakpoint
CREATE TABLE `department_closure` (
  `ancestor_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
  `descendant_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
  `depth` integer NOT NULL,
  PRIMARY KEY (`ancestor_id`, `descendant_id`)
);
--> statement-breakpoint
CREATE INDEX `department_closure_descendant_idx` ON `department_closure` (`descendant_id`);
--> statement-breakpoint
CREATE TABLE `user_departments` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `department_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
  PRIMARY KEY (`user_id`, `department_id`)
);
--> statement-breakpoint
CREATE INDEX `user_departments_department_idx` ON `user_departments` (`department_id`);
--> statement-breakpoint
CREATE TABLE `department_datasource_grants` (
  `department_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
  `datasource_id` text NOT NULL REFERENCES `datasources`(`id`) ON DELETE CASCADE,
  PRIMARY KEY (`department_id`, `datasource_id`)
);
--> statement-breakpoint
CREATE INDEX `department_datasource_grants_datasource_idx` ON `department_datasource_grants` (`datasource_id`);
--> statement-breakpoint
CREATE TABLE `department_org_map` (
  `id` text PRIMARY KEY NOT NULL,
  `datasource_id` text NOT NULL REFERENCES `datasources`(`id`) ON DELETE CASCADE,
  `department_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
  `external_id` text,
  `external_code` text,
  `external_org_code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `department_org_map_dept_unique` ON `department_org_map` (`datasource_id`, `department_id`);
--> statement-breakpoint
CREATE INDEX `department_org_map_external_id_idx` ON `department_org_map` (`datasource_id`, `external_id`);
--> statement-breakpoint
CREATE INDEX `department_org_map_external_code_idx` ON `department_org_map` (`datasource_id`, `external_code`);
--> statement-breakpoint
CREATE INDEX `department_org_map_external_org_idx` ON `department_org_map` (`datasource_id`, `external_org_code`);
--> statement-breakpoint
CREATE TABLE `data_scope_policies` (
  `id` text PRIMARY KEY NOT NULL,
  `datasource_id` text NOT NULL REFERENCES `datasources`(`id`) ON DELETE CASCADE,
  `table_name` text NOT NULL,
  `column_name` text NOT NULL,
  `value_mode` text NOT NULL,
  `null_visible` integer DEFAULT 1 NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT `data_scope_policies_value_mode_check` CHECK (`value_mode` in (
    'app_id','app_code','external_id','external_code','external_org_code'
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_scope_policies_table_unique` ON `data_scope_policies` (`datasource_id`, `table_name`);
--> statement-breakpoint
ALTER TABLE `datasources` ADD COLUMN `data_scope_mode` text DEFAULT 'off' NOT NULL
  CHECK (`data_scope_mode` in ('off','controlled'));
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `scope_snapshot` text;
--> statement-breakpoint
-- 重建 query_audit，加入部门/范围审计动作与 scope_reason。
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
  `scope_reason` text,
  `detail_json` text,
  `created_at` integer NOT NULL,
  CONSTRAINT `query_audit_action_check` CHECK (`action` in (
    'query','explain','export','login','login_failed',
    'user_create','user_update','datasource_create','datasource_update',
    'datasource_delete','grant_update','skill_change','mcp_change','role_change','ops',
    'department_change','data_scope_change','data_scope_enable'
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

- [ ] **Step 5: 更新 Drizzle schema**

在 `apps/server/src/db/schema.ts` 追加：

```ts
export const departments = sqliteTable("departments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  parentId: text("parent_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const departmentClosure = sqliteTable(
  "department_closure",
  {
    ancestorId: text("ancestor_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    descendantId: text("descendant_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    depth: integer("depth").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ancestorId, t.descendantId] })],
);
```

其余四张表按迁移字段补齐：`userDepartments`、`departmentDatasourceGrants`、`departmentOrgMap`、`dataScopePolicies`。

给现有表加字段：

```ts
// datasources
dataScopeMode: text("data_scope_mode", { enum: ["off", "controlled"] })
  .notNull()
  .default("off"),
// runs
scopeSnapshot: text("scope_snapshot"),
// queryAudit
scopeReason: text("scope_reason"),
```

并把 `queryAudit.action` 的 enum 扩展到迁移中的 18 个值。

- [ ] **Step 6: 更新迁移 journal 与测试**

`apps/server/drizzle/meta/_journal.json` 追加：

```json
{ "idx": 13, "version": "6", "when": 1794960000000, "tag": "0013_departments_scope", "breakpoints": true }
```

`apps/server/test/db.test.ts` 迁移数 `13` 改为 `14`，`APP_TABLES` 加六张新表。

- [ ] **Step 7: 运行测试**

Run: `pnpm --filter @datachat/shared build && pnpm exec vitest run apps/server/test/data-scope-schema.test.ts apps/server/test/db.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/shared/src/permissions.ts apps/server/src/db/schema.ts apps/server/drizzle apps/server/test
git commit -m "feat(data-scope): add departments and scope schema"
```

---

## Task 2: 部门树、闭包与访问并集

**Files:**
- Create: `apps/server/src/db/repositories/departments.ts`
- Modify: `apps/server/src/auth/access.ts`
- Test: `apps/server/test/departments.test.ts`
- Modify: `apps/server/test/access.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/departments.test.ts
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import {
  createDepartment,
  deleteDepartment,
  effectiveDepartmentIds,
  listDepartmentTree,
  moveDepartment,
  replaceDepartmentGrants,
  setUserDepartments,
} from "../src/db/repositories/departments.js";

function db() {
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  return handle.db;
}

describe("departments", () => {
  it("builds closure and returns the subtree", () => {
    const database = db();
    const root = createDepartment(database, { name: "总部" });
    const sales = createDepartment(database, { name: "销售", parentId: root.id });
    const east = createDepartment(database, { name: "华东", parentId: sales.id });
    const ids = effectiveDepartmentIds(database, [sales.id]);
    expect([...ids].sort()).toEqual([sales.id, east.id].sort());
    expect(listDepartmentTree(database)[0].children[0].children[0].name).toBe("华东");
  });

  it("rejects moving a department under its descendant", () => {
    const database = db();
    const root = createDepartment(database, { name: "总部" });
    const child = createDepartment(database, { name: "销售", parentId: root.id });
    expect(() => moveDepartment(database, root.id, child.id)).toThrow(/子部门/);
  });

  it("inherits department grants down the tree", () => {
    const database = db();
    const root = createDepartment(database, { name: "总部" });
    const child = createDepartment(database, { name: "销售", parentId: root.id });
    replaceDepartmentGrants(database, root.id, ["ds-1"]);
    expect(listDepartmentGrants(database, child.id)).toEqual(["ds-1"]);
  });

  it("refuses to delete a department with children", () => {
    const database = db();
    const root = createDepartment(database, { name: "总部" });
    createDepartment(database, { name: "销售", parentId: root.id });
    expect(() => deleteDepartment(database, root.id)).toThrow(/子部门/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/server/test/departments.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现仓储**

```ts
// apps/server/src/db/repositories/departments.ts
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  departmentClosure,
  departmentDatasourceGrants,
  departments,
  userDepartments,
} from "../schema.js";

export class DepartmentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface DepartmentNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  children: DepartmentNode[];
}

export function createDepartment(
  db: Db,
  input: { name: string; parentId?: string | null; sortOrder?: number },
): { id: string } {
  const id = randomUUID();
  const now = Date.now();
  db.transaction((tx) => {
    if (input.parentId && !tx.select().from(departments).where(eq(departments.id, input.parentId)).get()) {
      throw new DepartmentError("PARENT_NOT_FOUND", "上级部门不存在");
    }
    tx.insert(departments)
      .values({
        id,
        name: input.name.trim(),
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    rebuildClosure(tx);
  });
  return { id };
}

export function rebuildClosure(db: Db): void {
  db.delete(departmentClosure).run();
  const rows = db.select().from(departments).all();
  const byParent = new Map<string | null, typeof rows>();
  for (const row of rows) {
    const key = row.parentId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  const insert = (ancestor: string, node: (typeof rows)[number], depth: number) => {
    db.insert(departmentClosure)
      .values({ ancestorId: ancestor, descendantId: node.id, depth })
      .run();
    for (const child of byParent.get(node.id) ?? []) insert(ancestor, child, depth + 1);
  };
  for (const root of byParent.get(null) ?? []) insert(root.id, root, 0);
}

export function moveDepartment(db: Db, id: string, newParentId: string): void {
  if (id === newParentId) throw new DepartmentError("SELF_PARENT", "部门不能作为自己的上级");
  const descendants = new Set(effectiveDepartmentIds(db, [id]));
  if (descendants.has(newParentId)) throw new DepartmentError("CYCLE", "不能移动到自己的子部门下");
  db.update(departments)
    .set({ parentId: newParentId, updatedAt: Date.now() })
    .where(eq(departments.id, id))
    .run();
  rebuildClosure(db);
}

export function updateDepartment(
  db: Db,
  id: string,
  input: { name?: string; sortOrder?: number },
): void {
  db.update(departments)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(departments.id, id))
    .run();
}

export function listAllDepartmentIds(db: Db): string[] {
  return db.select({ id: departments.id }).from(departments).all().map((row) => row.id);
}

export function deleteDepartment(db: Db, id: string): void {
  const children = db.select().from(departments).where(eq(departments.parentId, id)).all();
  if (children.length > 0) throw new DepartmentError("HAS_CHILDREN", "该部门仍有子部门");
  const members = db.select().from(userDepartments).where(eq(userDepartments.departmentId, id)).all();
  if (members.length > 0) throw new DepartmentError("HAS_MEMBERS", "该部门仍有成员");
  db.delete(departments).where(eq(departments.id, id)).run();
  rebuildClosure(db);
}

export function effectiveDepartmentIds(db: Db, roots: string[]): Set<string> {
  if (roots.length === 0) return new Set();
  return new Set(
    db
      .select({ id: departmentClosure.descendantId })
      .from(departmentClosure)
      .where(inArray(departmentClosure.ancestorId, roots))
      .all()
      .map((row) => row.id),
  );
}

export function listDepartmentTree(db: Db): DepartmentNode[] {
  const rows = db.select().from(departments).orderBy(asc(departments.sortOrder), asc(departments.name)).all();
  const map = new Map<string, DepartmentNode>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      children: [],
    });
  }
  const roots: DepartmentNode[] = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) map.get(node.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function setUserDepartments(db: Db, userId: string, departmentIds: string[]): void {
  db.transaction((tx) => {
    tx.delete(userDepartments).where(eq(userDepartments.userId, userId)).run();
    for (const departmentId of new Set(departmentIds)) {
      tx.insert(userDepartments).values({ userId, departmentId }).run();
    }
  });
}

export function listUserDepartments(db: Db, userId: string): string[] {
  return db
    .select({ id: userDepartments.departmentId })
    .from(userDepartments)
    .where(eq(userDepartments.userId, userId))
    .all()
    .map((row) => row.id);
}

export function replaceDepartmentGrants(db: Db, departmentId: string, datasourceIds: string[]): void {
  db.transaction((tx) => {
    tx.delete(departmentDatasourceGrants).where(eq(departmentDatasourceGrants.departmentId, departmentId)).run();
    for (const datasourceId of new Set(datasourceIds)) {
      tx.insert(departmentDatasourceGrants).values({ departmentId, datasourceId }).run();
    }
  });
}

export function listDepartmentGrants(db: Db, departmentId: string): string[] {
  const roots = [departmentId];
  const subtree = [...effectiveDepartmentIds(db, roots)];
  if (subtree.length === 0) return [];
  return db
    .select({ id: departmentDatasourceGrants.datasourceId })
    .from(departmentDatasourceGrants)
    .where(inArray(departmentDatasourceGrants.departmentId, subtree))
    .all()
    .map((row) => row.id);
}
```

- [ ] **Step 4: 扩展 `UserAccess`**

```ts
// apps/server/src/auth/access.ts
export interface UserAccess {
  isAdmin: boolean;
  permissions: Set<Permission>;
  datasourceIds: Set<string> | null;
  /** Expanded subtree of the user's departments; null means all (admin). */
  departmentIds: Set<string> | null;
}

export function resolveUserAccess(db: Db, user: UserRow): UserAccess {
  if (user.role === "admin") {
    return { isAdmin: true, permissions: new Set(ALL_PERMISSIONS), datasourceIds: null, departmentIds: null };
  }
  const departments = listUserDepartments(db, user.id);
  const departmentIds = effectiveDepartmentIds(db, departments);
  const roleIds = listRoleIdsForUser(db, user.id);
  const permissions = permissionsForUserRoles(db, roleIds);
  const datasourceIds = new Set([
    ...datasourceIdsForUserRoles(db, roleIds),
    ...datasourceIdsForUser(db, user.id),
    ...listDepartmentGrantsForUser(db, departmentIds),
  ]);
  return { isAdmin: false, permissions, datasourceIds, departmentIds };
}
```

`listDepartmentGrantsForUser` 在 departments 仓储中按 `departmentIds` 查询并去重。

- [ ] **Step 5: 更新访问测试**

在 `apps/server/test/access.test.ts` 新增：部门授权让用户获得数据源；父部门授权对子部门成员生效；`departmentIds` 包含子树。

- [ ] **Step 6: 运行测试**

Run: `pnpm exec vitest run apps/server/test/departments.test.ts apps/server/test/access.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/db/repositories/departments.ts apps/server/src/auth/access.ts apps/server/test
git commit -m "feat(data-scope): resolve department access"
```

---

## Task 3: 表策略、部门映射与导入

**Files:**
- Create: `apps/server/src/db/repositories/data-scope.ts`
- Create: `apps/server/src/services/scope-import.ts`
- Test: `apps/server/test/data-scope.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { createDepartment } from "../src/db/repositories/departments.js";
import {
  coverageForDatasource,
  importDepartmentMappings,
  listScopePolicies,
  upsertScopePolicy,
} from "../src/db/repositories/data-scope.js";

it("validates mapping rows and reports coverage", () => {
  const db = createDb(":memory:").db;
  migrateDb(db);
  const dept = createDepartment(db, { name: "销售" });
  const result = importDepartmentMappings(db, "ds-1", [
    { departmentId: dept.id, externalId: "10", externalCode: "S10", externalOrgCode: "ORG10" },
  ]);
  expect(result).toEqual({ inserted: 1, updated: 0, errors: [] });
  expect(coverageForDatasource(db, "ds-1", [dept.id])).toMatchObject({ mapped: 1, unmapped: 0 });
});

it("rejects invalid value modes", () => {
  const db = createDb(":memory:").db;
  migrateDb(db);
  expect(() =>
    upsertScopePolicy(db, {
      datasourceId: "ds-1",
      tableName: "orders",
      columnName: "dept_id",
      valueMode: "raw" as never,
      nullVisible: true,
      enabled: true,
    }),
  ).toThrow(/value mode/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/server/test/data-scope.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现策略与映射仓储**

```ts
// apps/server/src/db/repositories/data-scope.ts
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import { dataScopePolicies, departmentOrgMap, departments } from "../schema.js";

export const VALUE_MODES = [
  "app_id",
  "app_code",
  "external_id",
  "external_code",
  "external_org_code",
] as const;
export type ValueMode = (typeof VALUE_MODES)[number];

export interface ScopePolicyRow {
  id: string;
  datasourceId: string;
  tableName: string;
  columnName: string;
  valueMode: ValueMode;
  nullVisible: boolean;
  enabled: boolean;
}

export function upsertScopePolicy(
  db: Db,
  input: Omit<ScopePolicyRow, "id">,
): { id: string } {
  if (!VALUE_MODES.includes(input.valueMode)) {
    throw new Error(`invalid value mode: ${input.valueMode}`);
  }
  const now = Date.now();
  const existing = db
    .select()
    .from(dataScopePolicies)
    .where(
      and(
        eq(dataScopePolicies.datasourceId, input.datasourceId),
        eq(dataScopePolicies.tableName, input.tableName),
      ),
    )
    .get();
  const id = existing?.id ?? randomUUID();
  if (existing) {
    db.update(dataScopePolicies)
      .set({
        columnName: input.columnName,
        valueMode: input.valueMode,
        nullVisible: input.nullVisible ? 1 : 0,
        enabled: input.enabled ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(dataScopePolicies.id, id))
      .run();
  } else {
    db.insert(dataScopePolicies)
      .values({
        id,
        datasourceId: input.datasourceId,
        tableName: input.tableName,
        columnName: input.columnName,
        valueMode: input.valueMode,
        nullVisible: input.nullVisible ? 1 : 0,
        enabled: input.enabled ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  return { id };
}

export function listScopePolicies(db: Db, datasourceId: string): ScopePolicyRow[] {
  return db
    .select()
    .from(dataScopePolicies)
    .where(eq(dataScopePolicies.datasourceId, datasourceId))
    .all()
    .map((row) => ({
      id: row.id,
      datasourceId: row.datasourceId,
      tableName: row.tableName,
      columnName: row.columnName,
      valueMode: row.valueMode as ValueMode,
      nullVisible: row.nullVisible === 1,
      enabled: row.enabled === 1,
    }));
}
```

映射导入：

```ts
// apps/server/src/services/scope-import.ts
export interface MappingInput {
  departmentId: string;
  externalId?: string | null;
  externalCode?: string | null;
  externalOrgCode?: string | null;
}

export function parseMappingCsv(text: string): MappingInput[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const [header, ...rows] = lines;
  if (!header) return [];
  const columns = header.split(",").map((item) => item.trim());
  const required = ["department_id"];
  if (!required.every((name) => columns.includes(name))) {
    throw new Error("CSV 缺少 department_id 列");
  }
  return rows.map((line) => {
    const values = line.split(",").map((item) => item.trim());
    const get = (name: string) => values[columns.indexOf(name)] || null;
    return {
      departmentId: get("department_id")!,
      externalId: get("external_id"),
      externalCode: get("external_code"),
      externalOrgCode: get("external_org_code"),
    };
  });
}

export function importDepartmentMappings(
  db: Db,
  datasourceId: string,
  rows: MappingInput[],
): { inserted: number; updated: number; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  let inserted = 0;
  let updated = 0;
  const now = Date.now();
  db.transaction((tx) => {
    for (const row of rows) {
      if (seen.has(row.departmentId)) {
        errors.push(`${row.departmentId}: 同一部门重复映射`);
        continue;
      }
      seen.add(row.departmentId);
      if (!row.externalId && !row.externalCode && !row.externalOrgCode) {
        errors.push(`${row.departmentId}: 至少填写一个外部值`);
        continue;
      }
      const department = tx
        .select({ id: departments.id })
        .from(departments)
        .where(eq(departments.id, row.departmentId))
        .get();
      if (!department) {
        errors.push(`${row.departmentId}: 部门不存在`);
        continue;
      }
      const existing = tx
        .select({ id: departmentOrgMap.id })
        .from(departmentOrgMap)
        .where(
          and(
            eq(departmentOrgMap.datasourceId, datasourceId),
            eq(departmentOrgMap.departmentId, row.departmentId),
          ),
        )
        .get();
      if (existing) {
        tx.update(departmentOrgMap)
          .set({
            externalId: row.externalId ?? null,
            externalCode: row.externalCode ?? null,
            externalOrgCode: row.externalOrgCode ?? null,
            updatedAt: now,
          })
          .where(eq(departmentOrgMap.id, existing.id))
          .run();
        updated += 1;
      } else {
        tx.insert(departmentOrgMap)
          .values({
            id: randomUUID(),
            datasourceId,
            departmentId: row.departmentId,
            externalId: row.externalId ?? null,
            externalCode: row.externalCode ?? null,
            externalOrgCode: row.externalOrgCode ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        inserted += 1;
      }
    }
  });
  return { inserted, updated, errors };
}

export function listDepartmentMappings(db: Db, datasourceId: string) {
  return db
    .select()
    .from(departmentOrgMap)
    .where(eq(departmentOrgMap.datasourceId, datasourceId))
    .all();
}
```

覆盖检查：

```ts
export function coverageForDatasource(
  db: Db,
  datasourceId: string,
  departmentIds: string[],
): { mapped: number; unmapped: number; unmappedIds: string[] } {
  const mapped = new Set(
    db.select({ id: departmentOrgMap.departmentId })
      .from(departmentOrgMap)
      .where(eq(departmentOrgMap.datasourceId, datasourceId))
      .all()
      .map((row) => row.id),
  );
  const unmappedIds = departmentIds.filter((id) => !mapped.has(id));
  return {
    mapped: departmentIds.length - unmappedIds.length,
    unmapped: unmappedIds.length,
    unmappedIds,
  };
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm exec vitest run apps/server/test/data-scope.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/db/repositories/data-scope.ts apps/server/src/services/scope-import.ts apps/server/test/data-scope.test.ts
git commit -m "feat(data-scope): manage table policies and org mappings"
```

---

## Task 4: 范围解析与 SQL AST 改写

**Files:**
- Create: `apps/server/src/services/data-scope.ts`
- Create: `apps/server/src/agent/sql/scope.ts`
- Test: `apps/server/test/scope-rewrite.test.ts`
- Test: `apps/server/test/scope-resolve.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/scope-rewrite.test.ts
import { describe, expect, it } from "vitest";
import { rewriteSqlForScope } from "../src/agent/sql/scope.js";

const plan = {
  tables: new Map([
    ["orders", { kind: "scoped", column: "dept_id", values: ["10"], nullVisible: true }],
    ["products", { kind: "public" }],
  ]),
} as const;

it("wraps a scoped table and keeps its alias", () => {
  const result = rewriteSqlForScope(
    "select o.id from orders o join products p on p.id = o.product_id",
    "postgres",
    plan,
  );
  expect(result.sql).toContain("from (select * from orders");
  expect(result.sql).toContain("dept_id in ('10') or dept_id is null");
  expect(result.appliedTables).toEqual(["orders"]);
});

it("rewrites CTEs, subqueries and unions", () => {
  const result = rewriteSqlForScope(
    "with x as (select * from orders) select * from x union all select * from orders",
    "mysql",
    plan,
  );
  expect(result.sql.match(/dept_id in/g)?.length).toBe(2);
});

it("rejects unclassified and denied tables", () => {
  expect(() => rewriteSqlForScope("select * from unknown_table", "mysql", plan)).toThrow(/未配置/);
  expect(() =>
    rewriteSqlForScope("select * from secrets", "mysql", {
      tables: new Map([["secrets", { kind: "denied" }]]),
    }),
  ).toThrow(/禁止/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/server/test/scope-rewrite.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯改写函数**

```ts
// apps/server/src/agent/sql/scope.ts
import { Parser } from "node-sql-parser";
import type { SqlDialect } from "./guard.js";

export type ScopeTable =
  | { kind: "public" }
  | { kind: "denied" }
  | { kind: "scoped"; column: string; values: string[]; nullVisible: boolean };

export interface ScopePlan {
  tables: Map<string, ScopeTable>;
}

export class ScopeRewriteError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function rewriteSqlForScope(
  sql: string,
  dialect: SqlDialect,
  plan: ScopePlan,
): { sql: string; appliedTables: string[] } {
  const parser = new Parser();
  const database = dialect === "postgres" ? "postgresql" : "mysql";
  type Ast = Record<string, unknown>;
  const ast = parser.astify(sql, { database }) as Ast;
  const cteNames = new Set<string>();
  for (const item of (ast.with as Array<{ name?: { value?: string } }> | null) ?? []) {
    if (item.name?.value) cteNames.add(item.name.value);
  }
  const applied = new Set<string>();

  const rewriteStatement = (statement: Ast): void => {
    for (const entry of (statement.from as Array<Record<string, unknown>> | null) ?? []) {
      const table = entry.table;
      if (typeof table === "string") {
        if (cteNames.has(table)) continue;
        const policy = plan.tables.get(table);
        if (!policy) {
          throw new ScopeRewriteError("TABLE_UNCLASSIFIED", `表 ${table} 尚未配置数据范围，请联系管理员`);
        }
        if (policy.kind === "denied") {
          throw new ScopeRewriteError("TABLE_DENIED", `表 ${table} 未向该数据源开放`);
        }
        if (policy.kind === "public") continue;
        const alias = typeof entry.as === "string" ? entry.as : table;
        const inner = {
          type: "select",
          columns: [{ expr: { type: "column_ref", column: "*" } }],
          from: [{ db: entry.db ?? null, table, as: null }],
          where: buildPredicate(policy),
        };
        entry.expr = { ast: inner, parentheses: true };
        entry.table = null;
        entry.as = alias;
        applied.add(table);
      } else if (entry.expr && typeof entry.expr === "object") {
        const nested = (entry.expr as { ast?: Ast }).ast;
        if (nested) rewriteStatement(nested);
      }
    }
    const next = statement._next as Ast | undefined;
    if (next) rewriteStatement(next);
  };

  rewriteStatement(ast);
  return { sql: parser.sqlify(ast, { database }), appliedTables: [...applied] };
}

function buildPredicate(policy: { column: string; values: string[]; nullVisible: boolean }) {
  const inList = {
    type: "binary_expr",
    operator: "in",
    left: { type: "column_ref", column: policy.column },
    right: {
      type: "expr_list",
      value: policy.values.map((value) => ({ type: "value", value })),
    },
  };
  if (!policy.nullVisible) return inList;
  return {
    type: "binary_expr",
    operator: "or",
    left: inList,
    right: {
      type: "binary_expr",
      operator: "is",
      left: { type: "column_ref", column: policy.column },
      right: { type: "null", value: null },
    },
  };
}
```

> 若 sqlify 对 `entry.expr` 结构不接受，用 `parser.astify("select * from (" + parser.sqlify(inner) + ") as " + quoteIdent(alias))` 回填 `entry.expr.ast`，不要拼接用户输入。

- [ ] **Step 4: 写范围解析服务**

```ts
// apps/server/src/services/data-scope.ts
import { createHash } from "node:crypto";
import type { DatasourceRow } from "../db/repositories/datasources.js";
import type { ScopePolicyRow } from "../db/repositories/data-scope.js";
import type { UserAccess } from "../auth/access.js";
import type { ScopePlan, ScopeTable } from "../agent/sql/scope.js";
import { ScopeRewriteError } from "../agent/sql/scope.js";

export interface DepartmentOrgMapRow {
  id: string;
  datasourceId: string;
  departmentId: string;
  externalId: string | null;
  externalCode: string | null;
  externalOrgCode: string | null;
}

export interface DataScopeContext {
  mode: "off" | "controlled";
  plan: ScopePlan;
  snapshot: ScopeSnapshot | null;
  departmentIds: string[];
}

export interface ScopeSnapshot {
  v: 1;
  datasourceId: string;
  mode: "controlled";
  /** 用户当时的有效期部门子树（含自身）。 */
  departments: string[];
  policyHash: string;
  createdAt: number;
}

export function hashPolicies(policies: ScopePolicyRow[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        policies.map((p) => [p.tableName, p.columnName, p.valueMode, p.nullVisible]),
      ),
    )
    .digest("hex");
}

export function buildDataScopeContext(input: {
  datasource: DatasourceRow;
  access: UserAccess;
  policies: ScopePolicyRow[];
  mappings: DepartmentOrgMapRow[];
}): DataScopeContext {
  if (input.datasource.dataScopeMode === "off") {
    return { mode: "off", plan: { tables: new Map() }, snapshot: null, departmentIds: [] };
  }
  const departmentIds = [...(input.access.departmentIds ?? new Set<string>())];
  const mappingByDept = new Map(input.mappings.map((row) => [row.departmentId, row]));
  const valuesByMode = new Map<ValueMode, Set<string>>();
  const missingMappings = new Set<string>();
  for (const departmentId of departmentIds) {
    const mapping = mappingByDept.get(departmentId);
    if (!mapping) {
      missingMappings.add(departmentId);
      continue;
    }
    for (const mode of VALUE_MODES) {
      // app_id/app_code 也走部门映射表：管理员在映射里填系统侧部门 ID/编码。
      const field = mode === "app_id" ? "externalId" : mode === "app_code" ? "externalCode" : mode;
      const value = mapping[field];
      if (!value) continue;
      const set = valuesByMode.get(mode) ?? new Set<string>();
      set.add(value);
      valuesByMode.set(mode, set);
    }
  }
  const tables = new Map<string, ScopeTable>();
  for (const policy of input.policies) {
    if (!policy.enabled) continue;
    if (policy.valueMode === "app_id" || policy.valueMode === "app_code") {
      const values = [...(valuesByMode.get(policy.valueMode) ?? [])];
      if (values.length === 0) {
        const missing = [...missingMappings].join("、") || "当前部门";
        throw new ScopeRewriteError("NO_DEPARTMENT", `部门 ${missing} 尚未分配或缺少应用部门值`);
      }
      tables.set(policy.tableName, {
        kind: "scoped",
        column: policy.columnName,
        values,
        nullVisible: policy.nullVisible,
      });
      continue;
    }
    const values = [...(valuesByMode.get(policy.valueMode) ?? [])];
    if (values.length === 0) {
      const missing = [...missingMappings].join("、") || "当前部门";
      throw new ScopeRewriteError(
        "NO_ORG_MAPPING",
        `部门 ${missing} 缺少 ${policy.valueMode} 映射值`,
      );
    }
    tables.set(policy.tableName, {
      kind: "scoped",
      column: policy.columnName,
      values,
      nullVisible: policy.nullVisible,
    });
  }
  return {
    mode: "controlled",
    plan: { tables },
    snapshot: {
      v: 1,
      datasourceId: input.datasource.id,
      mode: "controlled",
      departments: departmentIds,
      policyHash: hashPolicies(input.policies),
      createdAt: Date.now(),
    },
    departmentIds,
  };
}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm exec vitest run apps/server/test/scope-rewrite.test.ts apps/server/test/scope-resolve.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/services/data-scope.ts apps/server/src/agent/sql/scope.ts apps/server/test
git commit -m "feat(data-scope): resolve and rewrite scoped sql"
```

---

## Task 5: 查询执行、Schema 过滤与快照

**Files:**
- Modify: `apps/server/src/services/query-service.ts`
- Modify: `apps/server/src/agent/tools/db-schema.ts`
- Modify: `apps/server/src/db/repositories/runs.ts`
- Modify: `apps/server/src/services/audit.ts`
- Test: `apps/server/test/query-scope.test.ts`
- Test: `apps/server/test/db-schema-scope.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/test/query-scope.test.ts
it("rewrites the SQL before the executor and persists a snapshot", async () => {
  const db = createDb(":memory:").db;
  migrateDb(db);
  const result = await runGuardedQuery(
    { db, config: testConfig, pools: fakePools, artifacts: fakeArtifacts },
    {
      datasource: controlledDatasource,
      userId: "user-1",
      conversationId: "c-1",
      runId: "run-1",
      sql: "select * from orders",
    },
  );
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("未配置");
});

```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/server/test/query-scope.test.ts`

Expected: FAIL，`runGuardedQuery` 仍执行原始 SQL。

- [ ] **Step 3: 接入查询管线**

在 `guardSql` 成功后插入（同时把 `resolveUserAccess`、`findUserById` 加入 import）：

```ts
const user = findUserById(db, input.userId);
if (!user) {
  return { ok: false, code: "FORBIDDEN", reason: "用户不存在", auditId: "" };
}
const access = resolveUserAccess(db, user);
let scopedSql = guard.sql;
let scopeReason: string | null = null;
if (input.datasource.dataScopeMode === "controlled") {
  try {
    const policies = listScopePolicies(db, input.datasource.id);
    const mappings = listDepartmentMappings(db, input.datasource.id);
    const context = buildDataScopeContext({
      datasource: input.datasource,
      access,
      policies,
      mappings,
    });
    scopedSql = rewriteSqlForScope(guard.sql, input.datasource.type, context.plan).sql;
    if (input.runId && context.snapshot) saveRunScopeSnapshot(db, input.runId, context.snapshot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "数据范围配置错误";
    scopeReason = error instanceof ScopeRewriteError ? error.code : "SCOPE_CONFIG_INVALID";
    const auditId = recordAudit(db, {
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasource.id,
      action,
      sqlText: input.sql,
      status: "rejected",
      errorMessage: reason,
      scopeReason,
    });
    const code = error instanceof ScopeRewriteError
      ? (error.code as ScopeFailureCode)
      : "SCOPE_CONFIG_INVALID";
    return { ok: false, code, reason, auditId };
  }
}
```

把后续 `executeReadOnly({ sql: guard.sql, ...})`、审计与返回的 `guardedSql` 全部改为 `scopedSql`。

- [ ] **Step 4: 增加 run 快照仓储**

```ts
// apps/server/src/db/repositories/runs.ts
export function saveRunScopeSnapshot(db: Db, runId: string, snapshot: ScopeSnapshot): void {
  db.update(runs).set({ scopeSnapshot: JSON.stringify(snapshot) }).where(eq(runs.id, runId)).run();
}
```

- [ ] **Step 5: 扩展失败码与审计字段**

`apps/server/src/services/query-service.ts`：

```ts
export type ScopeFailureCode =
  | "NO_DEPARTMENT"
  | "NO_ORG_MAPPING"
  | "TABLE_UNCLASSIFIED"
  | "TABLE_DENIED"
  | "SCOPE_CONFIG_INVALID";

export type QueryFailureCode =
  | GuardErrorCode
  | ScopeFailureCode
  | "FORBIDDEN"
  | "SQL_ERROR"
  | "SQL_TIMEOUT"
  | "SQL_ABORTED";
```

`apps/server/src/services/audit.ts` 的 `AuditEventInput` 增加 `scopeReason?: string | null`，`recordAudit` 写入 `queryAudit.scopeReason`；`AuditAction` 增加 `department_change`、`data_scope_change`、`data_scope_enable`。

- [ ] **Step 6: 过滤 db_schema**

在 `apps/server/src/agent/tools/db-schema.ts`：

```ts
const policies = datasource.dataScopeMode === "controlled"
  ? listScopePolicies(ctx.db, datasource.id)
  : [];
const denied = new Set(policies.filter((policy) => !policy.enabled).map((policy) => policy.tableName));
const visibleTables = snapshot.tables.filter((table) => !denied.has(table.name));
```

实际策略是：`denied` 不存在显式列表时，未分类表默认拒绝；`public` 放行；`scoped` 放行并返回 `scoped:true`。在 `renderTables` 增加“数据范围”列。

- [ ] **Step 7: 更新审计 action 类型**

`apps/server/src/services/audit.ts` 的 `AuditAction` 增加：

```ts
| "department_change"
| "data_scope_change"
| "data_scope_enable";
```

`apps/web/src/lib/api.ts` 的 `AuditActionValue` 同步；`AuditPage` 标签补“部门变更/范围配置/范围开启”。

- [ ] **Step 8: 运行测试**

Run: `pnpm exec vitest run apps/server/test/query-scope.test.ts apps/server/test/db-schema-scope.test.ts apps/server/test/query-service.test.ts`

Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add apps/server/src/services/query-service.ts apps/server/src/agent/tools/db-schema.ts apps/server/src/db/repositories/runs.ts apps/server/src/services/audit.ts apps/server/test
git commit -m "feat(data-scope): enforce row scope in queries"
```

---

## Task 6: 结果快照、分享与 legacy 处理

**Files:**
- Create: `apps/server/src/services/scope-access.ts`
- Modify: `apps/server/src/routes/artifacts.ts`
- Modify: `apps/server/src/routes/shares.ts`
- Modify: `apps/server/src/routes/reports.ts`
- Modify: `apps/server/src/services/conversation-service.ts`
- Test: `apps/server/test/scope-access.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("hides legacy results from non-admin after a datasource becomes controlled", () => {
  // run.scopeSnapshot === null, datasource.dataScopeMode === "controlled"
  expect(() => assertRunScopeVisible(db, { runId, userId, isAdmin: false })).toThrow(/重新生成/);
});

it("rejects an artifact when the run snapshot is not a subset of current departments", () => {
  // snapshot.departments = ["sales"]，当前用户 departmentIds = ["east"]
  expect(() => assertRunScopeVisible(db, { runId, userId, isAdmin: false })).toThrow(/范围/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/server/test/scope-access.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现快照校验**

```ts
// apps/server/src/services/scope-access.ts
export function assertRunScopeVisible(
  db: Db,
  input: { runId: string; userId: string; isAdmin: boolean },
): void {
  if (input.isAdmin) return;
  const run = findRun(db, input.runId);
  if (!run) throw new ScopeAccessError("RUN_NOT_FOUND", "运行记录不存在");
  const datasource = run.conversationId
    ? findDatasourceByConversation(db, run.conversationId) // 在 datasources 仓储新增：按 conversationId 查数据源
    : null;
  if (!datasource || datasource.dataScopeMode !== "controlled") return;
  if (!run.scopeSnapshot) {
    throw new ScopeAccessError("LEGACY_RESULT", "该结果生成于数据权限开启前，请重新生成");
  }
  const snapshot = JSON.parse(run.scopeSnapshot) as ScopeSnapshot;
  const user = findUserById(db, input.userId);
  if (!user) throw new ScopeAccessError("FORBIDDEN", "用户不存在");
  const access = resolveUserAccess(db, user);
  const current = access.departmentIds;
  if (!current || !snapshot.departments.every((id) => current.has(id))) {
    throw new ScopeAccessError("SCOPE_REVOKED", "你的数据范围已变化，请重新生成结果");
  }
}
```

- [ ] **Step 4: artifact/report/share 路由接入**

`artifacts.ts` 的 preview/download 在 owner/admin 判定后调用 `assertRunScopeVisible`；`reports.ts` 的 GET detail、`shares.ts` 的创建/读取都调用。受控数据源创建分享时：

```ts
if (datasource.dataScopeMode === "controlled") {
  return reply.code(409).send({
    error: { code: "SHARE_DISABLED", message: "受控数据源的结果不支持公开分享" },
  });
}
```

`data_scope_enable` 时撤销该数据源全部 shares：

```ts
db.update(shares)
  .set({ revokedAt: Date.now() })
  .where(
    and(
      isNull(shares.revokedAt),
      inArray(
        shares.conversationId,
        db.select({ id: conversations.id }).from(conversations).where(eq(conversations.datasourceId, datasourceId)),
      ),
    ),
  )
  .run();
```

- [ ] **Step 5: 历史事件脱敏**

`getConversationDetail` 在组装 `tools/results/sqls` 时，对 `run.scopeSnapshot === null` 且数据源为 controlled 的 run：非管理员只保留 `sql` 文本与状态，删除 `results`/`artifacts` 数据；管理员保留并标 `legacy:true`。

- [ ] **Step 6: 运行测试**

Run: `pnpm exec vitest run apps/server/test/scope-access.test.ts apps/server/test/artifacts.test.ts apps/server/test/shares.test.ts apps/server/test/reports.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/services/scope-access.ts apps/server/src/routes apps/server/src/services/conversation-service.ts apps/server/test
git commit -m "feat(data-scope): guard results and shares with run snapshots"
```

---

## Task 7: 部门管理与用户部门 API

**Files:**
- Create: `apps/server/src/routes/admin-departments.ts`
- Modify: `apps/server/src/routes/admin-users.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/admin-departments.test.ts`
- Modify: `apps/server/test/admin-users-roles.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("creates a department tree and assigns members", async () => {
  const app = await buildTestApp();
  const root = await app.inject({
    method: "POST", url: "/api/admin/departments",
    headers: { cookie: adminCookie },
    payload: { name: "总部" },
  });
  expect(root.statusCode).toBe(201);
  const child = await app.inject({
    method: "POST", url: "/api/admin/departments",
    headers: { cookie: adminCookie },
    payload: { name: "销售", parentId: root.json().id },
  });
  expect(child.statusCode).toBe(201);
  const detail = await app.inject({
    method: "GET", url: `/api/admin/departments/${root.json().id}`,
    headers: { cookie: adminCookie },
  });
  expect(detail.json().department.children[0].name).toBe("销售");
});

it("rejects a department cycle", async () => {
  // PATCH parentId 为自身/子部门 → 409 DEPARTMENT_CYCLE
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/server/test/admin-departments.test.ts`

Expected: FAIL，404。

- [ ] **Step 3: 实现路由**

```ts
// apps/server/src/routes/admin-departments.ts
export function adminDepartmentsRoutes(app: FastifyInstance): void {
  app.get("/api/admin/departments", { preHandler: app.requirePermission("admin.departments") }, async () => ({
    departments: listDepartmentTree(app.db),
  }));

  app.post("/api/admin/departments", {
    preHandler: app.requirePermission("admin.departments"),
    schema: { body: { type: "object", required: ["name"], properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      parentId: { type: "string" },
      sortOrder: { type: "integer" },
    } } },
  }, async (request, reply) => {
    const { id } = createDepartment(app.db, request.body as { name: string; parentId?: string });
    recordAudit(app.db, {
      userId: request.user!.sub,
      action: "department_change",
      sqlText: "department.create",
      status: "ok",
      detail: { id, name: (request.body as { name: string }).name },
    });
    return reply.code(201).send({ id });
  });

  app.patch("/api/admin/departments/:id", {
    preHandler: app.requirePermission("admin.departments"),
  }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { name?: string; parentId?: string | null; sortOrder?: number };
    if (body.parentId) moveDepartment(app.db, id, body.parentId);
    if (body.name || body.sortOrder !== undefined) updateDepartment(app.db, id, body);
    return reply.send({ ok: true });
  });

  app.delete("/api/admin/departments/:id", {
    preHandler: app.requirePermission("admin.departments"),
  }, async (request, reply) => {
    deleteDepartment(app.db, (request.params as { id: string }).id);
    return reply.code(204).send();
  });
}
```

同时实现：

- `GET /api/admin/departments/:id`：节点、子树、成员、数据源授权。
- `GET /api/auth/me` 增加 `departmentNames: string[]`（用户有效部门名称），前端 `MeResponse` 同步；范围徽标用它展示。
- `PUT /api/admin/departments/:id/members`：`{userIds}`。
- `PUT /api/admin/departments/:id/grants`：`{datasourceIds}`。
- `POST /api/admin/departments/import`：`{csv}` 解析并校验。

`admin-users.ts` 的 create/update/list 增加 `departmentIds`，在事务内 `setUserDepartments`；用户列表返回 `departments:[{id,name}]`。

- [ ] **Step 4: 注册路由与错误映射**

`app.ts` 注册 `adminDepartmentsRoutes`。捕获 `DepartmentError`：

```ts
const status = error.code === "HAS_CHILDREN" || error.code === "HAS_MEMBERS" ? 409 : 400;
return reply.code(status).send({ error: { code: error.code, message: error.message } });
```

- [ ] **Step 5: 运行测试**

Run: `pnpm exec vitest run apps/server/test/admin-departments.test.ts apps/server/test/admin-users-roles.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/routes/admin-departments.ts apps/server/src/routes/admin-users.ts apps/server/src/app.ts apps/server/test
git commit -m "feat(data-scope): manage departments and user membership"
```

---

## Task 8: 数据范围配置、覆盖检查与诊断 API

**Files:**
- Create: `apps/server/src/routes/admin-data-scope.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/db/repositories/datasources.ts`
- Test: `apps/server/test/admin-data-scope.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("detects scope columns and refuses to enable with unclassified tables", async () => {
  const app = await buildTestApp();
  const detect = await app.inject({
    method: "GET", url: `/api/admin/datasources/${dsId}/scope/columns`,
    headers: { cookie: adminCookie },
  });
  expect(detect.json().candidates[0]).toMatchObject({ tableName: "orders", columnName: "dept_id" });

  const enable = await app.inject({
    method: "POST", url: `/api/admin/datasources/${dsId}/scope/enable`,
    headers: { cookie: adminCookie },
  });
  expect(enable.statusCode).toBe(409);
  expect(enable.json().error.code).toBe("SCOPE_COVERAGE_INCOMPLETE");
});

it("enables scope, revokes shares and records an audit row", async () => {
  // 先补全 policies/mappings，再 enable → 200，shares.revokedAt 非空。
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/server/test/admin-data-scope.test.ts`

Expected: FAIL，404。

- [ ] **Step 3: 实现配置 API**

```ts
// apps/server/src/routes/admin-data-scope.ts
app.get("/api/admin/datasources/:id/scope", { preHandler: app.requirePermission("admin.datasources") }, async (request) => {
  const datasourceId = (request.params as { id: string }).id;
  return {
    datasourceId,
    mode: findDatasource(app.db, datasourceId)?.dataScopeMode ?? "off",
    policies: listScopePolicies(app.db, datasourceId),
    mappings: listDepartmentMappings(app.db, datasourceId),
    coverage: coverageForDatasource(app.db, datasourceId, allDepartmentIds(app.db)),
  };
});

app.put("/api/admin/datasources/:id/scope/policies", {
  preHandler: app.requirePermission("admin.datasources"),
}, async (request, reply) => {
  const datasourceId = (request.params as { id: string }).id;
  const { policies } = request.body as { policies: ScopePolicyInput[] };
  replaceScopePolicies(app.db, datasourceId, policies);
  return reply.send({ ok: true });
});

app.post("/api/admin/datasources/:id/scope/enable", {
  preHandler: app.requirePermission("admin.datasources"),
}, async (request, reply) => {
  const datasourceId = (request.params as { id: string }).id;
  const coverage = assertScopeCoverage(app.db, datasourceId);
  if (!coverage.ok) {
    return reply.code(409).send({
      error: { code: "SCOPE_COVERAGE_INCOMPLETE", message: "仍有表未分类或部门未映射", coverage },
    });
  }
  enableDataScope(app.db, datasourceId);
  revokeDatasourceShares(app.db, datasourceId);
  recordAudit(app.db, {
    userId: request.user!.sub,
    action: "data_scope_enable",
    sqlText: "data_scope.enable",
    status: "ok",
    detail: { datasourceId },
  });
  return reply.send({ ok: true });
});
```

实现列表：

- `GET /api/admin/datasources/:id/scope/columns`：从 `datasource_schema_cache` 读取表/列，自动匹配 `dept_id/department_id/dept_code/org_id/org_code/organization_id`。
- `PUT /api/admin/datasources/:id/scope/policies`：校验列存在、值模式合法。
- `GET/PUT /api/admin/datasources/:id/scope/mappings`：映射列表与导入。
- `POST /api/admin/datasources/:id/scope/preview`：返回各表预计行数/未分类数（用 100 行采样）。
- `GET /api/admin/datasources/:id/scope/diagnostics?userId=`：部门子树、映射值、命中策略、最终条件。
- `GET /api/admin/datasources/:id/scope/denials?limit=20`：`query_audit.scope_reason` 非空记录。
- `POST /api/admin/datasources/:id/scope/disable`：关闭并审计。

- [ ] **Step 4: 注册路由与审计标签**

`apps/server/src/db/repositories/data-scope.ts` 还需导出：`replaceScopePolicies(db,datasourceId,policies)`（事务替换）、`enableDataScope(db,datasourceId)`、`assertScopeCoverage(db,datasourceId)`（未分类表/未映射部门）。`allDepartmentIds` 使用 Task 2 的 `listAllDepartmentIds`。

`app.ts` 注册；`AuditPage` 的 action 标签补 `department_change`/`data_scope_change`/`data_scope_enable`。

- [ ] **Step 5: 运行测试**

Run: `pnpm exec vitest run apps/server/test/admin-data-scope.test.ts apps/server/test/db.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/routes/admin-data-scope.ts apps/server/src/app.ts apps/server/src/db/repositories apps/server/test
git commit -m "feat(data-scope): expose scope configuration and diagnostics"
```

---

## Task 9: 部门管理页与用户部门分配

**Files:**
- Create: `apps/web/src/pages/admin/DepartmentsPage.tsx`
- Create: `apps/web/src/components/admin/DepartmentTree.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/query.ts`
- Modify: `apps/web/src/pages/admin/UsersPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/admin/AdminShell.tsx`
- Test: `apps/web/src/pages/admin/DepartmentsPage.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
it("creates a department and shows it in the tree", async () => {
  mockApi.listDepartments.mockResolvedValue({
    departments: [{ id: "d1", name: "总部", parentId: null, sortOrder: 0, children: [] }],
  });
  render(<DepartmentsPage />);
  expect(await screen.findByText("总部")).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/web/src/pages/admin/DepartmentsPage.test.tsx`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现页面**

`DepartmentsPage` 使用 `AdminShell`：

- 左侧部门树（`DepartmentTree`，支持展开/选中）。
- 右侧选中部门：名称/上级编辑、成员多选、数据源授权多选、保存/删除。
- 顶部：新建根部门、导入部门 CSV。
- 空态：`还没有部门，先创建“总部”`。

核心 API 类型：

```ts
export interface DepartmentNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  children: DepartmentNode[];
}
export function listDepartments(): Promise<{ departments: DepartmentNode[] }>;
export function createDepartment(input: { name: string; parentId?: string }): Promise<{ id: string }>;
export function updateDepartment(id: string, input: { name?: string; parentId?: string | null }): Promise<void>;
export function deleteDepartment(id: string): Promise<void>;
```

`UsersPage` 创建/编辑弹窗增加：

```tsx
<label className="text-xs text-muted">所属部门</label>
<div className="flex flex-wrap gap-1">
  {departments.map((department) => (
    <label key={department.id} className="rounded-md border border-line px-2 py-1 text-xs">
      <input
        type="checkbox"
        checked={departmentIds.includes(department.id)}
        onChange={() => toggleDepartment(department.id)}
      />
      {department.name}
    </label>
  ))}
</div>
```

- [ ] **Step 4: 路由与导航**

`App.tsx` 加 `/admin/departments`；`AdminShell` 管理分组加“部门”入口（`Network` 图标）。

- [ ] **Step 5: 运行测试**

Run: `pnpm exec vitest run apps/web/src/pages/admin/DepartmentsPage.test.tsx apps/web/src/pages/admin/UsersPage.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/admin/DepartmentsPage.tsx apps/web/src/components/admin/DepartmentTree.tsx apps/web/src/lib apps/web/src/pages/admin/UsersPage.tsx apps/web/src/App.tsx apps/web/src/components/admin/AdminShell.tsx
git commit -m "feat(web): manage departments and user membership"
```

---

## Task 10: 数据范围向导与用户侧提示

**Files:**
- Create: `apps/web/src/pages/admin/DatasourceScopePage.tsx`
- Create: `apps/web/src/components/admin/ScopePolicyTable.tsx`
- Create: `apps/web/src/components/admin/ScopeDiagnostics.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/pages/admin/DatasourcesPage.tsx`
- Modify: `apps/web/src/pages/ChatPage.tsx`
- Modify: `apps/web/src/components/chat/MessageItem.tsx`
- Test: `apps/web/src/pages/admin/DatasourceScopePage.test.tsx`
- Test: `apps/web/src/components/chat/MessageItem.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
it("blocks enable when coverage is incomplete", async () => {
  mockApi.getScope.mockResolvedValue({
    mode: "off",
    policies: [],
    coverage: { unclassifiedTables: 2, unmappedDepartments: 1 },
  });
  render(<DatasourceScopePage />);
  expect(await screen.findByText(/还有 2 张表未分类/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开启数据范围" })).toBeDisabled();
});

it("shows the table and admin hint on a scoped rejection", async () => {
  render(<MessageItem message={{ ...failedMessage, error: "表 orders 尚未配置数据范围，请联系管理员" }} />);
  expect(screen.getByText(/orders/)).toBeInTheDocument();
  expect(screen.getByText(/联系管理员/)).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run apps/web/src/pages/admin/DatasourceScopePage.test.tsx`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现范围页面**

`DatasourceScopePage` 路由 `/admin/datasources/:id/scope`，使用 `AdminShell`，五个分区：

1. 自动识别候选列（`检测到 orders.dept_id，建议部门字段`）。
2. 策略表：`表名 / 分类（public|scoped|denied）/ 部门字段 / 值模式 / 空值可见 / 启用`。
3. 部门映射：搜索 + 批量选择 + 导入 CSV + 未映射数量。
4. 覆盖检查：未分类表、未映射部门、无部门用户；任一非零禁用“开启数据范围”。
5. 诊断：选择用户后显示部门子树、映射值、命中策略、预计条件、预计行数；最近拒绝记录。

`DatasourcesPage` 行操作加“数据范围”链接。

- [ ] **Step 4: 用户侧错误与徽标**

`ChatPage` topbar 显示：

```tsx
{datasource?.dataScopeMode === "controlled" ? (
  <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] text-inksoft">
    数据范围：{me?.departmentNames?.join("、") || "未分配部门"}
  </span>
) : null}
```

`MessageItem` 错误区按 `message.error` 中的关键字显示：

```tsx
const scopeHint = /数据范围|部门|映射|未配置/.test(message.error ?? "");
{scopeHint ? (
  <p className="mt-1 text-[11px] text-muted">
    可联系管理员在「数据源 → 数据范围」中检查部门映射和表策略。
  </p>
) : null}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm exec vitest run apps/web/src/pages/admin/DatasourceScopePage.test.tsx apps/web/src/components/chat/MessageItem.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/admin/DatasourceScopePage.tsx apps/web/src/components/admin apps/web/src/lib/api.ts apps/web/src/pages/admin/DatasourcesPage.tsx apps/web/src/pages/ChatPage.tsx apps/web/src/components/chat/MessageItem.tsx
git commit -m "feat(web): configure and explain department data scopes"
```

---

## Task 11: 文档、回归与交付

**Files:**
- Modify: `README.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/superpowers/specs/2026-11-17-department-data-scope-design.md`（状态）
- Modify: `docs/superpowers/plans/2026-11-17-department-data-scope.md`

- [ ] **Step 1: 更新文档**

README 增“部门与行级数据权限”：

- 开启步骤：部门树 → 用户部门 → 数据源授权 → 表分类 → 部门映射 → 预览 → 开启。
- 规则：父部门可见下级、多部门并集、未分类默认拒绝、空部门值默认可见、受控数据源禁止公开分享。
- legacy：开启前的结果只保留 SQL 与对话，结果数据需重新生成。
- 限制：无列级权限、无表级 allowlist、无业务部门表运行时递归。
- 回滚：可以关闭数据范围，但不会恢复已撤销的分享。

Roadmap 把部门/行级权限从“候选”改为“已交付”，下一步改为 Playwright / 产品扩展 / 备份增强。

- [ ] **Step 2: 全量验证**

Run:

```bash
pnpm lint
pnpm verify
```

Expected: lint 0 error；服务端/共享与 web 全部通过，构建成功。

- [ ] **Step 3: 手工验收**

- 管理员创建“总部 → 销售 → 华东”，用户只挂“华东”。
- 数据源开启受控，`orders` 配 `dept_id`，用户查询只看到华东及空值行。
- 父部门“销售”用户看到销售+华东。
- 用户无部门时收到“未分配部门”提示。
- 未分类表查询被拒绝，提示表名和联系管理员。
- 开启前的结果在开启后非管理员不可见，提示重新生成。
- 受控数据源点“分享”被拒绝；历史分享已撤销。
- 定时任务下一次执行使用当前部门范围，撤权后自动停用并通知。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/roadmap.md docs/superpowers
git commit -m "docs: document department row-level data scope"
git push origin main
```

---

## 自查

- 规格覆盖：部门树/闭包/多部门、部门授权、表策略、映射、AST 改写、快照、legacy、分享撤销、定时任务、管理向导、诊断、错误提示、权限、测试、回滚均有对应任务。
- 类型一致：`ScopePlan`/`ScopeSnapshot`/`Access.departmentIds`/`dataScopeMode` 在 Task 1、2、4、5、6 使用同一命名。
- 迁移：0013 后共 14 个迁移；`db.test.ts` 与 `data-scope-schema.test.ts` 同步。
- 已知取舍：本计划不实现列级权限、表级 allowlist、业务部门表运行时递归、虚拟滚动；这些在 spec 中明确为非目标。
