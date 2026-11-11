import { describe, expect, it } from "vitest";
import { parseEvalCases } from "../src/eval/cases.js";
import { runEvalCases } from "../src/eval/runner.js";

const cases = parseEvalCases([
  {
    id: "one",
    question: "数一下",
    mysql: "SELECT COUNT(*) AS n FROM t",
    postgres: "SELECT COUNT(*) AS n FROM t",
  },
  {
    id: "ordered",
    question: "排序",
    mysql: "SELECT id FROM t ORDER BY id",
    postgres: "SELECT id FROM t ORDER BY id",
    ordered: true,
  },
]);

const rows = new Map([
  ["SELECT COUNT(*) AS n FROM t", { columns: ["n"], rows: [[2]] }],
  ["SELECT id FROM t ORDER BY id", { columns: ["id"], rows: [[1], [2]] }],
]);

describe("runEvalCases", () => {
  it("passes when generated SQL returns the expected rows", async () => {
    const summary = await runEvalCases({
      dialect: "mysql",
      cases,
      runAgent: async (item) => ({
        sql: item.mysql,
        durationMs: 12,
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
      executeSql: async (sql) => rows.get(sql)!,
    });
    expect(summary).toMatchObject({ total: 2, passed: 2, failed: 0, passRate: 1 });
    expect(summary.cases[0]).toMatchObject({
      id: "one",
      passed: true,
      durationMs: 12,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it("reports a mismatch with the compare detail", async () => {
    const summary = await runEvalCases({
      dialect: "mysql",
      cases: [cases[0]!],
      runAgent: async () => ({ sql: "SELECT 3 AS n", durationMs: 1 }),
      executeSql: async (sql) =>
        sql === "SELECT 3 AS n"
          ? { columns: ["n"], rows: [[3]] }
          : rows.get(sql)!,
    });
    expect(summary.cases[0]).toMatchObject({
      passed: false,
      reason: "mismatch",
      generatedSql: "SELECT 3 AS n",
    });
    expect(summary.cases[0]!.comparison).toMatchObject({ equal: false });
  });

  it("fails when the agent returns no SQL", async () => {
    const summary = await runEvalCases({
      dialect: "postgres",
      cases: [cases[0]!],
      runAgent: async () => ({ durationMs: 5 }),
      executeSql: async () => ({ columns: [], rows: [] }),
    });
    expect(summary.cases[0]).toMatchObject({ passed: false, reason: "no_sql" });
  });

  it("fails when generated SQL cannot execute", async () => {
    const summary = await runEvalCases({
      dialect: "mysql",
      cases: [cases[0]!],
      runAgent: async () => ({ sql: "SELECT boom", durationMs: 2 }),
      executeSql: async () => {
        throw new Error("Unknown column 'boom'");
      },
    });
    expect(summary.cases[0]).toMatchObject({
      passed: false,
      reason: "execution_error",
      error: "Unknown column 'boom'",
    });
  });

  it("reports agent errors and progress in order", async () => {
    const seen: string[] = [];
    const summary = await runEvalCases({
      dialect: "mysql",
      cases,
      runAgent: async (item) => {
        if (item.id === "one") throw new Error("model down");
        return { sql: item.mysql, durationMs: 1 };
      },
      executeSql: async (sql) => rows.get(sql)!,
      onProgress: (result) => seen.push(result.id),
    });
    expect(summary.passed).toBe(1);
    expect(summary.cases[0]).toMatchObject({ passed: false, reason: "agent_error", error: "model down" });
    expect(seen).toEqual(["one", "ordered"]);
  });

  it("stops before running more cases when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const summary = await runEvalCases({
      dialect: "mysql",
      cases,
      runAgent: async () => {
        throw new Error("must not run");
      },
      executeSql: async () => ({ columns: [], rows: [] }),
      signal: controller.signal,
    });
    expect(summary.cases.map((item) => item.reason)).toEqual(["cancelled", "cancelled"]);
  });
});
