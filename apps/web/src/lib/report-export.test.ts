import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSvgCache } from "../components/markdown/mermaid-cache";
import { registerChartExporter } from "./chart-export-registry";
import {
  buildReportExportDocx,
  buildReportExportHtml,
  buildReportExportMarkdown,
  collectLightMermaidSvgs,
} from "./report-export";

const { mermaidInitializeMock, mermaidRenderMock } = vi.hoisted(() => ({
  mermaidInitializeMock: vi.fn(),
  mermaidRenderMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: (config: Record<string, unknown>) => mermaidInitializeMock(config),
    render: (id: string, text: string) => mermaidRenderMock(id, text),
  },
}));

const ONE_PIXEL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW0cAAAAASUVORK5CYII=";
const SECOND_PIXEL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPwd3sKAAJiAXvBJn9xAAAAAElFTkSuQmCC";

const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);
const originalToDataUrl = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "toDataURL",
);
const originalImage = Object.getOwnPropertyDescriptor(globalThis, "Image");

async function readBlobBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return await blob.arrayBuffer();
  }
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("Expected ArrayBuffer from FileReader"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsArrayBuffer(blob);
  });
}

function readZipEntries(buffer: ArrayBuffer): Map<string, Uint8Array> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("ZIP EOCD not found");

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let cursor = cdOffset;

  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory header");
    }
    const method = view.getUint16(cursor + 10, true);
    const compSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));

    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Invalid local header for ${name}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      entries.set(name, new Uint8Array(compressed));
    } else if (method === 8) {
      entries.set(name, new Uint8Array(inflateRawSync(compressed)));
    } else {
      throw new Error(`Unsupported ZIP method ${method} for ${name}`);
    }

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

