import { renderMermaidSvg } from "../components/markdown/mermaid-render";
import { captureRegisteredChart, type ChartExportSnapshot } from "./chart-export-registry";

type DocxModule = typeof import("docx");
type DocBlock = InstanceType<DocxModule["Paragraph"]> | InstanceType<DocxModule["Table"]>;
type InlineChild =
  | InstanceType<DocxModule["TextRun"]>
  | InstanceType<DocxModule["ImageRun"]>
  | InstanceType<DocxModule["ExternalHyperlink"]>;
type AlignmentValue =
  (typeof import("docx").AlignmentType)[keyof typeof import("docx").AlignmentType];
type HeadingValue =
  (typeof import("docx").HeadingLevel)[keyof typeof import("docx").HeadingLevel];

const COLOR_INK = "18181B";
const COLOR_INK_SOFT = "3F3F46";
const COLOR_MUTED = "71717A";
const COLOR_LINE = "E4E4E7";
const COLOR_LINE_STRONG = "D4D4D8";
const COLOR_SUBTLE = "F4F4F5";
const COLOR_ZEBRA = "FAFAFA";
const COLOR_QUOTE = "52525B";
const COLOR_LINK = "4338CA";

const BULLET_REF = "datachat-bullet";
const ORDERED_REF = "datachat-ordered";
const PAGE_A4_WIDTH = 11906;
const PAGE_A4_HEIGHT = 16838;
const PAGE_MARGIN_TWIPS = 1134; // ~20 mm
const IMAGE_MAX_WIDTH = 580;
const IMAGE_MAX_HEIGHT = 420;
const SVG_RASTER_TIMEOUT_MS = 3000;

interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: string;
  size?: number;
}

interface ParsedImageData {
  type: "png" | "jpg" | "gif";
  data: Uint8Array;
}

interface DocxBuildState {
  docx: DocxModule;
  orderedListInstance: number;
}

/** Decode a PNG/JPEG/GIF data URI into raw bytes without using Node Buffer. */
function parseDataUrlImage(dataUrl: string): ParsedImageData | null {
  const match = /^data:image\/(png|jpeg|jpg|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    dataUrl.trim(),
  );
  if (!match?.[1] || !match[2]) return null;
  const rawSubtype = match[1].toLowerCase();
  const type = rawSubtype === "jpeg" || rawSubtype === "jpg" ? "jpg" : (rawSubtype as "png" | "gif");
  const base64 = match[2].replace(/\s+/g, "");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.length > 0 ? { type, data: bytes } : null;
  } catch {
    return null;
  }
}

/** Scale an image to fit within printable Word page bounds while preserving aspect ratio. */
function fitImageDimensions(
  width: number,
  height: number,
  maxWidth = IMAGE_MAX_WIDTH,
  maxHeight = IMAGE_MAX_HEIGHT,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 520, height: 260 };
  }
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function safeExternalUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^(https?:|mailto:)/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}

function captureChartImage(chartContainer: Element): ChartExportSnapshot | null {
  const direct = captureRegisteredChart(chartContainer);
  if (direct) return direct;

  const imgHost = chartContainer.querySelector("[role='img']");
  if (imgHost) {
    const registered = captureRegisteredChart(imgHost);
    if (registered) return registered;
  }

  const canvas = chartContainer.querySelector("canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return null;

  const width = canvas.clientWidth || canvas.width || 640;
  const height = canvas.clientHeight || canvas.height || 260;

  try {
    const offscreen = document.createElement("canvas");
    offscreen.width = canvas.width || width;
    offscreen.height = canvas.height || height;
    const ctx = offscreen.getContext("2d");
    if (ctx && offscreen.width > 0 && offscreen.height > 0) {
      const dark = document.documentElement.classList.contains("dark");
      ctx.fillStyle = dark ? "#121216" : "#ffffff";
      ctx.fillRect(0, 0, offscreen.width, offscreen.height);
      ctx.drawImage(canvas, 0, 0, offscreen.width, offscreen.height);
      const composited = offscreen.toDataURL("image/png");
      if (composited && composited !== "data:,") {
        return { dataUrl: composited, width, height };
      }
    }
  } catch {
    // Fall back to direct canvas serialization below.
  }

  try {
    const directUrl = canvas.toDataURL("image/png");
    if (directUrl && directUrl !== "data:,") {
      return { dataUrl: directUrl, width, height };
    }
  } catch {
    return null;
  }

  return null;
}

function parseSvgNumericAttr(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.endsWith("%")) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveSvgDimensions(
  svgEl: SVGElement,
  fallback?: { width: number; height: number },
): { width: number; height: number } {
  const rect = svgEl.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }

  const attrWidth = parseSvgNumericAttr(svgEl.getAttribute("width"));
  const attrHeight = parseSvgNumericAttr(svgEl.getAttribute("height"));
  if (attrWidth && attrHeight) {
    return { width: Math.round(attrWidth), height: Math.round(attrHeight) };
  }

  const viewBox = svgEl.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map((part) => Number.parseFloat(part));
    const vbWidth = parts[2];
    const vbHeight = parts[3];
    if (
      vbWidth !== undefined &&
      vbHeight !== undefined &&
      Number.isFinite(vbWidth) &&
      Number.isFinite(vbHeight) &&
      vbWidth > 0 &&
      vbHeight > 0
    ) {
      return { width: Math.round(vbWidth), height: Math.round(vbHeight) };
    }
  }

  if (fallback && fallback.width > 0 && fallback.height > 0) {
    return fallback;
  }

  return { width: 640, height: 320 };
}

