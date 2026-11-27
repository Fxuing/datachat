import type { Column, ReportDetail } from "@datachat/shared";
import { renderMermaidSvg } from "../components/markdown/mermaid-render";
import {
  getArtifact,
  getArtifactRows,
  getReport,
  type ArtifactDetail,
} from "./api";
import { registerChartExporter } from "./chart-export-registry";
import {
  downloadBlobFile,
  downloadTextFile,
  sanitizeFileName,
} from "./conversation-export";
import { parseReportMarkdown } from "./report-markdown";
import {
  buildReportExportDocx,
  buildReportExportHtml,
  buildReportExportMarkdown,
} from "./report-export";
import { formatCount } from "./utils";

export type ReportExportFormat = "md" | "html" | "docx";

export const CHART_EXPORT_WIDTH = 720;
export const CHART_EXPORT_HEIGHT = 340;

function formatReportTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function formatTableCell(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function buildMissingArtifactElement(artifactId: string, message: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "report-artifact";

  const msg = document.createElement("p");
  msg.textContent = message;
  const idEl = document.createElement("p");
  idEl.textContent = `artifact: ${artifactId}`;
  wrapper.append(msg, idEl);
  return wrapper;
}

export function buildTableArtifactElement(
  columns: Column[],
  rows: unknown[][],
  rowCount: number,
): HTMLElement {
  const outer = document.createElement("div");
  outer.className = "report-artifact";

  const scroll = document.createElement("div");
  scroll.className = "report-table-scroll";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.className = column.type === "number" ? "text-right" : "text-left";
    th.textContent = column.name;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);

  const tbody = document.createElement("tbody");
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = Math.max(columns.length, 1);
    td.textContent = "查询结果为空";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const row of rows) {
      const tr = document.createElement("tr");
      columns.forEach((column, columnIndex) => {
        const td = document.createElement("td");
        td.className = column.type === "number" ? "text-right" : "text-left";
        td.textContent = formatTableCell(row[columnIndex]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  table.append(thead, tbody);
  scroll.appendChild(table);

  const footer = document.createElement("div");
  footer.className = "report-table-footer";
  footer.textContent = `显示 ${rows.length} / ${formatCount(rowCount)} 行${
    rowCount > rows.length ? "（仅展示前 100 行）" : ""
  }`;

  outer.append(scroll, footer);
  return outer;
}

export async function renderMarkdownSection(content: string): Promise<HTMLElement> {
  const [{ createElement }, { renderToStaticMarkup }, { default: ReactMarkdown }, { default: remarkGfm }, { default: rehypeHighlight }] =
    await Promise.all([
      import("react"),
      import("react-dom/server"),
      import("react-markdown"),
      import("remark-gfm"),
      import("rehype-highlight"),
    ]);

  const markup = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [[rehypeHighlight, { ignoreMissing: true }]],
      },
      content,
    ),
  );

  const container = document.createElement("div");
  container.className = "markdown";
  container.innerHTML = markup;

  const preNodes = Array.from(container.querySelectorAll("pre"));
  for (const pre of preNodes) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const classes = (code.getAttribute("class") ?? "").split(/\s+/);
    if (!classes.includes("language-mermaid")) continue;

    const source = code.textContent?.trim() ?? "";
    if (!source) continue;

    try {
      const svg = await renderMermaidSvg(source, { dark: false });
      const figure = document.createElement("figure");
      figure.setAttribute("data-mermaid-source", source);
      figure.innerHTML = svg;
      pre.replaceWith(figure);
    } catch {
      // Keep code block fallback when Mermaid rendering fails.
    }
  }

  return container;
}

/**
 * Assemble an offscreen `<article>` matching ReportPage's semantic DOM structure
 * so `buildReportExportHtml` and `buildReportExportDocx` produce identical files
 * directly from chat without navigating away.
 */
