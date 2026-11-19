import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDb, type Db, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { insertUser } from "../src/db/repositories/users.js";
import { createDepartment } from "../src/db/repositories/departments.js";
import {
  coverageForDatasource,
  deleteDepartmentMapping,
  deleteScopePolicy,
  findScopePolicy,
  importDepartmentMappings,
  listDepartmentMappings,
  listScopePolicies,
  policyCoverageForDatasource,
  replaceScopePolicies,
  upsertScopePolicy,
} from "../src/db/repositories/data-scope.js";
import { importMappingsFromCsv, parseMappingCsv } from "../src/services/scope-import.js";
import { encryptSecret, deriveSecretKey } from "../src/agent/datasource/crypto.js";

function migrate(): DbHandle {
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  return handle;
}

function createDatasource(db: Db, name = "demo"): string {
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

describe("scope policies", () => {
  it("creates and updates a policy per table", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);

    upsertScopePolicy(db, {
      datasourceId,
      tableName: "orders",
      mode: "scoped",
      rules: [
        { columnName: "dept_id", operator: "in", valueMode: "external_id" },
        { columnName: "is_deleted", operator: "eq", valueMode: "literal", literalValues: ["0"] },
      ],
    });
    expect(findScopePolicy(db, datasourceId, "orders")?.rules.map((rule) => rule.columnName)).toEqual([
      "dept_id",
      "is_deleted",
    ]);

    upsertScopePolicy(db, {
      datasourceId,
      tableName: "orders",
      mode: "public",
    });

    const policies = listScopePolicies(db, datasourceId);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      tableName: "orders",
      mode: "public",
      enabled: true,
      rules: [],
    });
    expect(findScopePolicy(db, datasourceId, "orders")?.mode).toBe("public");
  });

  it("validates rules instead of accepting a single legacy column", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);

    expect(() =>
      upsertScopePolicy(db, { datasourceId, tableName: "orders", mode: "scoped" }),
    ).toThrow(/至少需要一条规则/);
    expect(() =>
      upsertScopePolicy(db, {
        datasourceId,
        tableName: "orders",
        mode: "scoped",
        rules: [{ columnName: "dept_id", valueMode: "nope" as never }],
      }),
    ).toThrow(/value mode/);
    expect(() =>
      upsertScopePolicy(db, {
        datasourceId,
        tableName: "orders",
        mode: "scoped",
        rules: [{ columnName: "dept_id", valueMode: "literal", literalValues: [] }],
      }),
    ).toThrow(/必须填写值/);
    expect(() =>
      upsertScopePolicy(db, {
        datasourceId,
        tableName: "orders",
        mode: "scoped",
        rules: [
          { columnName: "amount", operator: "gt", valueMode: "literal", literalValues: ["1", "2"] },
        ],
      }),
    ).toThrow(/只支持一个固定值/);
    expect(() =>
      upsertScopePolicy(db, {
        datasourceId,
        tableName: " ",
        mode: "public",
      }),
    ).toThrow(/表名/);
    expect(() => upsertScopePolicy(db, { datasourceId, tableName: "x", mode: "bogus" as never })).toThrow(
      /invalid policy mode/,
    );
    expect(() =>
      upsertScopePolicy(db, {
        datasourceId,
        tableName: "orders",
        mode: "scoped",
        rules: [{ columnName: "dept_id", operator: "eq", valueMode: "department_id" }],
      }),
    ).toThrow(/IN/);
    expect(() =>
      upsertScopePolicy(db, {
        datasourceId,
        tableName: "orders",
        mode: "scoped",
        rules: [{ columnName: "status", operator: "eq", valueMode: "literal", literalValues: ["a", "b"] }],
      }),
    ).toThrow(/只能填写一个固定值/);
    expect(() =>
      replaceScopePolicies(db, datasourceId, [
        { tableName: "orders", mode: "public" },
        { tableName: "Orders", mode: "denied" },
      ]),
    ).toThrow(/重复配置/);
  });

  it("requires an existing datasource and replaces the whole set", () => {
    const { db } = migrate();
    expect(() =>
      upsertScopePolicy(db, { datasourceId: "missing", tableName: "orders", mode: "public" }),
    ).toThrow(/数据源不存在/);

    const datasourceId = createDatasource(db);
    replaceScopePolicies(db, datasourceId, [
      {
        tableName: "orders",
        mode: "scoped",
        rules: [
          { columnName: "dept_id", operator: "in", valueMode: "department_id" },
          { columnName: "is_deleted", valueMode: "literal", literalValues: ["0"] },
        ],
      },
      { tableName: "customers", mode: "denied" },
    ]);
    expect(listScopePolicies(db, datasourceId).map((policy) => policy.tableName)).toEqual([
      "customers",
      "orders",
    ]);
    const scoped = listScopePolicies(db, datasourceId).find((policy) => policy.tableName === "orders");
    expect(scoped?.rules[0]).toMatchObject({
      columnName: "dept_id",
      operator: "in",
      valueMode: "department_id",
    });
    expect(scoped?.rules[1]?.literalValues).toEqual(["0"]);

    replaceScopePolicies(db, datasourceId, [{ tableName: "customers", mode: "public" }]);
    expect(listScopePolicies(db, datasourceId).map((policy) => policy.mode)).toEqual(["public"]);

    deleteScopePolicy(db, datasourceId, "customers");
    expect(listScopePolicies(db, datasourceId)).toEqual([]);
  });

  it("reports classification coverage only for enabled policies", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    upsertScopePolicy(db, { datasourceId, tableName: "orders", mode: "public" });
    upsertScopePolicy(db, { datasourceId, tableName: "customers", mode: "public", enabled: false });

    expect(
      policyCoverageForDatasource(db, datasourceId, ["orders", "customers", "invoices"]),
    ).toEqual({ total: 3, classified: 1, unclassified: ["customers", "invoices"] });
  });
});

