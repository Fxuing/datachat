import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import {
  createDepartment,
  deleteDepartment,
  effectiveDepartmentIds,
  listDepartmentGrants,
  listDepartmentTree,
  listUserDepartmentRows,
  moveDepartment,
  replaceDepartmentGrants,
  setUserDepartments,
} from "../src/db/repositories/departments.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";

function setup(): Db {
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  return handle.db;
}

function datasource(db: Db, name: string): string {
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
    createdBy: "admin",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return id;
}

function user(db: Db, username: string): string {
  const id = randomUUID();
  insertUser(db, { id, username, passwordHash: "x", role: "user", createdAt: Date.now() });
  return id;
}

describe("departments", () => {
  it("builds closure and returns the subtree", () => {
    const db = setup();
    const root = createDepartment(db, { name: "总部", code: "HQ" });
    const sales = createDepartment(db, { name: "销售", code: "SALES", parentId: root.id });
    const east = createDepartment(db, { name: "华东", code: "EAST", parentId: sales.id });
    expect([...effectiveDepartmentIds(db, [sales.id])].sort()).toEqual(
      [sales.id, east.id].sort(),
    );
    expect(listDepartmentTree(db)[0]?.children[0]?.children[0]?.name).toBe("华东");
    expect(listDepartmentTree(db)[0]?.code).toBe("HQ");
    expect(effectiveDepartmentIds(db, [root.id]).size).toBe(3);
  });

  it("rejects moving a department under its descendant", () => {
    const db = setup();
    const root = createDepartment(db, { name: "总部" });
    const child = createDepartment(db, { name: "销售", parentId: root.id });
    expect(() => moveDepartment(db, root.id, child.id)).toThrow(/子部门/);
    expect(() => moveDepartment(db, root.id, root.id)).toThrow(/自己/);
  });

  it("moves a subtree and rebuilds closure depths", () => {
    const db = setup();
    const root = createDepartment(db, { name: "总部" });
    const sales = createDepartment(db, { name: "销售", parentId: root.id });
    const east = createDepartment(db, { name: "华东", parentId: sales.id });
    const ops = createDepartment(db, { name: "运营", parentId: root.id });
    moveDepartment(db, east.id, ops.id);
    expect([...effectiveDepartmentIds(db, [sales.id])]).toEqual([sales.id]);
    expect([...effectiveDepartmentIds(db, [ops.id])].sort()).toEqual([ops.id, east.id].sort());
    expect(effectiveDepartmentIds(db, [root.id]).size).toBe(4);
  });

  it("inherits department grants down the tree, not up", () => {
    const db = setup();
    const root = createDepartment(db, { name: "总部" });
    const child = createDepartment(db, { name: "销售", parentId: root.id });
    const east = createDepartment(db, { name: "华东", parentId: child.id });
    const ds = datasource(db, "finance");
    replaceDepartmentGrants(db, root.id, [ds]);
    expect(listDepartmentGrants(db, child.id)).toEqual([ds]);
    expect(listDepartmentGrants(db, east.id)).toEqual([ds]);

    const ops = createDepartment(db, { name: "运营", parentId: root.id });
    const other = datasource(db, "ops");
    replaceDepartmentGrants(db, ops.id, [other]);
    expect(listDepartmentGrants(db, root.id)).toEqual([ds]);
    expect(listDepartmentGrants(db, ops.id).sort()).toEqual([ds, other].sort());
  });

  it("refuses to delete a department with children or members", () => {
    const db = setup();
    const root = createDepartment(db, { name: "总部" });
    const child = createDepartment(db, { name: "销售", parentId: root.id });
    expect(() => deleteDepartment(db, root.id)).toThrow(/子部门/);

    const member = user(db, "member");
    setUserDepartments(db, member, [child.id]);
    expect(() => deleteDepartment(db, child.id)).toThrow(/成员/);

    setUserDepartments(db, member, []);
    expect(() => deleteDepartment(db, child.id)).not.toThrow();
    expect(() => deleteDepartment(db, root.id)).not.toThrow();
  });

  it("replaces memberships and keeps a single primary department", () => {
    const db = setup();
    const a = createDepartment(db, { name: "A" });
    const b = createDepartment(db, { name: "B" });
    const member = user(db, "multi");
    setUserDepartments(db, member, [a.id, b.id], b.id);
    const rows = listUserDepartmentRows(db, member);
    expect(rows.map((row) => row.name).sort()).toEqual(["A", "B"]);
    expect(rows.find((row) => row.isPrimary)?.id).toBe(b.id);

    setUserDepartments(db, member, [a.id]);
    expect(listUserDepartmentRows(db, member)).toEqual([
      expect.objectContaining({ id: a.id, isPrimary: true }),
    ]);
  });

  it("rejects unknown departments and a primary outside the membership", () => {
    const db = setup();
    const a = createDepartment(db, { name: "A" });
    const member = user(db, "bad");
    expect(() => setUserDepartments(db, member, [randomUUID()])).toThrow(/部门不存在/);
    expect(() => setUserDepartments(db, member, [a.id], randomUUID())).toThrow(/主部门/);
  });

  it("rejects duplicate department codes", () => {
    const db = setup();
    createDepartment(db, { name: "总部", code: "HQ" });
    expect(() => createDepartment(db, { name: "分部", code: "HQ" })).toThrow(/编码已存在/);
  });

  it("rejects grants for a datasource that does not exist", () => {
    const db = setup();
    const dept = createDepartment(db, { name: "总部" });
    expect(() => replaceDepartmentGrants(db, dept.id, [randomUUID()])).toThrow(/数据源不存在/);
  });
});