function canUseCanvas2d(): boolean {
  try {
    const probe = document.createElement("canvas");
    return typeof probe.getContext === "function" && probe.getContext("2d") !== null;
  } catch {
    return false;
  }
}

function resolveFigureBackground(figureEl: Element): string {
  const dark = document.documentElement.classList.contains("dark");
  if (!dark) return "#ffffff";
  const computedBg = window.getComputedStyle(figureEl).backgroundColor;
  if (computedBg && computedBg !== "rgba(0, 0, 0, 0)" && computedBg !== "transparent") {
    return computedBg;
  }
  return "#121216";
}

async function rasterizeSvgToPng(
  svgEl: SVGElement,
  figureEl: Element,
  options?: { whiteBackground?: boolean; fallbackSize?: { width: number; height: number } },
): Promise<ChartExportSnapshot | null> {
  if (!canUseCanvas2d() || typeof XMLSerializer === "undefined" || typeof Image === "undefined") {
    return null;
  }

  const { width, height } = resolveSvgDimensions(svgEl, options?.fallbackSize);
  let svgUrl: string;
  try {
    const clone = svgEl.cloneNode(true) as SVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    const xml = new XMLSerializer().serializeToString(clone);
    svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  } catch {
    return null;
  }

  return await new Promise<ChartExportSnapshot | null>((resolve) => {
    const img = new Image();
    let settled = false;

    const finish = (result: ChartExportSnapshot | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(result);
    };

    const timer = window.setTimeout(() => finish(null), SVG_RASTER_TIMEOUT_MS);

    img.onload = () => {
      try {
        const scale = 2;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.fillStyle = options?.whiteBackground ? "#ffffff" : resolveFigureBackground(figureEl);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/png");
        finish(dataUrl && dataUrl !== "data:," ? { dataUrl, width, height } : null);
      } catch {
        finish(null);
      }
    };

    img.onerror = () => finish(null);
    img.src = svgUrl;
  });
}

function makeTextRun(docx: DocxModule, text: string, style: InlineStyle) {
  return new docx.TextRun({
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    color: style.color,
    size: style.code ? (style.size ? Math.max(16, style.size - 2) : 19) : style.size,
    font: style.code ? "Consolas" : undefined,
    shading: style.code
      ? { type: docx.ShadingType.CLEAR, color: "auto", fill: COLOR_SUBTLE }
      : undefined,
    underline: style.underline
      ? { type: docx.UnderlineType.SINGLE, color: style.color ?? COLOR_LINK }
      : undefined,
  });
}