describe("report-export", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    clearSvgCache();
    mermaidInitializeMock.mockReset();
    mermaidRenderMock.mockReset();
    if (originalGetContext) {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
    }
    if (originalToDataUrl) {
      Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", originalToDataUrl);
    }
    if (originalImage) {
      Object.defineProperty(globalThis, "Image", originalImage);
    }
    vi.restoreAllMocks();
  });

  it("prepends H1 title to markdown only when missing", () => {
    expect(
      buildReportExportMarkdown({ title: "周报", markdown: "## 概览\n\n内容" }),
    ).toBe("# 周报\n\n## 概览\n\n内容\n");

    expect(
      buildReportExportMarkdown({ title: "周报", markdown: "# 自定义标题\n\n内容" }),
    ).toBe("# 自定义标题\n\n内容\n");
  });

  it("exports standalone HTML with escaped title and stripped interactive buttons", () => {
    const article = document.createElement("article");
    article.innerHTML = `
      <header><h1>经营 &lt;Q4&gt; 复盘</h1></header>
      <div class="report-artifact">
        <div role="group"><button type="button">柱状图</button></div>
        <button type="button">全屏</button>
        <p>关键结论：增长 25%</p>
      </div>
    `;

    const html = buildReportExportHtml("经营 <Q4> 复盘", article);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>经营 &lt;Q4&gt; 复盘</title>");
    expect(html).toContain("关键结论：增长 25%");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("柱状图");
  });

  it("exports standard docx with headings, inline formatting, lists, tables, and safe links", async () => {
    const article = document.createElement("article");
    article.innerHTML = `
      <header>
        <h1>经营 Q4 复盘</h1>
        <p>生成时间：2026-11-25 15:00:00</p>
      </header>
      <div class="flex flex-col gap-4">
        <div class="markdown text-sm">
          <h2>核心结论</h2>
          <p>
            营收 <strong>同比增长</strong> <em>25%</em>，使用 <code>SUM(amount)</code> 计算，
            详情见 <a href="https://example.com/q4">Q4 明细</a> 或
            <a href="javascript:alert(1)">忽略危险链接</a>。
          </p>
          <ul>
            <li>紧致列表项</li>
            <li>
              <p>宽松列表项</p>
            </li>
          </ul>
          <ol>
            <li>第一步</li>
            <li>第二步</li>
          </ol>
          <blockquote><p>关键提示：华东区贡献最大。</p></blockquote>
          <pre><code>SELECT region, SUM(amount)
FROM orders;</code></pre>
          <table>
            <thead><tr><th>区域</th><th class="text-right">GMV</th></tr></thead>
            <tbody><tr><td>华东</td><td class="text-right">1200</td></tr></tbody>
          </table>
        </div>
        <div class="report-artifact">
          <div class="report-table-scroll">
            <table>
              <thead><tr><th>name</th><th class="text-right">amount</th></tr></thead>
              <tbody><tr><td>alice</td><td class="text-right">42</td></tr></tbody>
            </table>
          </div>
          <div class="report-table-footer">显示 1 / 1 行</div>
        </div>
      </div>
    `;

    const blob = await buildReportExportDocx("经营 Q4 复盘", article);
    const buffer = await readBlobBuffer(blob);
    const headerBytes = new Uint8Array(buffer.slice(0, 4));
    expect(Array.from(headerBytes)).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const entries = readZipEntries(buffer);
    const documentXml = new TextDecoder().decode(entries.get("word/document.xml"));
    const relsXml = new TextDecoder().decode(entries.get("word/_rels/document.xml.rels"));

    expect(documentXml).toContain("经营 Q4 复盘");
    expect(documentXml).toContain("生成时间：2026-11-25 15:00:00");
    expect(documentXml).toContain("核心结论");
    expect(documentXml).toContain("同比增长");
    expect(documentXml).toContain("SUM(amount)");
    expect(documentXml).toContain("Q4 明细");
    expect(relsXml).toContain("https://example.com/q4");
    expect(relsXml).not.toContain("javascript:");
    expect(documentXml).toContain("紧致列表项");
    expect(documentXml).toContain("宽松列表项");
    const numPrMatches = documentXml.match(/<w:numPr>/g) ?? [];
    expect(numPrMatches).toHaveLength(4);
    expect(documentXml).toContain("关键提示：华东区贡献最大。");
    expect(documentXml).toContain("SELECT region, SUM(amount)");
    expect(documentXml).toContain("显示 1 / 1 行");
    expect(documentXml).toContain('<w:jc w:val="right"/>');
  });

  it("preserves ChartTableView column headers while stripping interactive buttons", async () => {
    const article = document.createElement("article");
    article.innerHTML = `
      <header><h1>图表明细</h1></header>
      <div class="report-artifact">
        <div>
          <div>
            <span>区域趋势</span>
            <span>2 个数据点</span>
            <div role="group"><button type="button">柱状图</button></div>
            <button type="button">下载 PNG</button>
            <button type="button">全屏</button>
          </div>
          <div>
            <table>
              <thead>
                <tr>
                  <th><button type="button"><span>区域</span><svg aria-hidden="true"></svg></button></th>
                  <th class="text-right"><button type="button"><span>销售额</span><svg aria-hidden="true"></svg></button></th>
                </tr>
              </thead>
              <tbody>
                <tr><td>华北</td><td class="text-right">99</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    const blob = await buildReportExportDocx("图表明细", article);
    const entries = readZipEntries(await readBlobBuffer(blob));
    const documentXml = new TextDecoder().decode(entries.get("word/document.xml"));

    expect(documentXml).toContain("区域趋势（2 个数据点）");
    expect(documentXml).toContain("区域");
    expect(documentXml).toContain("销售额");
    expect(documentXml).toContain("华北");
    expect(documentXml).not.toContain("柱状图");
    expect(documentXml).not.toContain("下载 PNG");
    expect(documentXml).not.toContain("全屏");
  });

  it("embeds chart PNGs from registry and canvas fallback, falls back on Mermaid, and skips empty tables", async () => {
    const article = document.createElement("article");
    article.innerHTML = `
      <header><h1>图表与流程</h1></header>
      <div class="report-artifact">
        <div><span>注册图表</span><span>3 个数据点</span></div>
        <div role="img" aria-label="注册图表" class="registered-host"><canvas></canvas></div>
      </div>
      <div class="report-artifact">
        <div><span>画布回退图表</span></div>
        <div role="img" aria-label="画布回退图表"><canvas class="fallback-canvas"></canvas></div>
      </div>
      <figure data-mermaid-source="graph TD; A-->B" class="group/mermaid">
        <button type="button"><svg></svg>源码</button>
        <div><svg viewBox="0 0 200 100"><rect width="200" height="100" /></svg></div>
      </figure>
      <table></table>
    `;

    const registeredHost = article.querySelector(".registered-host")!;
    const unregister = registerChartExporter(registeredHost, () => ({
      dataUrl: ONE_PIXEL_PNG_DATA_URL,
      width: 600,
      height: 300,
    }));

    const fallbackCanvas = article.querySelector(".fallback-canvas") as HTMLCanvasElement;
    vi.spyOn(fallbackCanvas, "toDataURL").mockReturnValue(SECOND_PIXEL_PNG_DATA_URL);

    try {
      const blob = await buildReportExportDocx("图表与流程", article);
      const entries = readZipEntries(await readBlobBuffer(blob));
      const documentXml = new TextDecoder().decode(entries.get("word/document.xml"));

      const mediaKeys = Array.from(entries.keys()).filter((key) => key.startsWith("word/media/"));
      expect(mediaKeys.length).toBe(2);
      expect(mediaKeys.every((key) => key.endsWith(".png"))).toBe(true);
      expect(documentXml.match(/<w:drawing>/g) ?? []).toHaveLength(2);
      expect(documentXml).toContain("Mermaid 图表（源码）");
      expect(documentXml).toContain("graph TD; A--&gt;B");
      expect(documentXml).not.toContain("<w:tbl>");
    } finally {
      unregister();
    }
  });

  it("re-renders dark-mode Mermaid diagrams in light theme on a white background for Word export", async () => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.setProperty("--surface", "18 18 22");
    document.documentElement.style.setProperty("--ink", "245 245 246");

    mermaidRenderMock.mockResolvedValue({
      svg: '<svg viewBox="0 0 240 120" data-theme="light"><rect width="240" height="120" /></svg>',
    });

    const recordedFillStyles: string[] = [];
    const mockCtx = {
      fillStyle: "",
      fillRect: vi.fn(function (this: { fillStyle: string }) {
        recordedFillStyles.push(this.fillStyle);
      }),
      drawImage: vi.fn(),
    };

    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      writable: true,
      value: vi.fn(() => mockCtx),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      writable: true,
      value: vi.fn(() => ONE_PIXEL_PNG_DATA_URL),
    });

    class MockImage {
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private _src = "";
      set src(value: string) {
        this._src = value;
        queueMicrotask(() => this.onload?.(new Event("load")));
      }
      get src() {
        return this._src;
      }
    }
    Object.defineProperty(globalThis, "Image", {
      configurable: true,
      writable: true,
      value: MockImage,
    });

    const article = document.createElement("article");
    article.innerHTML = `
      <header><h1>暗色模式导出</h1></header>
      <figure data-mermaid-source="graph LR; Start-->Done" class="group/mermaid">
        <button type="button"><svg></svg>源码</button>
        <div><svg viewBox="0 0 240 120" data-theme="dark"><rect fill="#121216" /></svg></div>
      </figure>
    `;

    try {
      const blob = await buildReportExportDocx("暗色模式导出", article);
      const entries = readZipEntries(await readBlobBuffer(blob));
      const documentXml = new TextDecoder().decode(entries.get("word/document.xml"));

      expect(mermaidInitializeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          darkMode: false,
          theme: "base",
          themeVariables: expect.objectContaining({
            darkMode: false,
            background: "rgb(255, 255, 255)",
            primaryTextColor: "rgb(24, 24, 27)",
          }),
        }),
      );
      expect(mermaidRenderMock).toHaveBeenCalledWith(expect.any(String), "graph LR; Start-->Done");
      expect(recordedFillStyles).toContain("#ffffff");
      expect(recordedFillStyles).not.toContain("#121216");
      const mediaKeys = Array.from(entries.keys()).filter((key) => key.startsWith("word/media/"));
      expect(mediaKeys).toHaveLength(1);
      expect(documentXml).toContain("<w:drawing>");
      expect(documentXml).not.toContain("Mermaid 图表（源码）");
    } finally {
      document.documentElement.style.removeProperty("--surface");
      document.documentElement.style.removeProperty("--ink");
    }
  });

  it("exports light-theme ECharts and Mermaid SVGs when exporting HTML in dark mode", async () => {
    document.documentElement.classList.add("dark");
    mermaidRenderMock.mockResolvedValue({
      svg: '<svg viewBox="0 0 180 90" data-light-mermaid="true"><rect fill="#ffffff" /></svg>',
    });

    const article = document.createElement("article");
    article.innerHTML = `
      <header><h1>暗色 HTML 导出</h1></header>
      <div class="report-artifact">
        <div role="img" aria-label="亮色图表" class="echart-host"><canvas class="dark-canvas"></canvas></div>
      </div>
      <figure data-mermaid-source="flowchart TD; A-->B" class="group/mermaid">
        <button type="button"><svg></svg>源码</button>
        <div><svg viewBox="0 0 180 90" data-dark-mermaid="true"><rect fill="#121216" /></svg></div>
      </figure>
    `;

    const echartHost = article.querySelector(".echart-host")!;
    const unregister = registerChartExporter(echartHost, () => ({
      dataUrl: ONE_PIXEL_PNG_DATA_URL,
      width: 600,
      height: 300,
    }));

    const darkCanvas = article.querySelector(".dark-canvas") as HTMLCanvasElement;
    vi.spyOn(darkCanvas, "toDataURL").mockReturnValue(SECOND_PIXEL_PNG_DATA_URL);

    try {
      const mermaidLightSvgs = await collectLightMermaidSvgs(article);
      const html = buildReportExportHtml("暗色 HTML 导出", article, { mermaidLightSvgs });

      expect(html).toContain(ONE_PIXEL_PNG_DATA_URL);
      expect(html).not.toContain(SECOND_PIXEL_PNG_DATA_URL);
      expect(html).toContain('data-light-mermaid="true"');
      expect(html).not.toContain('data-dark-mermaid="true"');
      expect(html).not.toContain("<button");
    } finally {
      unregister();
    }
  });
});
