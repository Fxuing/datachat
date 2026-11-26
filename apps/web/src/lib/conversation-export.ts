import type { ChatArtifact, ChatMessage } from "./api";
import { parseChatMarkdown, reportsFromMessage } from "./report-markdown";
import { chartTitleFromSpec } from "../components/chat/ChartCard";
import { parseExcelSpec } from "../components/chat/ExcelCard";

export interface ConversationExportInput {
  title: string;
  sourceLabel?: string | null;
  messages: ChatMessage[];
  artifacts?: ChatArtifact[];
  exportedAt?: number;
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function sanitizeFileName(raw: string, fallback: string, ext: string): string {
  const safe = raw.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || fallback}.${ext}`;
}

/**
 * Render an entire conversation into a clean, self-contained Markdown document.
 * Inline chart/result/artifact markers are replaced with readable labels so the
 * exported file has no dangling `[[...]]` syntax.
 */
export function buildConversationMarkdown(input: ConversationExportInput): string {
  const title = input.title.trim() || "未命名会话";
  const artifacts = input.artifacts ?? [];
  const artifactMap = new Map(artifacts.map((item) => [item.id, item]));
  const reportTitleMap = new Map<string, string>();
  for (const message of input.messages) {
    for (const report of reportsFromMessage(message)) {
      reportTitleMap.set(report.reportId, report.title);
    }
  }
  const exportedAt = input.exportedAt ?? Date.now();

  const lines: string[] = [`# ${title}`, ""];
  if (input.sourceLabel) {
    lines.push(`- 数据来源：${input.sourceLabel}`);
  }
  lines.push(`- 导出时间：${formatDateTime(exportedAt)}`, "");

  input.messages.forEach((message, index) => {
    lines.push("---", "", `## 第 ${index + 1} 轮`, "");
    const skillPrefix = message.user.skill ? `\`/${message.user.skill}\` ` : "";
    lines.push("### 提问", "", `${skillPrefix}${message.user.content}`, "");

    lines.push("### 回答", "");
    const assistantText = message.assistant?.content ?? "";
    if (assistantText.trim()) {
      const segments = parseChatMarkdown(assistantText);
      const rendered = segments
        .map((segment) => {
          if (segment.type === "markdown") return segment.content;
          if (segment.type === "chart") {
            const chart = artifactMap.get(segment.artifactId);
            const label = chart ? chartTitleFromSpec(chart.spec) : "图表";
            return `\n> [图表] ${label}\n`;
          }
          if (segment.type === "result") {
            const label = segment.label?.trim() || "查询结果";
            return `\n> [数据表] ${label}\n`;
          }
          if (segment.type === "excel") {
            const excel = artifactMap.get(segment.artifactId);
            const parsed = excel ? parseExcelSpec(excel.spec) : null;
            return parsed
              ? `\n> [Excel 文件] ${parsed.filename}.xlsx\n`
              : "\n> [Excel 文件]\n";
          }
          if (segment.type === "report") {
            const reportTitle = reportTitleMap.get(segment.reportId);
            return reportTitle
              ? `\n> [分析报告] ${reportTitle}\n`
              : "\n> [分析报告]\n";
          }
          const art = artifactMap.get(segment.artifactId);
          if (art?.kind === "excel") {
            const parsed = parseExcelSpec(art.spec);
            return `\n> [附件] ${parsed ? `${parsed.filename}.xlsx` : "Excel 文件"}\n`;
          }
          const label =
            art?.kind === "chart" ? chartTitleFromSpec(art.spec) : "查询结果";
          return `\n> [附件] ${label}\n`;
        })
        .join("")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      lines.push(rendered, "");
    } else if (message.status === "aborted") {
      lines.push("> 本轮回答已停止生成。", "");
    }

    if (message.status === "error") {
      lines.push(`> 错误：${message.error ?? "本次回答失败。"}`, "");
    }

    if (message.sqls.length > 0) {
      lines.push("#### 执行的 SQL", "");
      for (const entry of message.sqls) {
        lines.push("```sql", entry.sql.trim(), "```", "");
      }
    }
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Trigger a client-side file download from a Blob. */
export function downloadBlobFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Trigger a client-side file download with UTF-8 content. */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  downloadBlobFile(filename, new Blob([content], { type: mimeType }));
}