function collectInlineRuns(
  docx: DocxModule,
  node: Node,
  style: InlineStyle,
  inTableHeader: boolean,
  runs: InlineChild[],
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const raw = node.textContent ?? "";
    const normalized = style.code ? raw.replace(/\r?\n/g, " ") : raw.replace(/[\r\n\t ]+/g, " ");
    if (!normalized) return;
    if (normalized === " " && runs.length === 0) return;
    runs.push(makeTextRun(docx, normalized, style));
    return;
  }

  if (!(node instanceof Element)) return;
  const tag = node.tagName.toUpperCase();

  if (tag === "SVG" || tag === "INPUT" || node.getAttribute("role") === "group") {
    return;
  }
  if (tag === "BUTTON" && !inTableHeader) {
    return;
  }
  if (tag === "BR") {
    runs.push(new docx.TextRun({ text: "", break: 1 }));
    return;
  }
  if (tag === "IMG") {
    const parsed = parseDataUrlImage(node.getAttribute("src") ?? "");
    if (parsed) {
      const imgEl = node as HTMLImageElement;
      const widthAttr = parseSvgNumericAttr(node.getAttribute("width"));
      const heightAttr = parseSvgNumericAttr(node.getAttribute("height"));
      const dims = fitImageDimensions(
        imgEl.naturalWidth || imgEl.width || widthAttr || 480,
        imgEl.naturalHeight || imgEl.height || heightAttr || 260,
      );
      runs.push(
        new docx.ImageRun({
          type: parsed.type,
          data: parsed.data,
          transformation: dims,
        }),
      );
      return;
    }
    const alt = node.getAttribute("alt")?.trim();
    if (alt) {
      runs.push(makeTextRun(docx, alt, style));
    }
    return;
  }

  if (tag === "A") {
    const href = safeExternalUrl(node.getAttribute("href"));
    if (href) {
      const linkRuns: InlineChild[] = [];
      for (const child of node.childNodes) {
        collectInlineRuns(
          docx,
          child,
          { ...style, color: COLOR_LINK, underline: true },
          inTableHeader,
          linkRuns,
        );
      }
      if (linkRuns.length > 0) {
        runs.push(new docx.ExternalHyperlink({ link: href, children: linkRuns }));
      }
      return;
    }
  }

  let nextStyle = style;
  if (tag === "STRONG" || tag === "B") {
    nextStyle = { ...style, bold: true };
  } else if (tag === "EM" || tag === "I") {
    nextStyle = { ...style, italics: true };
  } else if (tag === "DEL" || tag === "S" || tag === "STRIKE") {
    nextStyle = { ...style, strike: true };
  } else if (tag === "CODE") {
    nextStyle = { ...style, code: true, color: COLOR_INK };
  }

  for (const child of node.childNodes) {
    collectInlineRuns(docx, child, nextStyle, inTableHeader, runs);
  }
}

function collectRunsFromNodes(
  docx: DocxModule,
  nodes: Iterable<Node>,
  style: InlineStyle = {},
  inTableHeader = false,
): InlineChild[] {
  const runs: InlineChild[] = [];
  for (const node of nodes) {
    collectInlineRuns(docx, node, style, inTableHeader, runs);
  }
  return runs;
}

function buildCodeBlockParagraph(docx: DocxModule, rawCode: string) {
  const normalized = rawCode.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const lines = normalized.length > 0 ? normalized.split("\n") : [""];
  const runs = lines.map(
    (line, index) =>
      new docx.TextRun({
        text: line,
        font: "Consolas",
        size: 18,
        color: COLOR_INK_SOFT,
        break: index > 0 ? 1 : undefined,
      }),
  );
  return new docx.Paragraph({
    children: runs,
    shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: COLOR_SUBTLE },
    border: {
      top: { style: docx.BorderStyle.SINGLE, size: 4, color: COLOR_LINE, space: 6 },
      bottom: { style: docx.BorderStyle.SINGLE, size: 4, color: COLOR_LINE, space: 6 },
      left: { style: docx.BorderStyle.SINGLE, size: 4, color: COLOR_LINE, space: 6 },
      right: { style: docx.BorderStyle.SINGLE, size: 4, color: COLOR_LINE, space: 6 },
    },
    spacing: { before: 100, after: 140, line: 276 },
  });
}

function buildImageParagraph(docx: DocxModule, snapshot: ChartExportSnapshot) {
  const parsed = parseDataUrlImage(snapshot.dataUrl);
  if (!parsed) return null;
  const transformation = fitImageDimensions(snapshot.width, snapshot.height);
  return new docx.Paragraph({
    alignment: docx.AlignmentType.CENTER,
    spacing: { before: 100, after: 140 },
    children: [
      new docx.ImageRun({
        type: parsed.type,
        data: parsed.data,
        transformation,
      }),
    ],
  });
}

function cellAlignment(docx: DocxModule, cell: HTMLTableCellElement): AlignmentValue {
  const inlineAlign = cell.style.textAlign || cell.getAttribute("align") || "";
  const lower = inlineAlign.toLowerCase();
  if (lower === "right" || cell.classList.contains("text-right")) {
    return docx.AlignmentType.RIGHT;
  }
  if (lower === "center" || cell.classList.contains("text-center")) {
    return docx.AlignmentType.CENTER;
  }
  return docx.AlignmentType.LEFT;
}

