import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqlAbortedError,
  SqlTimeoutError,
  executeReadOnly,
} from "../src/agent/sql/executor.js";
import { writeTablesToSqlite } from "../src/services/file-store.js";

let tempDir: string;
let sqlitePath: string;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-sqlite-exec-"));
  sqlitePath = path.join(tempDir, "data.sqlite");
  await writeTablesToSqlite(
    sqlitePath,
    [
      {
        tableName: "销售明细",
        columns: [
          { name: "订单号", originalName: "订单号", type: "TEXT", nullable: false, sampleValues: [] },
          { name: "部门", originalName: "部门", type: "TEXT", nullable: false, sampleValues: [] },
          { name: "金额", originalName: "金额", type: "REAL", nullable: false, sampleValues: [] },
        ],
        rows: Array.from({ length: 50 }, (_, index) => [
          `00${index + 1}`,
          index % 2 === 0 ? "华东" : "华北",
          (index + 1) * 10.5,
        ]),
      },
    ],
    { mode: "create" },
  );
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SQLite worker executor", () => {
  it("streams rows in a readonly worker with Chinese identifiers and append support", async () => {
    await writeTablesToSqlite(
      sqlitePath,
      [
        {
          tableName: "部门预算",
          columns: [
            { name: "部门", originalName: "部门", type: "TEXT", nullable: false, sampleValues: [] },
            { name: "预算", originalName: "预算", type: "INTEGER", nullable: false, sampleValues: [] },
          ],
          rows: [
            ["华东", 10_000],
            ["华北", 8_000],
          ],
        },
      ],
      { mode: "append" },
    );

    const streamed: unknown[][] = [];
    const result = await executeReadOnly(
      {
        dialect: "sqlite",
        sqlitePath,
        sql: `SELECT s."部门", ROUND(SUM(s."金额"), 2) AS 销售额, b."预算"
              FROM "销售明细" s
              JOIN "部门预算" b ON s."部门" = b."部门"
              GROUP BY s."部门", b."预算"
              ORDER BY 销售额 DESC`,
        maxRows: 100,
        previewRows: 10,
        timeoutMs: 5_000,
      },
      async (row) => {
        streamed.push(row);
      },
    );

    expect(result.columns.map((c) => c.name)).toEqual(["部门", "销售额", "预算"]);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(streamed).toHaveLength(2);
  });

  it("enforces maxRows truncation and previewRows window", async () => {
    const streamed: unknown[][] = [];
    const result = await executeReadOnly(
      {
        dialect: "sqlite",
        sqlitePath,
        sql: `SELECT "订单号", "金额" FROM "销售明细"`,
        maxRows: 12,
        previewRows: 5,
        timeoutMs: 5_000,
      },
      async (row) => {
        streamed.push(row);
      },
    );

    expect(result.rowCount).toBe(12);
    expect(result.truncated).toBe(true);
    expect(result.previewRows).toHaveLength(5);
    expect(streamed).toHaveLength(12);
  });

  it("refuses writes at the SQLite connection level even if guard is bypassed", async () => {
    await expect(
      executeReadOnly(
        {
          dialect: "sqlite",
          sqlitePath,
          sql: `DELETE FROM "销售明细"`,
          maxRows: 10,
          previewRows: 10,
          timeoutMs: 5_000,
        },
        async () => undefined,
      ),
    ).rejects.toThrow();
  });

  it("terminates slow queries on timeoutMs and releases the file handle", async () => {
    const slowSql = `WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt) SELECT COUNT(*) FROM cnt`;
    await expect(
      executeReadOnly(
        {
          dialect: "sqlite",
          sqlitePath,
          sql: slowSql,
          maxRows: 10,
          previewRows: 10,
          timeoutMs: 120,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SqlTimeoutError);

    // Ensure Windows file handle is already released when SqlTimeoutError settles.
    expect(() => fs.rmSync(tempDir, { recursive: true, force: true })).not.toThrow();
  });

  it("rejects with SqlAbortedError when AbortSignal fires", async () => {
    const controller = new AbortController();
    const slowSql = `WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt) SELECT COUNT(*) FROM cnt`;
    setTimeout(() => controller.abort(), 80);

    await expect(
      executeReadOnly(
        {
          dialect: "sqlite",
          sqlitePath,
          sql: slowSql,
          maxRows: 10,
          previewRows: 10,
          timeoutMs: 10_000,
          signal: controller.signal,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(SqlAbortedError);
  });
});
