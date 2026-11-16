import { describe, expect, it } from "vitest";
import type { ChatResult, ChatSql } from "./api";
import { normalizeSql, pairQueries } from "./pair-queries";

const sql: ChatSql = {
  sql: "SELECT id, name FROM users LIMIT 10",
  auditId: "audit-1",
  status: "ok",
};

const result: ChatResult = {
  artifactId: "artifact-1",
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
  ],
  rows: [[1, "Ada"]],
  rowCount: 1,
  truncated: false,
  sql: sql.sql,
};

describe("pairQueries", () => {
  it("pairs a result with the SQL that produced it", () => {
    const { pairs, unmatched } = pairQueries([sql], [result]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.sql.auditId).toBe("audit-1");
    expect(pairs[0]?.result?.artifactId).toBe("artifact-1");
    expect(unmatched).toHaveLength(0);
  });

  it("pairs despite reformatted whitespace in the guarded SQL", () => {
    const { pairs } = pairQueries([sql], [{ ...result, sql: "SELECT id, name\n  FROM users\n LIMIT 10" }]);

    expect(pairs[0]?.result).toBeDefined();
  });

  it("keeps rejected SQL without a result and orphan results separate", () => {
    const { pairs, unmatched } = pairQueries(
      [{ sql: "DROP TABLE users", auditId: "audit-2", status: "rejected" }],
      [result],
    );

    expect(pairs[0]?.result).toBeUndefined();
    expect(unmatched.map((item) => item.artifactId)).toEqual(["artifact-1"]);
  });

  it("normalizes whitespace for comparison", () => {
    expect(normalizeSql(" SELECT  1 \n")).toBe("SELECT 1");
  });
});