function collectTableRows(
  tableEl: HTMLTableElement,
): Array<{ row: HTMLTableRowElement; inHeader: boolean }> {
  const result: Array<{ row: HTMLTableRowElement; inHeader: boolean }> = [];
  for (const child of tableEl.children) {
    const tag = child.tagName.toUpperCase();
    if (tag === "THEAD" || tag === "TBODY" || tag === "TFOOT") {
      const inHeader = tag === "THEAD";
      for (const row of child.children) {
        if (row instanceof HTMLTableRowElement) {
          result.push({ row, inHeader });
        }
      }
    } else if (child instanceof HTMLTableRowElement) {
      result.push({ row: child, inHeader: false });
    }
  }
  return result;
}

function buildDocxTable(docx: DocxModule, tableEl: HTMLTableElement) {
  const collected = collectTableRows(tableEl);
  if (collected.length === 0) return null;

  const rows: InstanceType<DocxModule["TableRow"]>[] = [];
  let bodyRowIndex = 0;

  for (let rowIdx = 0; rowIdx < collected.length; rowIdx += 1) {
    const entry = collected[rowIdx];
    if (!entry) continue;
    const rawCells = Array.from(entry.row.children).filter(
      (cell): cell is HTMLTableCellElement =>
        cell.tagName.toUpperCase() === "TH" || cell.tagName.toUpperCase() === "TD",
    );
    if (rawCells.length === 0) continue;

    const allTh = rawCells.every((cell) => cell.tagName.toUpperCase() === "TH");
    const isHeaderRow = entry.inHeader || (rowIdx === 0 && allTh);
    const fill = isHeaderRow
      ? COLOR_SUBTLE
      : bodyRowIndex % 2 === 1
        ? COLOR_ZEBRA
        : "FFFFFF";
    if (!isHeaderRow) bodyRowIndex += 1;

    const cells = rawCells.map((cell) => {
      const isTh = cell.tagName.toUpperCase() === "TH";
      const runs = collectRunsFromNodes(
        docx,
        cell.childNodes,
        {
          bold: isTh || isHeaderRow ? true : undefined,
          size: 18,
          color: isTh || isHeaderRow ? COLOR_INK : COLOR_INK_SOFT,
        },
        isTh,
      );
      const paragraph = new docx.Paragraph({
        alignment: cellAlignment(docx, cell),
        spacing: { before: 20, after: 20, line: 260 },
        children: runs.length > 0 ? runs : [new docx.TextRun({ text: "", size: 18 })],
      });

      return new docx.TableCell({
        children: [paragraph],
        columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
        rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        shading: { type: docx.ShadingType.CLEAR, color: "auto", fill },
      });
    });

    rows.push(
      new docx.TableRow({
        children: cells,
        tableHeader: isHeaderRow ? true : undefined,
        cantSplit: true,
      }),
    );
  }

  if (rows.length === 0) return null;

  const border = { style: docx.BorderStyle.SINGLE, size: 4, color: COLOR_LINE };
  return new docx.Table({
    rows,
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
  });
}

function headingConfig(
  docx: DocxModule,
  level: number,
): { heading: HeadingValue; size: number } {
  switch (level) {
    case 1:
      return { heading: docx.HeadingLevel.HEADING_1, size: 32 };
    case 2:
      return { heading: docx.HeadingLevel.HEADING_2, size: 26 };
    case 3:
      return { heading: docx.HeadingLevel.HEADING_3, size: 23 };
    case 4:
      return { heading: docx.HeadingLevel.HEADING_4, size: 21 };
    case 5:
      return { heading: docx.HeadingLevel.HEADING_5, size: 20 };
    default:
      return { heading: docx.HeadingLevel.HEADING_6, size: 20 };
  }
}

function findDirectOrCardMeta(artifactEl: Element): { title: string | null; points: string | null } {
  const roleImg = artifactEl.querySelector("[role='img']");
  const ariaLabel = roleImg?.getAttribute("aria-label")?.trim();

  let title: string | null = ariaLabel && ariaLabel.length > 0 ? ariaLabel : null;
  let points: string | null = null;

  const spans = Array.from(artifactEl.querySelectorAll("span"));
  for (const span of spans) {
    if (
      span.closest("button") ||
      span.closest("[role='group']") ||
      span.closest("table") ||
      span.closest(".report-table-footer")
    ) {
      continue;
    }
    const text = span.textContent?.trim() ?? "";
    if (!text || text.startsWith("·")) continue;
    if (/^\d[\d,]*\s*个数据点$/.test(text)) {
      points ??= text;
      continue;
    }
    if (!title) {
      title = text;
    }
  }

  return { title, points };
}

