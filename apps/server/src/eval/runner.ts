import type { EvalCase } from "./cases.js";
import { compareResultSets, type CompareResult, type QueryResultSet } from "./compare.js";
import type { Dialect } from "./fixture.js";

export interface EvalUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface EvalAgentOutput {
  sql?: string;
  error?: string;
  durationMs: number;
  usage?: EvalUsage;
}

export type EvalAgent = (item: EvalCase) => Promise<EvalAgentOutput>;
export type EvalSqlExecutor = (sql: string, dialect: Dialect) => Promise<QueryResultSet>;

export type EvalFailureReason =
  | "agent_error"
  | "no_sql"
  | "execution_error"
  | "mismatch"
  | "cancelled";

export interface EvalCaseResult {
  id: string;
  question: string;
  passed: boolean;
  reason?: EvalFailureReason;
  error?: string;
  generatedSql?: string;
  expectedSql: string;
  durationMs: number;
  usage?: EvalUsage;
  comparison?: CompareResult;
}

export interface EvalSummary {
  dialect: Dialect;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  cases: EvalCaseResult[];
}

export interface RunEvalOptions {
  dialect: Dialect;
  cases: EvalCase[];
  runAgent: EvalAgent;
  executeSql: EvalSqlExecutor;
  onProgress?: (result: EvalCaseResult, index: number, total: number) => void;
  signal?: AbortSignal;
}

function expectedSqlFor(item: EvalCase, dialect: Dialect): string {
  return dialect === "mysql" ? item.mysql : item.postgres;
}

/**
 * Execute every golden case through the agent, then grade the generated SQL by
 * running it against the same fixture and comparing result sets. The agent is
 * never graded on SQL text, column aliases, or its natural-language answer.
 */
export async function runEvalCases(options: RunEvalOptions): Promise<EvalSummary> {
  const results: EvalCaseResult[] = [];
  const total = options.cases.length;

  for (const [index, item] of options.cases.entries()) {
    if (options.signal?.aborted) {
      results.push({
        id: item.id,
        question: item.question,
        passed: false,
        reason: "cancelled",
        expectedSql: expectedSqlFor(item, options.dialect),
        durationMs: 0,
      });
      options.onProgress?.(results[results.length - 1]!, index, total);
      continue;
    }

    const expectedSql = expectedSqlFor(item, options.dialect);
    let agentOutput: EvalAgentOutput;
    try {
      agentOutput = await options.runAgent(item);
    } catch (error) {
      agentOutput = {
        error: error instanceof Error ? error.message : String(error),
        durationMs: 0,
      };
    }

    const base = {
      id: item.id,
      question: item.question,
      expectedSql,
      durationMs: agentOutput.durationMs,
      ...(agentOutput.usage ? { usage: agentOutput.usage } : {}),
    } satisfies Omit<EvalCaseResult, "passed">;

    if (agentOutput.error) {
      const result = { ...base, passed: false, reason: "agent_error", error: agentOutput.error } as const;
      results.push(result);
      options.onProgress?.(result, index, total);
      continue;
    }

    const generatedSql = agentOutput.sql?.trim();
    if (!generatedSql) {
      const result = { ...base, passed: false, reason: "no_sql", error: "模型没有生成可执行 SQL" } as const;
      results.push(result);
      options.onProgress?.(result, index, total);
      continue;
    }

    let actual: QueryResultSet;
    try {
      actual = await options.executeSql(generatedSql, options.dialect);
    } catch (error) {
      const result = {
        ...base,
        generatedSql,
        passed: false,
        reason: "execution_error",
        error: error instanceof Error ? error.message : String(error),
      } as const;
      results.push(result);
      options.onProgress?.(result, index, total);
      continue;
    }

    const expected = await options.executeSql(expectedSql, options.dialect);
    const comparison = compareResultSets(expected, actual, { ordered: item.ordered });
    const result: EvalCaseResult = {
      ...base,
      generatedSql,
      passed: comparison.equal,
      ...(comparison.equal
        ? {}
        : {
            reason: "mismatch",
            comparison,
            error: comparison.detail,
          }),
    };
    results.push(result);
    options.onProgress?.(result, index, total);
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    dialect: options.dialect,
    total,
    passed,
    failed: total - passed,
    passRate: total === 0 ? 0 : passed / total,
    cases: results,
  };
}
