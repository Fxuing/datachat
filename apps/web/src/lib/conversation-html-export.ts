import type { Column, ReportDetail } from "@datachat/shared";
import { parseExcelSpec } from "../components/chat/ExcelCard";
import {
  getArtifact,
  getArtifactRows,
  getReport,
  type ChatArtifact,
  type ChatMessage,
  type ChatResult,
} from "./api";
import {
  downloadTextFile,
  sanitizeFileName,
  type ConversationExportInput,
} from "./conversation-export";
import { escapeHtml, serializeArticleForHtml } from "./report-export";
import {
  parseChatMarkdown,
  reportArtifactIdsFromTools,
  reportsFromMessage,
  type ChatSegment,
} from "./report-markdown";
import {
  buildMissingArtifactElement,
  buildOffscreenReportArticle,
  buildTableArtifactElement,
  CHART_EXPORT_HEIGHT,
  CHART_EXPORT_WIDTH,
  renderMarkdownSection,
} from "./report-offscreen-export";
import { formatCount } from "./utils";

interface CachedReportHtml {
  title: string;
  createdAt: number;
  updatedAt: number;
  bodyHtml: string;
}

interface TurnPlan {
  message: ChatMessage;
  turnNumber: number;
  segments: ChatSegment[];
  standaloneCharts: ChatArtifact[];
  standaloneExcels: ChatArtifact[];
  standaloneReports: Array<{ reportId: string; title: string }>;
  standaloneResults: ChatResult[];
}

interface ChartModules {
  chartTitleFromSpec: (spec: unknown) => string;
  chartOptionFromSpec: (spec: unknown) => Record<string, unknown> | null;
  renderChartOptionToPng: (
    option: Record<string, unknown> | null,
    options?: { width?: number; height?: number },
  ) => { dataUrl: string; width: number; height: number } | null;
}

