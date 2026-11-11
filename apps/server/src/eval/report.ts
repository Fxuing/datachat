import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalSummary } from "./runner.js";

export interface EvalReportMeta {
  modelId: string;
  threshold: number;
  startedAt: number;
  finishedAt: number;
  /** Optional note, e.g. "15 cases x 2 dialects". */
  note?: string;
}

export interface EvalReport {
  meta: EvalReportMeta;
  summary: EvalSummary;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function cell(value: string): string {
  const text = oneLine(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

export function renderEvalMarkdown(report: EvalReport): string {
  const { meta, summary } = report;
  const lines: string[] = [];
  lines.push(`# NL2SQL 评测报告（${summary.dialect}）`);
  lines.push("");
  lines.push(`- 模型：\`${meta.modelId}\``);
  lines.push(`- 时间：${new Date(meta.startedAt).toISOString()} → ${new Date(meta.finishedAt).toISOString()}`);
  lines.push(`- 通过率：**${percent(summary.passRate)}**（${summary.passed}/${summary.total}）`);
  lines.push(`- 阈值：${percent(meta.threshold)} → ${summary.passRate >= meta.threshold ? "通过" : "未通过"}`);
  if (meta.note) lines.push(`- 说明：${meta.note}`);
  lines.push("");
  lines.push("| 用例 | 结果 | 耗时 | 原因 | 生成 SQL |");
  lines.push("| --- | --- | ---: | --- | --- |");
  for (const item of summary.cases) {
    const status = item.passed ? "✅" : "❌";
    const reason = item.reason ?? "";
    const sql = item.generatedSql ? `\`${cell(item.generatedSql)}\`` : "";
    lines.push(
      `| ${cell(item.id)} | ${status} | ${(item.durationMs / 1000).toFixed(1)}s | ${reason} | ${sql} |`,
    );
  }

  const failures = summary.cases.filter((item) => !item.passed);
  if (failures.length > 0) {
    lines.push("");
    lines.push("## 失败详情");
    for (const item of failures) {
      lines.push("");
      lines.push(`### ${item.id}`);
      lines.push("");
      lines.push(`问题：${item.question}`);
      if (item.error) lines.push(`错误：${item.error}`);
      if (item.expectedSql) lines.push(`\n期望 SQL：\n\n\`\`\`sql\n${item.expectedSql}\n\`\`\``);
      if (item.generatedSql) {
        lines.push(`\n生成 SQL：\n\n\`\`\`sql\n${item.generatedSql}\n\`\`\``);
      }
      if (item.comparison && !item.comparison.equal) {
        lines.push(`\n比较：${item.comparison.detail}`);
        if (item.comparison.expectedSample) {
          lines.push(`\n期望样例：\n\n\`\`\`json\n${JSON.stringify(item.comparison.expectedSample)}\n\`\`\``);
        }
        if (item.comparison.actualSample) {
          lines.push(`\n实际样例：\n\n\`\`\`json\n${JSON.stringify(item.comparison.actualSample)}\n\`\`\``);
        }
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

function fileStamp(timestamp: number): string {
  const iso = new Date(timestamp).toISOString();
  return iso.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export async function writeEvalReport(
  report: EvalReport,
  outputDir: string,
): Promise<{ jsonPath: string; markdownPath: string }> {
  await mkdir(outputDir, { recursive: true });
  const base = `nl2sql-${fileStamp(report.meta.startedAt)}-${report.summary.dialect}`;
  const jsonPath = join(outputDir, `${base}.json`);
  const markdownPath = join(outputDir, `${base}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderEvalMarkdown(report), "utf8");
  return { jsonPath, markdownPath };
}
