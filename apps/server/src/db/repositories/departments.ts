import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.js";
import {
  departmentClosure,
  departmentDatasourceGrants,
  departments,
  datasources,
  userDepartments,
  users,
} from "../schema.js";

export class DepartmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DepartmentError";
  }
}

export type DepartmentRow = typeof departments.$inferSelect;

export interface DepartmentNode {
  id: string;
  name: string;
  code: string;
  parentId: string | null;
  sortOrder: number;
  status: DepartmentRow["status"];
  children: DepartmentNode[];
}

export interface CreateDepartmentInput {
  name: string;
  /** Defaults to a generated code; `app_code` filtering uses this value. */
  code?: string;
  parentId?: string | null;
  sortOrder?: number;
}

export interface UpdateDepartmentInput {
  name?: string;
  code?: string;
  sortOrder?: number;
  status?: DepartmentRow["status"];
}

function generatedCode(): string {
  return `D${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}

function requireDepartment(db: Db, id: string): DepartmentRow {
  const row = db.select().from(departments).where(eq(departments.id, id)).get();
  if (!row) throw new DepartmentError("NOT_FOUND", "部门不存在");
  return row;
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new DepartmentError("NAME_REQUIRED", "部门名称不能为空");
  if (trimmed.length > 100) throw new DepartmentError("NAME_TOO_LONG", "部门名称过长");
  return trimmed;
}

function assertCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) throw new DepartmentError("CODE_REQUIRED", "部门编码不能为空");
  if (trimmed.length > 100) throw new DepartmentError("CODE_TOO_LONG", "部门编码过长");
  return trimmed;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string" &&
    /UNIQUE constraint failed/i.test((error as { message: string }).message)
  );
}

export function createDepartment(db: Db, input: CreateDepartmentInput): DepartmentRow {
  const name = assertName(input.name);
  const code = assertCode(input.code ?? generatedCode());
  if (input.parentId) requireDepartment(db, input.parentId);
  const now = Date.now();
  const id = randomUUID();
  try {
    db.insert(departments)
      .values({
        id,
        name,
        code,
        parentId: input.parentId ?? null,
        sortOrder: input.sortOrder ?? 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DepartmentError("DUPLICATE_CODE", "部门编码已存在");
    }
    throw error;
  }
  rebuildClosure(db);
  return requireDepartment(db, id);
}

/** Recomputes the transitive closure from `parent_id`; depth 0 is the node itself. */
export function rebuildClosure(db: Db): void {
  const rows = db.select().from(departments).all();
  const byParent = new Map<string | null, DepartmentRow[]>();
  for (const row of rows) {
    const parent = row.parentId && rows.some((candidate) => candidate.id === row.parentId)
      ? row.parentId
      : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), row]);
  }
  const inserts: Array<{ ancestorId: string; descendantId: string; depth: number }> = [];
  const visited = new Set<string>();
  const walk = (ancestorId: string, node: DepartmentRow, depth: number) => {
    if (visited.has(`${ancestorId}:${node.id}`)) return;
    visited.add(`${ancestorId}:${node.id}`);
    inserts.push({ ancestorId, descendantId: node.id, depth });
    for (const child of byParent.get(node.id) ?? []) walk(ancestorId, child, depth + 1);
  };
  for (const node of rows) walk(node.id, node, 0);
  db.transaction((tx) => {
    tx.delete(departmentClosure).run();
    if (inserts.length > 0) tx.insert(departmentClosure).values(inserts).run();
  });
}

export function getDepartment(db: Db, id: string): DepartmentRow | undefined {
  return db.select().from(departments).where(eq(departments.id, id)).get();
}

export function updateDepartment(db: Db, id: string, input: UpdateDepartmentInput): DepartmentRow {
  requireDepartment(db, id);
  const changes: Partial<DepartmentRow> = { updatedAt: Date.now() };
  if (input.name !== undefined) changes.name = assertName(input.name);
  if (input.code !== undefined) changes.code = assertCode(input.code);
  if (input.sortOrder !== undefined) changes.sortOrder = input.sortOrder;
  if (input.status !== undefined) changes.status = input.status;
  try {
    db.update(departments).set(changes).where(eq(departments.id, id)).run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DepartmentError("DUPLICATE_CODE", "部门编码已存在");
    }
    throw error;
  }
  return requireDepartment(db, id);
}

export function moveDepartment(db: Db, id: string, newParentId: string | null): DepartmentRow {
  requireDepartment(db, id);
  if (newParentId === id) throw new DepartmentError("SELF_PARENT", "部门不能作为自己的上级");
  if (newParentId) {
    requireDepartment(db, newParentId);
    if (effectiveDepartmentIds(db, [id]).has(newParentId)) {
      throw new DepartmentError("CYCLE", "不能移动到自己的子部门下");
    }
  }
  db.update(departments)
    .set({ parentId: newParentId, updatedAt: Date.now() })
    .where(eq(departments.id, id))
    .run();
  rebuildClosure(db);
  return requireDepartment(db, id);
}

export function listAllDepartmentIds(db: Db): string[] {
  return db.select({ id: departments.id }).from(departments).all().map((row) => row.id);
}

export function listDepartments(db: Db): DepartmentRow[] {
  return db
    .select()
    .from(departments)
    .orderBy(asc(departments.sortOrder), asc(departments.name))
    .all();
}

export function deleteDepartment(db: Db, id: string): void {
  requireDepartment(db, id);
  const children = db
    .select({ id: departments.id })
    .from(departments)
    .where(eq(departments.parentId, id))
    .all();
  if (children.length > 0) throw new DepartmentError("HAS_CHILDREN", "该部门仍有子部门");
  const members = db
    .select({ userId: userDepartments.userId })
    .from(userDepartments)
    .where(eq(userDepartments.departmentId, id))
    .all();
  if (members.length > 0) throw new DepartmentError("HAS_MEMBERS", "该部门仍有成员");
  db.delete(departments).where(eq(departments.id, id)).run();
  rebuildClosure(db);
}

/** Subtree rooted at the given departments, including the roots themselves. */
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

export function departmentNameMap(db: Db, ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(inArray(departments.id, ids))
      .all()
      .map((row) => [row.id, row.name]),
  );
}

export function listDepartmentTree(db: Db): DepartmentNode[] {
  const rows = listDepartments(db);
  const map = new Map<string, DepartmentNode>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      name: row.name,
      code: row.code,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      status: row.status,
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

export function setUserDepartments(
  db: Db,
  userId: string,
  departmentIds: string[],
  primaryId?: string | null,
): void {
  const unique = [...new Set(departmentIds)];
  for (const departmentId of unique) requireDepartment(db, departmentId);
  if (primaryId && !unique.includes(primaryId)) {
    throw new DepartmentError("PRIMARY_NOT_MEMBER", "主部门必须是成员部门之一");
  }
  const primary = primaryId ?? unique[0] ?? null;
  const now = Date.now();
  db.transaction((tx) => {
    tx.delete(userDepartments).where(eq(userDepartments.userId, userId)).run();
    if (unique.length > 0) {
      tx.insert(userDepartments)
        .values(
          unique.map((departmentId) => ({
            userId,
            departmentId,
            isPrimary: departmentId === primary ? 1 : 0,
            createdAt: now,
          })),
        )
        .run();
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

export function listUserDepartmentRows(
  db: Db,
  userId: string,
): Array<{ id: string; name: string; code: string; isPrimary: boolean }> {
  return db
    .select({
      id: departments.id,
      name: departments.name,
      code: departments.code,
      isPrimary: userDepartments.isPrimary,
    })
    .from(userDepartments)
    .innerJoin(departments, eq(departments.id, userDepartments.departmentId))
    .where(eq(userDepartments.userId, userId))
    .all()
    .map((row) => ({ ...row, isPrimary: row.isPrimary === 1 }));
}

/** Grants attached to the department or any of its ancestors (inheritance flows down). */
export function listDepartmentGrants(db: Db, departmentId: string): string[] {
  return listGrantsForDepartments(db, [departmentId]);
}

export function replaceDepartmentGrants(
  db: Db,
  departmentId: string,
  datasourceIds: string[],
): void {
  requireDepartment(db, departmentId);
  if (datasourceIds.length > 0) {
    const existing = db
      .select({ id: datasources.id })
      .from(datasources)
      .where(inArray(datasources.id, [...new Set(datasourceIds)]))
      .all();
    if (existing.length !== new Set(datasourceIds).size) {
      throw new DepartmentError("DATASOURCE_NOT_FOUND", "数据源不存在");
    }
  }
  const now = Date.now();
  db.transaction((tx) => {
    tx.delete(departmentDatasourceGrants)
      .where(eq(departmentDatasourceGrants.departmentId, departmentId))
      .run();
    if (datasourceIds.length > 0) {
      tx.insert(departmentDatasourceGrants)
        .values(
          [...new Set(datasourceIds)].map((datasourceId) => ({
            departmentId,
            datasourceId,
            createdAt: now,
          })),
        )
        .run();
    }
  });
}

/** All datasource ids granted to any ancestor of the supplied departments. */
export function listGrantsForDepartments(db: Db, departmentIds: string[]): string[] {
  const unique = [...new Set(departmentIds)];
  if (unique.length === 0) return [];
  const ancestors = db
    .select({ id: departmentClosure.ancestorId })
    .from(departmentClosure)
    .where(inArray(departmentClosure.descendantId, unique))
    .all()
    .map((row) => row.id);
  if (ancestors.length === 0) return [];
  return [
    ...new Set(
      db
        .select({ id: departmentDatasourceGrants.datasourceId })
        .from(departmentDatasourceGrants)
        .where(inArray(departmentDatasourceGrants.departmentId, ancestors))
        .all()
        .map((row) => row.id),
    ),
  ];
}

export function countDepartmentMembers(db: Db, departmentId: string): number {
  return db
    .select({ userId: userDepartments.userId })
    .from(userDepartments)
    .where(eq(userDepartments.departmentId, departmentId))
    .all().length;
}


export interface DepartmentMemberRow {
  id: string;
  username: string;
  displayName: string | null;
  isPrimary: boolean;
}

/** Members of one department; primary membership is surfaced for the admin UI. */
export function listDepartmentMembers(db: Db, departmentId: string): DepartmentMemberRow[] {
  return db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isPrimary: userDepartments.isPrimary,
    })
    .from(userDepartments)
    .innerJoin(users, eq(users.id, userDepartments.userId))
    .where(eq(userDepartments.departmentId, departmentId))
    .orderBy(users.username)
    .all()
    .map((row) => ({ ...row, isPrimary: row.isPrimary === 1 }));
}

/** departmentId → member count, for the tree sidebar. */
export function departmentMemberCounts(db: Db): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db
    .select({
      departmentId: userDepartments.departmentId,
      userId: userDepartments.userId,
    })
    .from(userDepartments)
    .all()) {
    counts.set(row.departmentId, (counts.get(row.departmentId) ?? 0) + 1);
  }
  return counts;
}

/** departmentId → datasource ids granted directly on that department. */
export function listAllDepartmentGrants(db: Db): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of db.select().from(departmentDatasourceGrants).all()) {
    const list = result.get(row.departmentId) ?? [];
    list.push(row.datasourceId);
    result.set(row.departmentId, list);
  }
  return result;
}