describe("department mappings", () => {
  it("imports, updates, and reports invalid rows", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    const sales = createDepartment(db, { name: "销售", code: "sales" });
    const east = createDepartment(db, { name: "华东", code: "east", parentId: sales.id });

    const first = importDepartmentMappings(db, datasourceId, [
      { departmentId: sales.id, externalId: "1" },
      { departmentCode: "east", externalOrgCode: "ORG-EAST" },
      { departmentId: "missing", externalId: "9" },
      { departmentId: sales.id, externalId: "2" },
      { departmentId: sales.id },
    ]);
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.errors).toHaveLength(3);

    const second = importDepartmentMappings(db, datasourceId, [
      { departmentId: sales.id, externalId: "10", externalCode: "S" },
    ]);
    expect(second).toMatchObject({ inserted: 0, updated: 1, errors: [] });

    const mappings = listDepartmentMappings(db, datasourceId);
    expect(mappings).toHaveLength(2);
    expect(mappings.find((row) => row.departmentId === sales.id)).toMatchObject({
      departmentName: "销售",
      departmentCode: "sales",
      externalId: "10",
      externalCode: "S",
      source: "import",
    });
    expect(mappings.find((row) => row.departmentId === east.id)?.externalOrgCode).toBe("ORG-EAST");

    deleteDepartmentMapping(db, datasourceId, east.id);
    expect(listDepartmentMappings(db, datasourceId)).toHaveLength(1);
  });

  it("computes mapping coverage", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    const a = createDepartment(db, { name: "A", code: "a" });
    const b = createDepartment(db, { name: "B", code: "b" });
    importDepartmentMappings(db, datasourceId, [{ departmentId: a.id, externalId: "1" }]);

    expect(coverageForDatasource(db, datasourceId, [a.id, b.id])).toEqual({
      mapped: 1,
      unmapped: 1,
      unmappedIds: [b.id],
    });
    expect(
      coverageForDatasource(db, datasourceId, [a.id], new Set(["externalOrgCode"])),
    ).toEqual({
      mapped: 0,
      unmapped: 1,
      unmappedIds: [a.id],
    });
  });
});

describe("mapping CSV", () => {
  it("parses headers, quotes, BOM, and CRLF", () => {
    const csv =
      "\uFEFFdepartment_code,external_id,external_code\r\n" +
      'east,1,"A,B"\r\n' +
      'sales,2,"say ""hi"""\r\n' +
      ",,3\r\n";
    const parsed = parseMappingCsv(csv);
    expect(parsed.errors).toEqual(["第 4 行: 缺少部门"]);
    expect(parsed.rows).toEqual([
      { departmentCode: "east", externalId: "1", externalCode: "A,B" },
      { departmentCode: "sales", externalId: "2", externalCode: 'say "hi"' },
    ]);
  });

  it("rejects files without a department column and empty files", () => {
    expect(parseMappingCsv("").errors).toEqual(["文件为空"]);
    expect(parseMappingCsv("external_id\n1\n").errors).toEqual([
      "缺少 department_id 或 department_code 列",
    ]);
  });

  it("imports parsed rows and merges parse errors", () => {
    const { db } = migrate();
    const datasourceId = createDatasource(db);
    createDepartment(db, { name: "华东", code: "east" });

    const result = importMappingsFromCsv(
      db,
      datasourceId,
      "department_code,external_org_code\neast,ORG-EAST\nwest,ORG-WEST\n",
    );
    expect(result).toMatchObject({ inserted: 1, updated: 0 });
    expect(result.errors).toEqual(["west: 部门不存在"]);
    expect(listDepartmentMappings(db, datasourceId)).toHaveLength(1);
  });
});