export async function buildOffscreenReportArticle(
  report: ReportDetail,
): Promise<{ article: HTMLElement; cleanup: () => void }> {
  const cleanups: Array<() => void> = [];
  const listedIds = new Set(report.artifactIds);
  const segments = parseReportMarkdown(report.markdown);

  const neededIds = Array.from(
    new Set(
      segments
        .filter(
          (segment): segment is { type: "artifact" | "chart"; artifactId: string } =>
            segment.type === "artifact" || segment.type === "chart",
        )
        .map((segment) => segment.artifactId)
        .filter((id) => listedIds.has(id)),
    ),
  );

  const artifactMap = new Map<string, ArtifactDetail>();
  if (neededIds.length > 0) {
    const settled = await Promise.allSettled(neededIds.map((id) => getArtifact(id)));
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        artifactMap.set(neededIds[index]!, result.value);
      }
    });
  }

  const resultIds = neededIds.filter((id) => artifactMap.get(id)?.kind === "result");
  const rowsMap = new Map<string, { rows: unknown[][] }>();
  if (resultIds.length > 0) {
    const settledRows = await Promise.allSettled(
      resultIds.map((id) => getArtifactRows(id, { limit: 100 })),
    );
    settledRows.forEach((result, index) => {
      if (result.status === "fulfilled") {
        rowsMap.set(resultIds[index]!, { rows: result.value.rows.slice(0, 100) });
      }
    });
  }

  const needsChartRenderer = Array.from(artifactMap.values()).some(
    (artifact) => artifact.kind === "chart",
  );
  const chartModules = needsChartRenderer
    ? await Promise.all([
        import("../components/chat/ChartCard"),
        import("../components/chat/EChart"),
      ])
    : null;

  const article = document.createElement("article");
  const header = document.createElement("header");
  const h1 = document.createElement("h1");
  h1.textContent = report.title.trim() || "分析报告";
  const meta = document.createElement("p");
  meta.textContent = `创建时间：${formatReportTimestamp(report.createdAt)}${
    report.updatedAt > report.createdAt
      ? ` · 更新于 ${formatReportTimestamp(report.updatedAt)}`
      : ""
  }`;
  header.append(h1, meta);
  article.appendChild(header);

  for (const segment of segments) {
    if (segment.type === "markdown") {
      if (!segment.content.trim()) continue;
      article.appendChild(await renderMarkdownSection(segment.content));
      continue;
    }

    const artifactId = segment.artifactId;
    if (!listedIds.has(artifactId)) {
      article.appendChild(
        buildMissingArtifactElement(artifactId, "结果不可用，可能已被删除。"),
      );
      continue;
    }

    const artifact = artifactMap.get(artifactId);
    if (!artifact) {
      article.appendChild(buildMissingArtifactElement(artifactId, "结果加载失败。"));
      continue;
    }

    if (artifact.kind === "excel") {
      article.appendChild(
        buildMissingArtifactElement(artifactId, "报告不支持内嵌 Excel 文件。"),
      );
      continue;
    }

    if (artifact.kind === "chart" && chartModules) {
      const [{ chartTitleFromSpec, chartOptionFromSpec }, { renderChartOptionToPng }] =
        chartModules;
      const title = chartTitleFromSpec(artifact.spec);
      const option = chartOptionFromSpec(artifact.spec);
      const snapshot = renderChartOptionToPng(option, {
        width: CHART_EXPORT_WIDTH,
        height: CHART_EXPORT_HEIGHT,
      });

      const wrapper = document.createElement("div");
      wrapper.className = "report-artifact";

      const metaBar = document.createElement("div");
      const titleSpan = document.createElement("span");
      titleSpan.textContent = title;
      metaBar.appendChild(titleSpan);
      if (artifact.rowCount > 0) {
        const pointsSpan = document.createElement("span");
        pointsSpan.textContent = `${formatCount(artifact.rowCount)} 个数据点`;
        metaBar.appendChild(pointsSpan);
      }

      const imgHost = document.createElement("div");
      imgHost.setAttribute("role", "img");
      imgHost.setAttribute("aria-label", title);
      const canvas = document.createElement("canvas");
      canvas.width = CHART_EXPORT_WIDTH;
      canvas.height = CHART_EXPORT_HEIGHT;
      imgHost.appendChild(canvas);

      if (snapshot) {
        cleanups.push(registerChartExporter(imgHost, () => snapshot));
      }

      wrapper.append(metaBar, imgHost);
      article.appendChild(wrapper);
      continue;
    }

    const loadedRows = rowsMap.get(artifactId);
    if (!loadedRows) {
      article.appendChild(buildMissingArtifactElement(artifactId, "结果加载失败。"));
      continue;
    }
    article.appendChild(
      buildTableArtifactElement(artifact.columns, loadedRows.rows, artifact.rowCount),
    );
  }

  return {
    article,
    cleanup: () => {
      for (const fn of cleanups) {
        fn();
      }
    },
  };
}

/**
 * Fetch a report and trigger an immediate download in `.docx`, `.html`, or `.md`
 * directly from chat.
 */
export async function exportReportById(
  reportId: string,
  format: ReportExportFormat,
): Promise<{ title: string }> {
  const { report } = await getReport(reportId);
  if (format === "md") {
    const markdown = buildReportExportMarkdown(report);
    downloadTextFile(
      sanitizeFileName(report.title, "datachat-report", "md"),
      markdown,
      "text/markdown;charset=utf-8",
    );
    return { title: report.title };
  }

  const { article, cleanup } = await buildOffscreenReportArticle(report);
  try {
    if (format === "html") {
      const html = buildReportExportHtml(report.title, article);
      downloadTextFile(
        sanitizeFileName(report.title, "datachat-report", "html"),
        html,
        "text/html;charset=utf-8",
      );
      return { title: report.title };
    }

    const blob = await buildReportExportDocx(report.title, article);
    downloadBlobFile(sanitizeFileName(report.title, "datachat-report", "docx"), blob);
    return { title: report.title };
  } finally {
    cleanup();
  }
}