const CONVERSATION_HTML_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 28px 18px 64px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.7;
  color: #18181b;
  background: #fafafa;
}
.page-shell {
  max-width: 920px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.doc-header {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  padding: 24px 28px;
}
.doc-header h1 {
  margin: 0 0 10px;
  font-size: 22px;
  line-height: 1.35;
  color: #18181b;
}
.doc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin: 0;
  font-size: 12px;
  color: #52525b;
}
.doc-meta-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: #eef2ff;
  color: #4338ca;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 500;
}
.doc-toc {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  padding: 16px 22px;
}
.doc-toc-title {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  color: #52525b;
  letter-spacing: 0.02em;
}
.toc-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.toc-turn,
.toc-report {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
  text-decoration: none;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.toc-turn {
  border: 1px solid #e4e4e7;
  background: #fafafa;
  color: #27272a;
}
.toc-turn:hover {
  background: #f4f4f5;
  border-color: #d4d4d8;
}
.toc-report {
  border: 1px solid #c7d2fe;
  background: #eef2ff;
  color: #4338ca;
  font-weight: 500;
}
.toc-report:hover {
  background: #e0e7ff;
}
.turn {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.turn-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 4px;
  font-size: 12px;
  color: #71717a;
}
.turn-label {
  font-weight: 600;
  color: #3f3f46;
}
.user-row {
  display: flex;
  justify-content: flex-end;
}
.user-bubble {
  max-width: 85%;
  border-radius: 16px 16px 4px 16px;
  background: #18181b;
  color: #fafafa;
  padding: 10px 16px;
  font-size: 14px;
  line-height: 1.6;
}
.user-skill {
  display: inline-flex;
  align-items: center;
  margin-bottom: 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.14);
  color: #e4e4e7;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 500;
}
.user-text {
  white-space: pre-wrap;
  word-break: break-word;
}
.assistant-card {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
  padding: 18px 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.assistant-label {
  font-size: 11px;
  font-weight: 600;
  color: #71717a;
}
.scope-banner {
  border: 1px solid #e4e4e7;
  background: #f4f4f5;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: #3f3f46;
}
.markdown h1 { margin: 18px 0 8px; font-size: 20px; line-height: 1.35; }
.markdown h2 { margin: 16px 0 8px; font-size: 17px; line-height: 1.4; }
.markdown h3 { margin: 14px 0 6px; font-size: 15px; line-height: 1.4; }
.markdown p { margin: 8px 0; }
.markdown ul, .markdown ol { margin: 8px 0; padding-left: 22px; }
.markdown blockquote {
  margin: 10px 0;
  padding: 8px 14px;
  border-left: 3px solid #d4d4d8;
  color: #52525b;
  background: #f4f4f5;
  border-radius: 0 6px 6px 0;
}
.markdown pre,
.sql-pre {
  margin: 10px 0;
  padding: 12px 14px;
  overflow-x: auto;
  background: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}
.markdown code,
.sql-pre code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
}
.markdown a { color: #4338ca; text-decoration: underline; }
.markdown figure { margin: 12px 0; overflow-x: auto; }
.markdown table,
.report-artifact table {
  width: 100%;
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12px;
}
.markdown th, .markdown td,
.report-artifact th, .report-artifact td {
  border: 1px solid #e4e4e7;
  padding: 6px 10px;
  text-align: left;
  white-space: nowrap;
}
.markdown th,
.report-artifact th {
  background: #f4f4f5;
  font-weight: 600;
}
.report-artifact th.text-right,
.report-artifact td.text-right {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.report-table-scroll {
  overflow-x: auto;
  max-width: 100%;
}
.report-table-footer {
  font-size: 12px;
  color: #71717a;
  margin-top: 6px;
}
.chart-card,
.excel-card,
.result-card,
.fallback-card {
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  background: #ffffff;
  padding: 12px 14px;
}
.chart-card-head,
.excel-card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.chart-card-title,
.excel-card-title {
  font-size: 13px;
  font-weight: 600;
  color: #18181b;
}
.chart-card-meta,
.excel-card-meta {
  font-size: 11px;
  color: #71717a;
}
.chart-card img,
.report-artifact img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 4px auto;
}
svg { max-width: 100%; height: auto; }
.excel-sheets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.excel-sheet-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  border: 1px solid #e4e4e7;
  background: #f4f4f5;
  padding: 2px 8px;
  font-size: 11px;
  color: #3f3f46;
}
details.result-details,
details.sql-details {
  border: 1px solid #e4e4e7;
  border-radius: 10px;
  background: #fafafa;
  padding: 8px 12px;
}
details.result-details > summary,
details.sql-details > summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  font-weight: 500;
  color: #3f3f46;
}
details.result-details > summary::-webkit-details-marker,
details.sql-details > summary::-webkit-details-marker {
  display: none;
}
details.result-details > summary::after,
details.sql-details > summary::after {
  content: "展开";
  font-size: 11px;
  color: #4f46e5;
  flex-shrink: 0;
}
details.result-details[open] > summary::after,
details.sql-details[open] > summary::after {
  content: "收起";
}
.details-body {
  margin-top: 10px;
}
details.embedded-report {
  border: 1px solid #c7d2fe;
  border-radius: 12px;
  background: #ffffff;
  overflow: hidden;
}
summary.embedded-report-summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  background: #eef2ff;
  border-bottom: 1px solid transparent;
}
summary.embedded-report-summary::-webkit-details-marker {
  display: none;
}
details.embedded-report[open] > summary.embedded-report-summary {
  border-bottom-color: #c7d2fe;
}
.embedded-report-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.embedded-report-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  background: #4f46e5;
  color: #ffffff;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
}
.embedded-report-title {
  font-size: 14px;
  font-weight: 600;
  color: #1e1b4b;
}
.embedded-report-meta {
  font-size: 11px;
  color: #4338ca;
}
.embedded-report-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  color: #4338ca;
  flex-shrink: 0;
}
.embedded-report-toggle::before {
  content: "展开完整报告";
}
details.embedded-report[open] .embedded-report-toggle::before {
  content: "收起完整报告";
}
.embedded-report-body {
  padding: 18px 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.embedded-report-body h1 { margin: 14px 0 6px; font-size: 20px; line-height: 1.35; }
.embedded-report-body h2 { margin: 16px 0 8px; font-size: 17px; line-height: 1.4; }
.embedded-report-body h3 { margin: 14px 0 6px; font-size: 15px; line-height: 1.4; }
.embedded-report-body .report-artifact { margin: 8px 0; }
.status-notice {
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
}
.status-notice.is-aborted {
  border: 1px solid #e4e4e7;
  background: #f4f4f5;
  color: #52525b;
}
.status-notice.is-error {
  border: 1px solid #fecaca;
  background: #fef2f2;
  color: #b91c1c;
}
.fallback-note {
  margin: 0;
  font-size: 12px;
  color: #71717a;
}
@media print {
  body { padding: 0; background: #ffffff; }
  .doc-toc { display: none; }
  .assistant-card, .doc-header, .chart-card, details.embedded-report { break-inside: avoid-page; }
}
`;

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function truncateLabel(text: string, maxLength = 34): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "未命名提问";
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function buildChartCardElement(
  artifact: ChatArtifact | undefined,
  chartModules: ChartModules | null,
): HTMLElement {
  if (!artifact) {
    return buildMissingFallbackCard("图表引用不可用");
  }
  const title = chartModules ? chartModules.chartTitleFromSpec(artifact.spec) : "图表";
  const card = document.createElement("div");
  card.className = "chart-card";

  const head = document.createElement("div");
  head.className = "chart-card-head";
  const titleSpan = document.createElement("span");
  titleSpan.className = "chart-card-title";
  titleSpan.textContent = title;
  head.appendChild(titleSpan);

  if (artifact.rowCount > 0) {
    const metaSpan = document.createElement("span");
    metaSpan.className = "chart-card-meta";
    metaSpan.textContent = `${formatCount(artifact.rowCount)} 个数据点`;
    head.appendChild(metaSpan);
  }
  card.appendChild(head);

  const snapshot =
    chartModules && artifact.spec !== null && artifact.spec !== undefined
      ? chartModules.renderChartOptionToPng(chartModules.chartOptionFromSpec(artifact.spec), {
          width: CHART_EXPORT_WIDTH,
          height: CHART_EXPORT_HEIGHT,
        })
      : null;

  if (snapshot) {
    const img = document.createElement("img");
    img.src = snapshot.dataUrl;
    img.alt = title;
    card.appendChild(img);
  } else {
    const fallback = document.createElement("p");
    fallback.className = "fallback-note";
    fallback.textContent = "图表渲染不可用";
    card.appendChild(fallback);
  }

  return card;
}

function buildMissingFallbackCard(message: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "fallback-card";
  const note = document.createElement("p");
  note.className = "fallback-note";
  note.textContent = message;
  card.appendChild(note);
  return card;
}

function buildExcelCardElement(artifact: ChatArtifact | undefined): HTMLElement {
  if (!artifact) {
    return buildMissingFallbackCard("Excel 文件不可用");
  }
  const parsed = parseExcelSpec(artifact.spec);
  if (!parsed) {
    return buildMissingFallbackCard("Excel 文件元数据不可用");
  }

  const card = document.createElement("div");
  card.className = "excel-card";

  const head = document.createElement("div");
  head.className = "excel-card-head";

  const titleSpan = document.createElement("span");
  titleSpan.className = "excel-card-title";
  titleSpan.textContent = `${parsed.filename}.xlsx`;

  const metaSpan = document.createElement("span");
  metaSpan.className = "excel-card-meta";
  metaSpan.textContent = `${parsed.sheets.length} 个工作表 · 共 ${formatCount(parsed.totalRows)} 行（需在 DataChat 中下载）`;

  head.append(titleSpan, metaSpan);
  card.appendChild(head);

  if (parsed.sheets.length > 0) {
    const sheets = document.createElement("div");
    sheets.className = "excel-sheets";
    for (const sheet of parsed.sheets) {
      const chip = document.createElement("span");
      chip.className = "excel-sheet-chip";
      chip.textContent = `${sheet.name}（${formatCount(sheet.rowCount)} 行）`;
      sheets.appendChild(chip);
    }
    card.appendChild(sheets);
  }

  return card;
}

function buildCollapsibleResultElement(input: {
  label: string;
  columns: Column[];
  rows: unknown[][];
  rowCount: number;
}): HTMLElement {
  const details = document.createElement("details");
  details.className = "result-details";

  const summary = document.createElement("summary");
  const titleSpan = document.createElement("span");
  titleSpan.textContent = `数据表 · ${input.label}（共 ${formatCount(input.rowCount)} 行）`;
  summary.appendChild(titleSpan);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "details-body";
  body.appendChild(
    buildTableArtifactElement(input.columns, input.rows.slice(0, 100), input.rowCount),
  );
  details.appendChild(body);
  return details;
}

function buildEmbeddedReportElement(input: {
  anchorId: string;
  reportId: string;
  cached?: CachedReportHtml;
  fallbackTitle?: string;
}): HTMLElement {
  if (!input.cached) {
    return buildMissingFallbackCard(
      input.fallbackTitle
        ? `分析报告「${input.fallbackTitle}」不可用或已被删除。`
        : "分析报告不可用或已被删除。",
    );
  }

  const details = document.createElement("details");
  details.className = "embedded-report";
  details.id = input.anchorId;

  const summary = document.createElement("summary");
  summary.className = "embedded-report-summary";

  const heading = document.createElement("div");
  heading.className = "embedded-report-heading";

  const badge = document.createElement("span");
  badge.className = "embedded-report-badge";
  badge.textContent = "分析报告";

  const titleEl = document.createElement("span");
  titleEl.className = "embedded-report-title";
  titleEl.textContent = input.cached.title;

  const metaEl = document.createElement("span");
  metaEl.className = "embedded-report-meta";
  metaEl.textContent = `创建于 ${formatTimestamp(input.cached.createdAt)}${
    input.cached.updatedAt > input.cached.createdAt
      ? ` · 更新于 ${formatTimestamp(input.cached.updatedAt)}`
      : ""
  }`;

  heading.append(badge, titleEl, metaEl);

  const toggle = document.createElement("span");
  toggle.className = "embedded-report-toggle";
  toggle.setAttribute("aria-hidden", "true");

  summary.append(heading, toggle);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "embedded-report-body";
  body.innerHTML = input.cached.bodyHtml;
  details.appendChild(body);

  return details;
}

async function prepareCachedReport(report: ReportDetail): Promise<CachedReportHtml> {
  const { article, cleanup } = await buildOffscreenReportArticle(report);
  try {
    const serialized = serializeArticleForHtml(article);
    const firstHeader = serialized.querySelector(":scope > header");
    if (firstHeader) {
      firstHeader.remove();
    }
    return {
      title: report.title.trim() || "分析报告",
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      bodyHtml: serialized.innerHTML,
    };
  } finally {
    cleanup();
  }
}

/**
 * Build a self-contained, zero-script offline HTML document for an entire
 * conversation, embedding light-theme charts, data table previews, Mermaid
 * diagrams, collapsible SQL blocks, and collapsible full analysis reports.
 */
export async function buildConversationHtml(input: ConversationExportInput): Promise<string> {
  const title = input.title.trim() || "未命名会话";
  const exportedAt = input.exportedAt ?? Date.now();
  const inputArtifacts = input.artifacts ?? [];

  const artifactMap = new Map<string, ChatArtifact>(
    inputArtifacts.map((artifact) => [artifact.id, artifact]),
  );
  const resultMap = new Map<string, ChatResult>();
  const reportTitleMap = new Map<string, string>();

  const referencedReportIds = new Set<string>();
  const missingOrIncompleteArtifactIds = new Set<string>();
  const referencedResultIds = new Set<string>();

  const plans: TurnPlan[] = input.messages.map((message, index) => {
    for (const result of message.results) {
      if (!resultMap.has(result.artifactId)) {
        resultMap.set(result.artifactId, result);
      }
    }
    const turnReports = reportsFromMessage(message);
    for (const report of turnReports) {
      reportTitleMap.set(report.reportId, report.title);
    }

    const assistantText = message.assistant?.content ?? "";
    const segments = assistantText.trim() ? parseChatMarkdown(assistantText) : [];

    const turnReferencedArtifactIds = new Set<string>();
    const turnReferencedReportIds = new Set<string>();

    for (const segment of segments) {
      if (segment.type === "report") {
        turnReferencedReportIds.add(segment.reportId);
        referencedReportIds.add(segment.reportId);
        continue;
      }
      if (
        segment.type === "chart" ||
        segment.type === "result" ||
        segment.type === "excel" ||
        segment.type === "artifact"
      ) {
        turnReferencedArtifactIds.add(segment.artifactId);
        const existing = artifactMap.get(segment.artifactId);
        if (
          !existing ||
          ((existing.kind === "chart" || existing.kind === "excel") &&
            (existing.spec === null || existing.spec === undefined))
        ) {
          missingOrIncompleteArtifactIds.add(segment.artifactId);
        }
        if (segment.type === "result" || segment.type === "artifact") {
          referencedResultIds.add(segment.artifactId);
        }
      }
    }

    for (const report of turnReports) {
      referencedReportIds.add(report.reportId);
    }

    const reportArtifactIds = reportArtifactIdsFromTools(message.tools);
    const turnArtifacts = inputArtifacts.filter((artifact) => artifact.runId === message.runId);
    const standaloneCharts = turnArtifacts.filter(
      (artifact) =>
        artifact.kind === "chart" &&
        !turnReferencedArtifactIds.has(artifact.id) &&
        !reportArtifactIds.has(artifact.id),
    );
    const standaloneExcels = turnArtifacts.filter(
      (artifact) =>
        artifact.kind === "excel" && !turnReferencedArtifactIds.has(artifact.id),
    );
    const standaloneReports = turnReports.filter(
      (report) => !turnReferencedReportIds.has(report.reportId),
    );
    const standaloneResults = message.results.filter(
      (result) => !turnReferencedArtifactIds.has(result.artifactId),
    );

    return {
      message,
      turnNumber: index + 1,
      segments,
      standaloneCharts,
      standaloneExcels,
      standaloneReports,
      standaloneResults,
    };
  });

  // Fetch missing/incomplete referenced artifacts (e.g. chart specs omitted from summary).
  const artifactFetchIds = Array.from(missingOrIncompleteArtifactIds);
  if (artifactFetchIds.length > 0) {
    const settled = await Promise.allSettled(artifactFetchIds.map((id) => getArtifact(id)));
    settled.forEach((outcome) => {
      if (outcome.status !== "fulfilled") return;
      const detail = outcome.value;
      const prev = artifactMap.get(detail.id);
      artifactMap.set(detail.id, {
        id: detail.id,
        runId: prev?.runId ?? null,
        kind: detail.kind,
        columns: detail.columns,
        rowCount: detail.rowCount,
        truncated: detail.truncated,
        spec: detail.spec,
        createdAt: detail.createdAt,
      });
    });
  }

  // Fetch preview rows for referenced result artifacts that didn't inline rows in message.results.
  const rowsToFetch = Array.from(referencedResultIds).filter((id) => {
    if (resultMap.has(id)) return false;
    const art = artifactMap.get(id);
    return !art || art.kind === "result";
  });
  if (rowsToFetch.length > 0) {
    const settledRows = await Promise.allSettled(
      rowsToFetch.map((id) => getArtifactRows(id, { limit: 100 })),
    );
    settledRows.forEach((outcome, index) => {
      if (outcome.status !== "fulfilled") return;
      const artifactId = rowsToFetch[index]!;
      const art = artifactMap.get(artifactId);
      const data = outcome.value;
      const totalRows = art?.rowCount ?? data.total ?? data.rows.length;
      const previewRows = data.rows.slice(0, 100);
      resultMap.set(artifactId, {
        artifactId,
        columns: data.columns,
        rows: previewRows,
        rowCount: totalRows,
        truncated: art?.truncated ?? totalRows > previewRows.length,
      });
    });
  }

  // Fetch and build offscreen light-theme HTML once per distinct report ID.
  const reportHtmlCache = new Map<string, CachedReportHtml>();
  const allReportIds = Array.from(referencedReportIds);
  if (allReportIds.length > 0) {
    const settledReports = await Promise.allSettled(allReportIds.map((id) => getReport(id)));
    for (const outcome of settledReports) {
      if (outcome.status !== "fulfilled") continue;
      const report = outcome.value.report;
      try {
        const prepared = await prepareCachedReport(report);
        reportHtmlCache.set(report.id, prepared);
        reportTitleMap.set(report.id, prepared.title);
      } catch {
        // Fallback card handles failed report preparation cleanly.
      }
    }
  }

  // Load chart rendering modules once only when conversation-level charts exist.
  const hasConversationCharts = plans.some(
    (plan) =>
      plan.standaloneCharts.length > 0 ||
      plan.segments.some(
        (segment) =>
          segment.type === "chart" ||
          (segment.type === "artifact" && artifactMap.get(segment.artifactId)?.kind === "chart"),
      ),
  );
  let chartModules: ChartModules | null = null;
  if (hasConversationCharts) {
    const [{ chartTitleFromSpec, chartOptionFromSpec }, { renderChartOptionToPng }] =
      await Promise.all([
        import("../components/chat/ChartCard"),
        import("../components/chat/EChart"),
      ]);
    chartModules = { chartTitleFromSpec, chartOptionFromSpec, renderChartOptionToPng };
  }

  const root = document.createElement("div");
  root.className = "page-shell";

  const tocReports: Array<{ anchorId: string; title: string }> = [];
  let reportCounter = 0;
  let totalChartCount = 0;

  const turnSections: HTMLElement[] = [];

  for (const plan of plans) {
    const { message, turnNumber } = plan;
    const section = document.createElement("section");
    section.className = "turn";
    section.id = `turn-${turnNumber}`;

    const turnHead = document.createElement("div");
    turnHead.className = "turn-head";
    const turnLabel = document.createElement("span");
    turnLabel.className = "turn-label";
    turnLabel.textContent = `第 ${turnNumber} 轮`;
    turnHead.appendChild(turnLabel);
    if (message.createdAt) {
      const turnTime = document.createElement("span");
      turnTime.textContent = formatTimestamp(message.createdAt);
      turnHead.appendChild(turnTime);
    }
    section.appendChild(turnHead);

    const userRow = document.createElement("div");
    userRow.className = "user-row";
    const userBubble = document.createElement("div");
    userBubble.className = "user-bubble";
    if (message.user.skill) {
      const skillBadge = document.createElement("div");
      skillBadge.className = "user-skill";
      skillBadge.textContent = `技能 · ${message.user.skill}`;
      userBubble.appendChild(skillBadge);
    }
    const userText = document.createElement("div");
    userText.className = "user-text";
    userText.textContent = message.user.content;
    userBubble.appendChild(userText);
    userRow.appendChild(userBubble);
    section.appendChild(userRow);

    const assistantCard = document.createElement("div");
    assistantCard.className = "assistant-card";

    const assistantLabel = document.createElement("div");
    assistantLabel.className = "assistant-label";
    assistantLabel.textContent = "DataChat 助手";
    assistantCard.appendChild(assistantLabel);

    if (message.scope && message.scope.departments.length > 0) {
      const scopeBanner = document.createElement("div");
      scopeBanner.className = "scope-banner";
      const deptSummary =
        message.scope.departments.length > 3
          ? `${message.scope.departments.slice(0, 3).join("、")} 等 ${message.scope.departments.length} 个部门`
          : message.scope.departments.join("、");
      scopeBanner.textContent = `数据范围：${deptSummary}（含下级部门）。本次结果已按当前数据权限过滤。`;
      assistantCard.appendChild(scopeBanner);
    }

    for (const segment of plan.segments) {
      if (segment.type === "markdown") {
        if (!segment.content.trim()) continue;
        assistantCard.appendChild(await renderMarkdownSection(segment.content));
        continue;
      }

      if (segment.type === "chart") {
        totalChartCount += 1;
        assistantCard.appendChild(
          buildChartCardElement(artifactMap.get(segment.artifactId), chartModules),
        );
        continue;
      }

      if (segment.type === "result") {
        const result = resultMap.get(segment.artifactId);
        const label = segment.label?.trim() || "查询结果";
        if (result) {
          assistantCard.appendChild(
            buildCollapsibleResultElement({
              label,
              columns: result.columns,
              rows: result.rows,
              rowCount: result.rowCount,
            }),
          );
        } else {
          assistantCard.appendChild(buildMissingArtifactElement(segment.artifactId, "结果不可用。"));
        }
        continue;
      }

      if (segment.type === "excel") {
        assistantCard.appendChild(buildExcelCardElement(artifactMap.get(segment.artifactId)));
        continue;
      }

      if (segment.type === "report") {
        const cached = reportHtmlCache.get(segment.reportId);
        const fallbackTitle = reportTitleMap.get(segment.reportId);
        if (cached) {
          reportCounter += 1;
          const anchorId = `report-${reportCounter}`;
          tocReports.push({ anchorId, title: cached.title });
          assistantCard.appendChild(
            buildEmbeddedReportElement({
              anchorId,
              reportId: segment.reportId,
              cached,
              fallbackTitle,
            }),
          );
        } else {
          assistantCard.appendChild(
            buildEmbeddedReportElement({
              anchorId: `report-missing-${segment.reportId}`,
              reportId: segment.reportId,
              fallbackTitle,
            }),
          );
        }
        continue;
      }

      // segment.type === "artifact"
      const art = artifactMap.get(segment.artifactId);
      if (art?.kind === "chart") {
        totalChartCount += 1;
        assistantCard.appendChild(buildChartCardElement(art, chartModules));
      } else if (art?.kind === "excel") {
        assistantCard.appendChild(buildExcelCardElement(art));
      } else {
        const result = resultMap.get(segment.artifactId);
        if (result) {
          const resultCard = document.createElement("div");
          resultCard.className = "result-card";
          resultCard.appendChild(
            buildTableArtifactElement(result.columns, result.rows.slice(0, 100), result.rowCount),
          );
          assistantCard.appendChild(resultCard);
        } else {
          assistantCard.appendChild(
            buildMissingArtifactElement(segment.artifactId, "结果不可用，可能已被删除。"),
          );
        }
      }
    }

    for (const chart of plan.standaloneCharts) {
      totalChartCount += 1;
      assistantCard.appendChild(buildChartCardElement(chart, chartModules));
    }

    for (const excel of plan.standaloneExcels) {
      assistantCard.appendChild(buildExcelCardElement(excel));
    }

    for (const report of plan.standaloneReports) {
      const cached = reportHtmlCache.get(report.reportId);
      if (cached) {
        reportCounter += 1;
        const anchorId = `report-${reportCounter}`;
        tocReports.push({ anchorId, title: cached.title });
        assistantCard.appendChild(
          buildEmbeddedReportElement({
            anchorId,
            reportId: report.reportId,
            cached,
            fallbackTitle: report.title,
          }),
        );
      } else {
        assistantCard.appendChild(
          buildEmbeddedReportElement({
            anchorId: `report-missing-${report.reportId}`,
            reportId: report.reportId,
            fallbackTitle: report.title,
          }),
        );
      }
    }

    for (const result of plan.standaloneResults) {
      assistantCard.appendChild(
        buildCollapsibleResultElement({
          label: "查询结果",
          columns: result.columns,
          rows: result.rows,
          rowCount: result.rowCount,
        }),
      );
    }

    if (message.status === "aborted") {
      const notice = document.createElement("div");
      notice.className = "status-notice is-aborted";
      notice.textContent = "本轮回答已停止生成。";
      assistantCard.appendChild(notice);
    } else if (message.status === "error") {
      const notice = document.createElement("div");
      notice.className = "status-notice is-error";
      notice.textContent = `错误：${message.error ?? "本次回答失败。"}`;
      assistantCard.appendChild(notice);
    }

    if (message.sqls.length > 0) {
      const sqlDetails = document.createElement("details");
      sqlDetails.className = "sql-details";
      const summary = document.createElement("summary");
      summary.textContent = `查看执行的 SQL（${message.sqls.length} 条）`;
      sqlDetails.appendChild(summary);

      const sqlBody = document.createElement("div");
      sqlBody.className = "details-body";
      for (const entry of message.sqls) {
        const pre = document.createElement("pre");
        pre.className = "sql-pre";
        const code = document.createElement("code");
        code.className = "language-sql";
        code.textContent = entry.sql.trim();
        pre.appendChild(code);
        sqlBody.appendChild(pre);
      }
      sqlDetails.appendChild(sqlBody);
      assistantCard.appendChild(sqlDetails);
    }

    section.appendChild(assistantCard);
    turnSections.push(section);
  }

  // Document header
  const docHeader = document.createElement("header");
  docHeader.className = "doc-header";
  const h1 = document.createElement("h1");
  h1.textContent = title;
  docHeader.appendChild(h1);

  const meta = document.createElement("div");
  meta.className = "doc-meta";
  if (input.sourceLabel) {
    const sourceBadge = document.createElement("span");
    sourceBadge.className = "doc-meta-badge";
    sourceBadge.textContent = `数据来源：${input.sourceLabel}`;
    meta.appendChild(sourceBadge);
  }
  const summaryStats = document.createElement("span");
  summaryStats.textContent = `共 ${plans.length} 轮对话 · ${totalChartCount} 张对话图表 · ${tocReports.length} 份内嵌报告`;
  meta.appendChild(summaryStats);

  const exportedSpan = document.createElement("span");
  exportedSpan.textContent = `导出时间：${formatTimestamp(exportedAt)}`;
  meta.appendChild(exportedSpan);

  docHeader.appendChild(meta);
  root.appendChild(docHeader);

  // Table of contents when multi-turn or reports are present
  if (plans.length > 1 || tocReports.length > 0) {
    const toc = document.createElement("nav");
    toc.className = "doc-toc";
    toc.setAttribute("aria-label", "会话目录");

    const tocTitle = document.createElement("p");
    tocTitle.className = "doc-toc-title";
    tocTitle.textContent = "快速导航";
    toc.appendChild(tocTitle);

    const tocList = document.createElement("div");
    tocList.className = "toc-list";

    for (const plan of plans) {
      const link = document.createElement("a");
      link.className = "toc-turn";
      link.href = `#turn-${plan.turnNumber}`;
      link.textContent = `${plan.turnNumber}. ${truncateLabel(plan.message.user.content)}`;
      tocList.appendChild(link);
    }
    for (const item of tocReports) {
      const link = document.createElement("a");
      link.className = "toc-report";
      link.href = `#${item.anchorId}`;
      link.textContent = `报告 · ${item.title}`;
      tocList.appendChild(link);
    }

    toc.appendChild(tocList);
    root.appendChild(toc);
  }

  for (const section of turnSections) {
    root.appendChild(section);
  }

  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle}</title>
<style>${CONVERSATION_HTML_STYLES}</style>
</head>
<body>
${root.outerHTML}
</body>
</html>
`;
}

/** Generate and download a self-contained offline HTML archive of the conversation. */
export async function exportConversationHtml(input: ConversationExportInput): Promise<void> {
  const html = await buildConversationHtml(input);
  const title = input.title.trim() || "未命名会话";
  downloadTextFile(
    sanitizeFileName(title, "datachat-conversation", "html"),
    html,
    "text/html;charset=utf-8",
  );
}