function appendMutedParagraphsFromContainer(
  docx: DocxModule,
  container: Element,
  blocks: DocBlock[],
) {
  const paragraphs = Array.from(container.querySelectorAll("p"));
  if (paragraphs.length > 0) {
    for (const p of paragraphs) {
      const runs = collectRunsFromNodes(docx, p.childNodes, { size: 19, color: COLOR_MUTED });
      if (runs.length > 0) {
        blocks.push(new docx.Paragraph({ children: runs, spacing: { after: 80 } }));
      }
    }
    return;
  }

  const runs = collectRunsFromNodes(docx, container.childNodes, { size: 19, color: COLOR_MUTED });
  if (runs.length > 0) {
    blocks.push(new docx.Paragraph({ children: runs, spacing: { after: 100 } }));
  }
}

function appendArtifactBlock(
  docx: DocxModule,
  artifactEl: Element,
  blocks: DocBlock[],
): void {
  const tableEl = artifactEl.querySelector("table");
  const chartEl = artifactEl.querySelector("[role='img']") ?? artifactEl.querySelector("canvas");
  const { title, points } = findDirectOrCardMeta(artifactEl);

  if (tableEl instanceof HTMLTableElement) {
    if (title && !artifactEl.querySelector(".report-table-scroll")) {
      const label = points ? `${title}（${points}）` : title;
      blocks.push(
        new docx.Paragraph({
          keepNext: true,
          spacing: { before: 140, after: 80 },
          children: [new docx.TextRun({ text: label, bold: true, size: 20, color: COLOR_INK })],
        }),
      );
    }

    const docxTable = buildDocxTable(docx, tableEl);
    if (docxTable) {
      blocks.push(docxTable);
    }

    const footerEl = artifactEl.querySelector(".report-table-footer");
    const footerText = footerEl?.textContent?.trim();
    if (footerText) {
      blocks.push(
        new docx.Paragraph({
          spacing: { before: 60, after: 140 },
          children: [new docx.TextRun({ text: footerText, size: 18, color: COLOR_MUTED })],
        }),
      );
    }
    return;
  }

  if (chartEl) {
    if (title) {
      const label = points ? `${title}（${points}）` : title;
      blocks.push(
        new docx.Paragraph({
          keepNext: true,
          spacing: { before: 140, after: 60 },
          children: [new docx.TextRun({ text: label, bold: true, size: 20, color: COLOR_INK })],
        }),
      );
    }

    const snapshot = captureChartImage(artifactEl);
    const imgPara = snapshot ? buildImageParagraph(docx, snapshot) : null;
    if (imgPara) {
      blocks.push(imgPara);
    } else {
      blocks.push(
        new docx.Paragraph({
          spacing: { before: 60, after: 120 },
          children: [
            new docx.TextRun({
              text: "（图表未能导出为图片）",
              italics: true,
              size: 19,
              color: COLOR_MUTED,
            }),
          ],
        }),
      );
    }
    return;
  }

  appendMutedParagraphsFromContainer(docx, artifactEl, blocks);
}

async function appendMermaidFigure(
  docx: DocxModule,
  figureEl: Element,
  blocks: DocBlock[],
): Promise<void> {
  const source =
    figureEl.getAttribute("data-mermaid-source") ??
    figureEl.querySelector("pre")?.textContent ??
    "";
  const diagramSvg = Array.from(figureEl.querySelectorAll("svg")).find(
    (svg) => !svg.closest("button") && !svg.hasAttribute("aria-hidden"),
  );

  if (diagramSvg) {
    const liveSize = resolveSvgDimensions(diagramSvg);
    const dark = document.documentElement.classList.contains("dark");
    let svgToRasterize: SVGElement = diagramSvg;
    let whiteBackground = !dark;

    if (dark && source.trim()) {
      try {
        const lightSvg = await renderMermaidSvg(source, { dark: false });
        const wrapper = document.createElement("div");
        wrapper.innerHTML = lightSvg;
        const parsedSvg = wrapper.querySelector("svg");
        if (parsedSvg instanceof SVGElement) {
          svgToRasterize = parsedSvg;
          whiteBackground = true;
        }
      } catch {
        // Fall back to rasterizing the live SVG when light re-rendering fails.
      }
    }

    const snapshot = await rasterizeSvgToPng(svgToRasterize, figureEl, {
      whiteBackground,
      fallbackSize: liveSize,
    });
    const imgPara = snapshot ? buildImageParagraph(docx, snapshot) : null;
    if (imgPara) {
      blocks.push(imgPara);
      return;
    }
  }

  if (source.trim()) {
    blocks.push(
      new docx.Paragraph({
        keepNext: true,
        spacing: { before: 120, after: 40 },
        children: [
          new docx.TextRun({ text: "Mermaid 图表（源码）", size: 18, color: COLOR_MUTED }),
        ],
      }),
    );
    blocks.push(buildCodeBlockParagraph(docx, source));
  }
}

