import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDb, type Db, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { insertUser } from "../src/db/repositories/users.js";
import {
  createDepartment,
  setUserDepartments,
} from "../src/db/repositories/departments.js";
import {
  importDepartmentMappings,
  upsertScopePolicy,
} from "../src/db/repositories/data-scope.js";
import { saveSchema } from "../src/db/repositories/schema-cache.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";
import {
  ScopeResolveError,
  isSnapshotVisible,
  parseScopeSnapshot,
  resolveScope,
  type DataScopeMode,
} from "../src/services/data-scope.js";

function migrate(): DbHandle {
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  return handle;
}

function createDatasource(db: Db): string {
  const owner = randomUUID();
  insertUser(db, {
    id: owner,
    username: `owner-${owner.slice(0, 6)}`,
    passwordHash: "x",
    role: "admin",
    createdAt: Date.now(),
  });
  const id = randomUUID();
  insertDatasource(db, {
    id,
    name: `ds-${id.slice(0, 6)}`,
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

function createUser(db: Db): string {
  const id = randomUUID();
  insertUser(db, {
    id,
    username: `user-${id.slice(0, 6)}`,
    passwordHash: "x",
    role: "user",
    createdAt: Date.now(),
  });
  return id;
}

function seedSchema(db: Db, datasourceId: string): void {
  saveSchema(db, datasourceId, {
    refreshedAt: Date.now(),
    tables: [
      {
        schema: "demo",
        name: "orders",
        comment: null,
        rowEstimate: 1,
        columns: [
          { name: "id", type: "int", nullable: false, defaultValue: null, comment: null },
          { name: "dept_id", type: "int", nullable: true, defaultValue: null, comment: null },
        ],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
      {
        schema: "demo",
        name: "invoices",
        comment: null,
        rowEstimate: 1,
        columns: [
          { name: "id", type: "int", nullable: false, defaultValue: null, comment: null },
          { name: "org_code", type: "varchar", nullable: true, defaultValue: null, comment: null },
        ],
        primaryKey: ["id"],
        indexes: [],
        foreignKeys: [],
      },
    ],
  });
}

function resolve(
  db: Db,
  input: { datasourceId: string; userId: string; mode: DataScopeMode; tables: string[]; isAdmin?: boolean },
) {
  return resolveScope({
    db,
    datasourceId: input.datasourceId,
    userId: input.userId,
    mode: input.mode,
    isAdmin: input.isAdmin ?? false,
    tableNames: input.tables,
  });
}

describe("resolveScope", () => {
  it("does not filter while the datasource is off or configuring", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    const userId = createUser(db);

    for (const mode of ["off", "configuring"] as const) {
      const result = resolve(db, { datasourceId, userId, mode, tables: ["orders"] });
      expect(result.plan).toBeNull();
      expect(result.snapshot).toMatchObject({ v: 1, datasourceId, departments: [] });
    }
  });

  it("lets admins through without filtering", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    const admin = createUser(db);

    const result = resolve(db, {
      datasourceId,
      userId: admin,
      isAdmin: true,
      mode: "enabled",
      tables: ["orders"],
    });
    expect(result.plan).toBeNull();
    expect(result.snapshot.departments).toEqual([]);
  });

  it("fails closed without a department, policy, or allowed table", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    const userId = createUser(db);
    const sales = createDepartment(db, { name: "销售", code: "sales" });
    setUserDepartments(db, userId, [sales.id]);

    expect(() => resolve(db, { datasourceId, userId, mode: "enabled", tables: ["orders"] })).toThrow(
      /未配置数据范围/,
    );

    upsertScopePolicy(db, { datasourceId, tableName: "orders", mode: "denied" });
    expect(() => resolve(db, { datasourceId, userId, mode: "enabled", tables: ["orders"] })).toThrow(
      ScopeResolveError,
    );
    expect(() =>
      resolve(db, { datasourceId, userId, mode: "enabled", tables: ["orders"] }),
    ).toThrow(/不允许访问/);

    const noDept = createUser(db);
    expect(() =>
      resolve(db, { datasourceId, userId: noDept, mode: "enabled", tables: ["orders"] }),
    ).toThrow(/还没有加入任何部门/);
  });

  it("scopes parent departments to their whole subtree and binds department ids", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    const userId = createUser(db);
    const sales = createDepartment(db, { name: "销售", code: "sales" });
    const east = createDepartment(db, { name: "华东", code: "east", parentId: sales.id });
    const south = createDepartment(db, { name: "华南", code: "south", parentId: sales.id });
    setUserDepartments(db, userId, [sales.id]);
    upsertScopePolicy(db, {
      datasourceId,
      tableName: "orders",
      mode: "scoped",
      rules: [{ columnName: "dept_id", operator: "in", valueMode: "department_id" }],
    });

    const result = resolve(db, { datasourceId, userId, mode: "enabled", tables: ["orders"] });
    expect(result.snapshot.departments).toEqual([sales.id, east.id, south.id].sort());
    expect(result.snapshot.departmentNames).toEqual(["销售"]);
    expect(result.plan?.tables.get("orders")).toEqual({
      kind: "scoped",
      conditions: [
        {
          column: "dept_id",
          operator: "in",
          values: [sales.id, east.id, south.id].sort(),
          nullVisible: false,
        },
      ],
    });
    expect(result.plan?.tables.has("invoices")).toBe(false);
  });

  it("uses department_code values and stable policy hashes", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    const userId = createUser(db);
    const sales = createDepartment(db, { name: "销售", code: "sales" });
    setUserDepartments(db, userId, [sales.id]);
    upsertScopePolicy(db, {
      datasourceId,
      tableName: "orders",
      mode: "scoped",
      rules: [{ columnName: "dept_id", operator: "in", valueMode: "department_code" }],
    });
    seedSchema(db, datasourceId);

    const first = resolve(db, { datasourceId, userId, mode: "enabled", tables: ["orders"] });
    const second = resolve(db, { datasourceId, userId, mode: "enabled", tables: ["orders"] });
    expect(first.plan?.tables.get("orders")).toMatchObject({
      conditions: [{ column: "dept_id", values: ["sales"] }],
    });
    expect(first.snapshot.policyHash).toBe(second.snapshot.policyHash);

    upsertScopePolicy(db, { datasourceId, tableName: "invoices", mode: "public" });
    const third = resolve(db, { datasourceId, userId, mode: "enabled", tables: ["orders"] });
    expect(third.snapshot.policyHash).not.toBe(first.snapshot.policyHash);
  });

  it("requires external mappings for every effective department", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    const userId = createUser(db);
    const sales = createDepartment(db, { name: "销售", code: "sales" });
    const east = createDepartment(db, { name: "华东", code: "east", parentId: sales.id });
    setUserDepartments(db, userId, [sales.id]);
    upsertScopePolicy(db, {
      datasourceId,
      tableName: "invoices",
      mode: "scoped",
      rules: [{ columnName: "org_code", operator: "in", valueMode: "external_org_code" }],
    });
    seedSchema(db, datasourceId);
    importDepartmentMappings(db, datasourceId, [{ departmentId: sales.id, externalOrgCode: "ORG-S" }]);

    expect(() => resolve(db, { datasourceId, userId, mode: "enabled", tables: ["invoices"] })).toThrow(
      /部门 华东 未配置外部编码/,
    );

    importDepartmentMappings(db, datasourceId, [{ departmentId: east.id, externalOrgCode: "ORG-E" }]);
    const result = resolve(db, { datasourceId, userId, mode: "enabled", tables: ["invoices"] });
    expect(result.plan?.tables.get("invoices")).toMatchObject({
      conditions: [{ values: ["ORG-E", "ORG-S"].sort() }],
    });
  });

  it("rejects stale columns when a schema cache exists", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    const userId = createUser(db);
    const sales = createDepartment(db, { name: "销售", code: "sales" });
    setUserDepartments(db, userId, [sales.id]);
    upsertScopePolicy(db, {
      datasourceId,
      tableName: "orders",
      mode: "scoped",
      rules: [{ columnName: "removed_column", operator: "in", valueMode: "department_id" }],
    });
    seedSchema(db, datasourceId);

    expect(() => resolve(db, { datasourceId, userId, mode: "enabled", tables: ["orders"] })).toThrow(
      /已不存在/,
    );
    upsertScopePolicy(db, {
      datasourceId,
      tableName: "ghost",
      mode: "public",
    });
    expect(() => resolve(db, { datasourceId, userId, mode: "enabled", tables: ["ghost"] })).toThrow(
      /表 ghost 已不存在/,
    );
  });
});

describe("scope snapshots", () => {
  it("round-trips and hides runs outside the viewer's subtree", () => {
    const snapshot = { v: 1 as const, datasourceId: "ds", departments: ["a", "b"], policyHash: "h" };
    const parsed = parseScopeSnapshot(JSON.stringify(snapshot));
    expect(parsed).toEqual(snapshot);
    expect(parseScopeSnapshot("{}")).toBeNull();
    expect(parseScopeSnapshot("not json")).toBeNull();

    expect(isSnapshotVisible(parsed, new Set(["a", "b", "c"]))).toBe(true);
    expect(isSnapshotVisible(parsed, new Set(["a"]))).toBe(false);
    expect(isSnapshotVisible(parsed, null)).toBe(true);
    expect(isSnapshotVisible(null, new Set(["a"]))).toBe(false);
    expect(
      isSnapshotVisible({ ...snapshot, departments: [] }, new Set(["a"])),
    ).toBe(false);
    expect(isSnapshotVisible({ ...snapshot, departments: [] }, null)).toBe(true);
  });
});
