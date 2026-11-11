import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderEvalMarkdown, writeEvalReport, type EvalReport } from "../src/eval/report.js";
import type { EvalSummary } from "../src/eval/runner.js";

const summary: EvalSummary = {
  dialect: "mysql",
  total: 2,
  passed: 1,
  failed: 1,
  passRate: 0.5,
  cases: [
    {
      id: "ok",
      question: "数一下",
      passed: true,
      expectedSql: "SELECT 1",
      generatedSql: "SELECT 1",
      durationMs: 1200,
    },
    {
      id: "bad",
      question: "按城市 | 统计",
      passed: false,
      reason: "mismatch",
      error: "sorted rows differ",
      expectedSql: "SELECT 1",
      generatedSql: "SELECT 2",
      durationMs: 2400,
      comparison: {
        equal: false,
        reason: "value_mismatch",
        detail: "sorted rows differ",
        expectedSample: [[1]],
        actualSample: [[2]],
      },
    },
  ],
};

const report: EvalReport = {
  meta: {
    modelId: "siliconflow::deepseek-ai/DeepSeek-V3.2",
    threshold: 0.8,
    startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    finishedAt: Date.UTC(2026, 0, 2, 3, 5, 5),
  },
  summary,
};

describe("eval report", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("renders the summary, threshold, and failure details", () => {
    const markdown = renderEvalMarkdown(report);
    expect(markdown).toContain("50.0%");
    expect(markdown).toContain("siliconflow::deepseek-ai/DeepSeek-V3.2");
    expect(markdown).toContain("| ok | ✅ |");
    expect(markdown).toContain("| bad | ❌ |");
    expect(markdown).toContain("按城市 | 统计");
    expect(markdown).toContain("sorted rows differ");
    expect(markdown).toContain("```sql");
  });

  it("writes json and markdown files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dc-eval-report-"));
    dirs.push(dir);
    const paths = await writeEvalReport(report, dir);
    expect(paths.jsonPath).toMatch(/nl2sql-20260102-030405-mysql\.json$/);
    const json = JSON.parse(await readFile(paths.jsonPath, "utf8")) as EvalReport;
    expect(json.summary.passRate).toBe(0.5);
    expect(await readFile(paths.markdownPath, "utf8")).toContain("NL2SQL 评测报告");
  });
});