function findCheckboxPrefix(liEl: Element): string | null {
  const firstChild = liEl.firstElementChild;
  const directCheckbox =
    firstChild?.tagName.toUpperCase() === "INPUT" &&
    firstChild.getAttribute("type")?.toLowerCase() === "checkbox"
      ? (firstChild as HTMLInputElement)
      : null;
  if (directCheckbox) {
    return directCheckbox.checked ? "☑ " : "☐ ";
  }
  if (firstChild?.tagName.toUpperCase() === "P") {
    const nested = firstChild.firstElementChild;
    if (
      nested?.tagName.toUpperCase() === "INPUT" &&
      nested.getAttribute("type")?.toLowerCase() === "checkbox"
    ) {
      return (nested as HTMLInputElement).checked ? "☑ " : "☐ ";
    }
  }
  return null;
}

function appendList(
  state: DocxBuildState,
  listEl: Element,
  ordered: boolean,
  depth: number,
  instanceId: number,
  blocks: DocBlock[],
): void {
  const { docx } = state;
  const level = Math.min(depth, 4);
  const items = Array.from(listEl.children).filter((child) => child.tagName.toUpperCase() === "LI");

  for (const li of items) {
    const checkboxPrefix = findCheckboxPrefix(li);
    let emittedPrimary = false;
    let bufferedNodes: Node[] = [];

    const flushInlineNodes = () => {
      if (bufferedNodes.length === 0) return;
      const runs = collectRunsFromNodes(docx, bufferedNodes);
      bufferedNodes = [];
      if (runs.length === 0) return;

      if (!emittedPrimary && checkboxPrefix) {
        runs.unshift(new docx.TextRun({ text: checkboxPrefix }));
      }

      blocks.push(
        new docx.Paragraph({
          children: runs,
          numbering: !emittedPrimary
            ? {
                reference: ordered ? ORDERED_REF : BULLET_REF,
                level,
                ...(ordered ? { instance: instanceId } : {}),
              }
            : undefined,
          indent: emittedPrimary ? { left: 420 * (level + 1) } : undefined,
          spacing: { after: 60, line: 320 },
        }),
      );
      emittedPrimary = true;
    };

    for (const child of li.childNodes) {
      if (child instanceof Element) {
        const tag = child.tagName.toUpperCase();
        if (tag === "UL" || tag === "OL") {
          flushInlineNodes();
          const nestedOrdered = tag === "OL";
          const nestedInstance = nestedOrdered ? ++state.orderedListInstance : 0;
          appendList(state, child, nestedOrdered, depth + 1, nestedInstance, blocks);
          continue;
        }
        if (tag === "P") {
          flushInlineNodes();
          const runs = collectRunsFromNodes(docx, child.childNodes);
          if (!emittedPrimary && checkboxPrefix) {
            runs.unshift(new docx.TextRun({ text: checkboxPrefix }));
          }
          if (runs.length > 0) {
            blocks.push(
              new docx.Paragraph({
                children: runs,
                numbering: !emittedPrimary
                  ? {
                      reference: ordered ? ORDERED_REF : BULLET_REF,
                      level,
                      ...(ordered ? { instance: instanceId } : {}),
                    }
                  : undefined,
                indent: emittedPrimary ? { left: 420 * (level + 1) } : undefined,
                spacing: { after: 60, line: 320 },
              }),
            );
            emittedPrimary = true;
          }
          continue;
        }
        if (tag === "PRE") {
          flushInlineNodes();
          blocks.push(buildCodeBlockParagraph(docx, child.textContent ?? ""));
          continue;
        }
      }
      bufferedNodes.push(child);
    }

    flushInlineNodes();

    if (!emittedPrimary && checkboxPrefix) {
      blocks.push(
        new docx.Paragraph({
          children: [new docx.TextRun({ text: checkboxPrefix })],
          numbering: {
            reference: ordered ? ORDERED_REF : BULLET_REF,
            level,
            ...(ordered ? { instance: instanceId } : {}),
          },
          spacing: { after: 60, line: 320 },
        }),
      );
    }
  }
}

