import type { ReportDetail } from "@datachat/shared";
import { renderMermaidSvg } from "../components/markdown/mermaid-render";
import { captureRegisteredChart } from "./chart-export-registry";

export { buildReportExportDocx } from "./report-docx";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Build a clean Markdown document for downloading a saved report. */
export function buildReportExportMarkdown(report: Pick<ReportDetail, "title" | "markdown">): string {
  const title = report.title.trim() || "分析报告";
  const body = report.markdown.trim();
  const hasTopHeading = /^#\s+/.test(body);
  return hasTopHeading ? `${body}\n` : `# ${title}\n\n${body}\n`;
}

const STANDALONE_HTML_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 20px 64px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.7;
  color: #18181b;
  background: #fafafa;
}
article {
  max-width: 860px;
  margin: 0 auto;
  padding: 36px 40px;
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 12px;
}
header { border-bottom: 1px solid #e4e4e7; padding-bottom: 16px; margin-bottom: 24px; }
h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.3; }
h2 { margin: 24px 0 10px; font-size: 18px; line-height: 1.4; }
h3 { margin: 18px 0 8px; font-size: 15px; line-height: 1.4; }
p { margin: 8px 0; }
ul, ol { margin: 8px 0; padding-left: 22px; }
blockquote {
  margin: 12px 0;
  padding: 8px 14px;
  border-left: 3px solid #d4d4d8;
  color: #52525b;
  background: #f4f4f5;
  border-radius: 0 6px 6px 0;
}
pre {
  margin: 12px 0;
  padding: 12px 14px;
  overflow-x: auto;
  background: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
  font-size: 12px;
}
th, td {
  border: 1px solid #e4e4e7;
  padding: 6px 10px;
  text-align: left;
}
th { background: #f4f4f5; font-weight: 600; }
img { max-width: 100%; height: auto; display: block; margin: 8px auto; }
svg { max-width: 100%; height: auto; }
.report-artifact { margin: 16px 0; }
.report-table-footer { font-size: 12px; color: #71717a; margin-top: 6px; }
@media print {
  body { padding: 0; background: #ffffff; }
  article { border: none; padding: 0; }
}
`;

/**
 * Re-render rendered Mermaid diagrams in light theme so dark-mode HTML exports
 * stay crisp on the exported white paper layout.
 */
export async function collectLightMermaidSvgs(
  articleElement: HTMLElement,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const figures = articleElement.querySelectorAll("figure[data-mermaid-source]");
  for (const figure of figures) {
    const source = figure.getAttribute("data-mermaid-source")?.trim();
    if (!source || result.has(source)) continue;
    const hasRenderedSvg = Array.from(figure.querySelectorAll("svg")).some(
      (svg) => !svg.closest("button") && !svg.hasAttribute("aria-hidden"),
    );
    if (!hasRenderedSvg) continue;
    try {
      const svg = await renderMermaidSvg(source, { dark: false });
      result.set(source, svg);
    } catch {
      // Keep original rendered SVG if light re-rendering fails.
    }
  }
  return result;
}

/**
 * Clone a rendered report or section container, rasterizing live `<canvas>`
 * ECharts nodes into inline PNG images, applying light-theme Mermaid SVGs
 * when provided, and removing interactive UI buttons.
 */
export function serializeArticleForHtml(
  articleElement: HTMLElement,
  options?: { mermaidLightSvgs?: ReadonlyMap<string, string> },
): HTMLElement {
  const clone = articleElement.cloneNode(true) as HTMLElement;

  const liveCanvases = articleElement.querySelectorAll("canvas");
  const clonedCanvases = clone.querySelectorAll("canvas");
  liveCanvases.forEach((liveCanvas, index) => {
    const clonedCanvas = clonedCanvases[index];
    if (!clonedCanvas) return;
    try {
      const registered = captureRegisteredChart(liveCanvas.closest("[role='img']") ?? liveCanvas);
      const dataUrl = registered?.dataUrl ?? liveCanvas.toDataURL("image/png");
      if (dataUrl && dataUrl !== "data:,") {
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = "图表";
        clonedCanvas.replaceWith(img);
        return;
      }
    } catch {
      // Fall through if canvas cannot be serialized in restricted environments.
    }
    clonedCanvas.remove();
  });

  if (options?.mermaidLightSvgs && options.mermaidLightSvgs.size > 0) {
    clone.querySelectorAll("figure[data-mermaid-source]").forEach((figure) => {
      const source = figure.getAttribute("data-mermaid-source")?.trim();
      if (!source) return;
      const lightSvg = options.mermaidLightSvgs?.get(source);
      if (!lightSvg) return;
      const diagramSvg = Array.from(figure.querySelectorAll("svg")).find(
        (svg) => !svg.closest("button") && !svg.hasAttribute("aria-hidden"),
      );
      if (!diagramSvg) return;
      const wrapper = document.createElement("div");
      wrapper.innerHTML = lightSvg;
      const replacement = wrapper.querySelector("svg");
      if (replacement) {
        diagramSvg.replaceWith(replacement);
      }
    });
  }

  // Remove interactive toolbar controls (chart switchers, fullscreen/download buttons).
  clone.querySelectorAll("button, [role='group']").forEach((el) => el.remove());

  return clone;
}

/**
 * Snapshot the rendered report article DOM into a self-contained HTML file.
 * Live ECharts `<canvas>` nodes are rasterized to inline PNG images and
 * interactive toolbar buttons are stripped so the file opens cleanly offline.
 */
export function buildReportExportHtml(
  title: string,
  articleElement: HTMLElement,
  options?: { mermaidLightSvgs?: ReadonlyMap<string, string> },
): string {
  const clone = serializeArticleForHtml(articleElement, options);

  const safeTitle = escapeHtml(title.trim() || "分析报告");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle}</title>
<style>${STANDALONE_HTML_STYLES}</style>
</head>
<body>
${clone.outerHTML}
</body>
</html>
`;
}
