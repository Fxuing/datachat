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
  /** Per-attempt details when `repeat > 1`; the top-level fields summarize the case. */
  attempts?: EvalCaseResult[];
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
  repeat?: number;
}

function expectedSqlFor(item: EvalCase, dialect: Dialect): string {
  return dialect === "mysql" ? item.mysql : item.postgres;
}

/**
 * Execute every golden case through the agent, then grade the generated SQL by
 * running it against the same fixture and comparing result sets. The agent is
 * never graded on SQL text, column aliases, or its natural-language answer.
 */
async function runOneCase(
  item: EvalCase,
  options: RunEvalOptions,
): Promise<EvalCaseResult> {
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
    return { ...base, passed: false, reason: "agent_error", error: agentOutput.error };
  }

  const generatedSql = agentOutput.sql?.trim();
  if (!generatedSql) {
    return { ...base, passed: false, reason: "no_sql", error: "模型没有生成可执行 SQL" };
  }

  let actual: QueryResultSet;
  try {
    actual = await options.executeSql(generatedSql, options.dialect);
  } catch (error) {
    return {
      ...base,
      generatedSql,
      passed: false,
      reason: "execution_error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const expected = await options.executeSql(expectedSql, options.dialect);
  const comparison = compareResultSets(expected, actual, { ordered: item.ordered });
  return {
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
}

/**
 * Execute every golden case through the agent, then grade the generated SQL by
 * running it against the same fixture and comparing result sets. The agent is
 * never graded on SQL text, column aliases, or its natural-language answer.
 *
 * With `repeat > 1` a case passes when at least one attempt passes; attempts are
 * kept in the result so callers can report stability (pass@n / per-attempt).
 */
export async function runEvalCases(options: RunEvalOptions): Promise<EvalSummary> {
  const repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error("repeat 必须是大于 0 的整数");
  }
  const results: EvalCaseResult[] = [];
  const total = options.cases.length;

  for (const [index, item] of options.cases.entries()) {
    if (options.signal?.aborted) {
      const cancelled: EvalCaseResult = {
        id: item.id,
        question: item.question,
        passed: false,
        reason: "cancelled",
        expectedSql: expectedSqlFor(item, options.dialect),
        durationMs: 0,
      };
      results.push(cancelled);
      options.onProgress?.(cancelled, index, total);
      continue;
    }

    const attempts: EvalCaseResult[] = [];
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      if (options.signal?.aborted) {
        attempts.push({
          id: item.id,
          question: item.question,
          passed: false,
          reason: "cancelled",
          expectedSql: expectedSqlFor(item, options.dialect),
          durationMs: 0,
        });
        break;
      }
      attempts.push(await runOneCase(item, options));
    }

    const passedAttempt = attempts.find((attempt) => attempt.passed);
    const last = attempts[attempts.length - 1]!;
    const durationMs = attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);
    const usage = attempts.reduce(
      (sum, attempt) => ({
        inputTokens: (sum.inputTokens ?? 0) + (attempt.usage?.inputTokens ?? 0),
        outputTokens: (sum.outputTokens ?? 0) + (attempt.usage?.outputTokens ?? 0),
      }),
      {} as { inputTokens: number; outputTokens: number },
    );
    const result: EvalCaseResult = {
      id: item.id,
      question: item.question,
      expectedSql: expectedSqlFor(item, options.dialect),
      passed: Boolean(passedAttempt),
      durationMs,
      ...(attempts.some((attempt) => attempt.usage) ? { usage } : {}),
      ...(passedAttempt?.generatedSql ? { generatedSql: passedAttempt.generatedSql } : {}),
      ...(passedAttempt ? {} : { reason: last.reason, error: last.error, comparison: last.comparison }),
      ...(attempts.some((attempt) => attempt.generatedSql) && !passedAttempt
        ? { generatedSql: last.generatedSql }
        : {}),
      ...(repeat > 1 ? { attempts } : {}),
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