function appendBlockquote(docx: DocxModule, quoteEl: Element, blocks: DocBlock[]): void {
  const quoteStyle = {
    indent: { left: 360 },
    border: {
      left: { style: docx.BorderStyle.SINGLE, size: 18, color: COLOR_LINE_STRONG, space: 10 },
    },
    shading: { type: docx.ShadingType.CLEAR, color: "auto", fill: COLOR_SUBTLE },
  };

  let emitted = false;
  for (const child of quoteEl.children) {
    const tag = child.tagName.toUpperCase();
    if (tag === "P" || /^H[1-6]$/.test(tag)) {
      const runs = collectRunsFromNodes(docx, child.childNodes, { color: COLOR_QUOTE });
      if (runs.length > 0) {
        blocks.push(
          new docx.Paragraph({
            ...quoteStyle,
            children: runs,
            spacing: { before: 80, after: 100, line: 320 },
          }),
        );
        emitted = true;
      }
    }
  }

  if (!emitted) {
    const runs = collectRunsFromNodes(docx, quoteEl.childNodes, { color: COLOR_QUOTE });
    if (runs.length > 0) {
      blocks.push(
        new docx.Paragraph({
          ...quoteStyle,
          children: runs,
          spacing: { before: 80, after: 100, line: 320 },
        }),
      );
    }
  }
}

function appendHeader(docx: DocxModule, headerEl: Element, fallbackTitle: string, blocks: DocBlock[]) {
  const h1 = headerEl.querySelector("h1");
  const titleText = h1?.textContent?.trim() || fallbackTitle.trim() || "分析报告";
  blocks.push(
    new docx.Paragraph({
      heading: docx.HeadingLevel.TITLE,
      spacing: { after: 80 },
      children: [new docx.TextRun({ text: titleText, bold: true, size: 36, color: COLOR_INK })],
    }),
  );

  const metaParagraphs = Array.from(headerEl.querySelectorAll("p"));
  if (metaParagraphs.length > 0) {
    metaParagraphs.forEach((meta, idx) => {
      const text = meta.textContent?.trim();
      if (!text) return;
      const isLast = idx === metaParagraphs.length - 1;
      blocks.push(
        new docx.Paragraph({
          spacing: { after: isLast ? 220 : 60 },
          border: isLast
            ? { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: COLOR_LINE, space: 10 } }
            : undefined,
          children: [new docx.TextRun({ text, size: 19, color: COLOR_MUTED })],
        }),
      );
    });
  } else {
    blocks.push(
      new docx.Paragraph({
        spacing: { after: 220 },
        border: {
          bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: COLOR_LINE, space: 10 },
        },
        children: [],
      }),
    );
  }
}

async function appendElementBlocks(
  state: DocxBuildState,
  element: Element,
  fallbackTitle: string,
  blocks: DocBlock[],
): Promise<void> {
  const { docx } = state;
  const tag = element.tagName.toUpperCase();

  if (tag === "BUTTON" || element.getAttribute("role") === "group") {
    return;
  }

  if (tag === "HEADER") {
    appendHeader(docx, element, fallbackTitle, blocks);
    return;
  }

  if (element.classList.contains("report-artifact")) {
    appendArtifactBlock(docx, element, blocks);
    return;
  }

  if (
    tag === "FIGURE" &&
    (element.hasAttribute("data-mermaid-source") ||
      element.classList.contains("group/mermaid") ||
      element.querySelector("svg"))
  ) {
    await appendMermaidFigure(docx, element, blocks);
    return;
  }

  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const { heading, size } = headingConfig(docx, level);
    const runs = collectRunsFromNodes(docx, element.childNodes, {
      bold: true,
      size,
      color: COLOR_INK,
    });
    if (runs.length > 0) {
      blocks.push(
        new docx.Paragraph({
          heading,
          keepNext: true,
          spacing: { before: 220, after: 100 },
          children: runs,
        }),
      );
    }
    return;
  }

  if (tag === "P") {
    const runs = collectRunsFromNodes(docx, element.childNodes);
    if (runs.length > 0) {
      blocks.push(
        new docx.Paragraph({
          children: runs,
          spacing: { after: 120, line: 340 },
        }),
      );
    }
    return;
  }

  if (tag === "UL" || tag === "OL") {
    const ordered = tag === "OL";
    const instanceId = ordered ? ++state.orderedListInstance : 0;
    appendList(state, element, ordered, 0, instanceId, blocks);
    return;
  }

  if (tag === "BLOCKQUOTE") {
    appendBlockquote(docx, element, blocks);
    return;
  }

  if (tag === "PRE") {
    blocks.push(buildCodeBlockParagraph(docx, element.textContent ?? ""));
    return;
  }

  if (tag === "HR") {
    blocks.push(
      new docx.Paragraph({
        spacing: { before: 120, after: 120 },
        border: {
          bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: COLOR_LINE, space: 1 },
        },
        children: [],
      }),
    );
    return;
  }

  if (tag === "TABLE" && element instanceof HTMLTableElement) {
    const table = buildDocxTable(docx, element);
    if (table) {
      blocks.push(table);
      blocks.push(new docx.Paragraph({ spacing: { after: 80 }, children: [] }));
    }
    return;
  }

  if (tag === "IMG") {
    const runs = collectRunsFromNodes(docx, [element]);
    if (runs.length > 0) {
      blocks.push(
        new docx.Paragraph({
          alignment: docx.AlignmentType.CENTER,
          spacing: { before: 100, after: 140 },
          children: runs,
        }),
      );
    }
    return;
  }

  for (const child of element.children) {
    await appendElementBlocks(state, child, fallbackTitle, blocks);
  }
}

function buildNumberingConfig(docx: DocxModule) {
  const bulletSymbols = ["•", "◦", "▪", "•", "◦"];
  return {
    config: [
      {
        reference: BULLET_REF,
        levels: bulletSymbols.map((symbol, level) => ({
          level,
          format: docx.LevelFormat.BULLET,
          text: symbol,
          alignment: docx.AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: 420 * (level + 1), hanging: 240 },
            },
          },
        })),
      },
      {
        reference: ORDERED_REF,
        levels: [0, 1, 2, 3, 4].map((level) => ({
          level,
          format: docx.LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: docx.AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: 420 * (level + 1), hanging: 240 },
            },
          },
        })),
      },
    ],
  };
}

/**
 * Snapshot the rendered report article DOM into a standard `.docx` Word document.
 * Dynamically imports `docx` on demand so the main bundle stays unaffected.
 */
export async function buildReportExportDocx(
  title: string,
  articleElement: HTMLElement,
): Promise<Blob> {
  const docx = await import("docx");
  const safeTitle = title.trim() || "分析报告";
  const blocks: DocBlock[] = [];
  const state: DocxBuildState = { docx, orderedListInstance: 0 };

  if (!articleElement.querySelector("header")) {
    blocks.push(
      new docx.Paragraph({
        heading: docx.HeadingLevel.TITLE,
        spacing: { after: 180 },
        border: {
          bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: COLOR_LINE, space: 10 },
        },
        children: [new docx.TextRun({ text: safeTitle, bold: true, size: 36, color: COLOR_INK })],
      }),
    );
  }

  for (const child of articleElement.children) {
    await appendElementBlocks(state, child, safeTitle, blocks);
  }

  if (blocks.length === 0) {
    blocks.push(new docx.Paragraph({ children: [new docx.TextRun({ text: safeTitle })] }));
  }

  const doc = new docx.Document({
    title: safeTitle,
    creator: "DataChat",
    numbering: buildNumberingConfig(docx),
    styles: {
      default: {
        document: {
          run: {
            size: 21,
            color: COLOR_INK,
            font: {
              ascii: "Calibri",
              hAnsi: "Calibri",
              eastAsia: "Microsoft YaHei",
              cs: "Calibri",
            },
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: PAGE_A4_WIDTH,
              height: PAGE_A4_HEIGHT,
            },
            margin: {
              top: PAGE_MARGIN_TWIPS,
              right: PAGE_MARGIN_TWIPS,
              bottom: PAGE_MARGIN_TWIPS,
              left: PAGE_MARGIN_TWIPS,
            },
          },
        },
        footers: {
          default: new docx.Footer({
            children: [
              new docx.Paragraph({
                alignment: docx.AlignmentType.CENTER,
                children: [
                  new docx.TextRun({ text: "第 ", size: 18, color: COLOR_MUTED }),
                  new docx.TextRun({
                    children: [docx.PageNumber.CURRENT],
                    size: 18,
                    color: COLOR_MUTED,
                  }),
                  new docx.TextRun({ text: " 页 / 共 ", size: 18, color: COLOR_MUTED }),
                  new docx.TextRun({
                    children: [docx.PageNumber.TOTAL_PAGES],
                    size: 18,
                    color: COLOR_MUTED,
                  }),
                  new docx.TextRun({ text: " 页", size: 18, color: COLOR_MUTED }),
                ],
              }),
            ],
          }),
        },
        children: blocks,
      },
    ],
  });

  return await docx.Packer.toBlob(doc);
}
