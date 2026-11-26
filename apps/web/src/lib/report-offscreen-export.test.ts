import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSvgCache } from "../components/markdown/mermaid-cache";
import { captureRegisteredChart } from "./chart-export-registry";

const ONE_PIXEL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW0cAAAAASUVORK5CYII=";

const mocks = vi.hoisted(() => ({
  getReport: vi.fn(),
  getArtifact: vi.fn(),
  getArtifactRows: vi.fn(),
  downloadBlobFile: vi.fn(),
  downloadTextFile: vi.fn(),
  renderMermaidSvg: vi.fn(),
  renderChartOptionToPng: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    getReport: mocks.getReport,
    getArtifact: mocks.getArtifact,
    getArtifactRows: mocks.getArtifactRows,
  };
});

vi.mock("./conversation-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./conversation-export")>();
  return {
    ...actual,
    downloadBlobFile: mocks.downloadBlobFile,
    downloadTextFile: mocks.downloadTextFile,
  };
});

vi.mock("../components/markdown/mermaid-render", () => ({
  renderMermaidSvg: mocks.renderMermaidSvg,
}));

vi.mock("../components/chat/EChart", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/chat/EChart")>();
  return {
    ...actual,
    renderChartOptionToPng: mocks.renderChartOptionToPng,
  };
});

import { buildOffscreenReportArticle, exportReportById } from "./report-offscreen-export";
import type { ReportDetail } from "@datachat/shared";

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
    const method = view.getUint16(cursor + 10, true);
    const compSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    const payload = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    entries.set(name, payload);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe("report-offscreen-export", () => {
  const sampleReport: ReportDetail = {
    id: "rep-1",
    conversationId: "conv-1",
    title: "2026年7月退款分析报告",
    artifactIds: ["res-1", "chart-1"],
    markdown: [
      "## 核心结论",
      "",
      "本月共 **29** 笔退款。",
      "",
      "[[artifact:res-1]]",
      "",
      "[[chart:chart-1]]",
      "",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
    ].join("\n"),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  beforeEach(() => {
    clearSvgCache();
    mocks.getReport.mockReset();
    mocks.getArtifact.mockReset();
    mocks.getArtifactRows.mockReset();
    mocks.downloadBlobFile.mockReset();
    mocks.downloadTextFile.mockReset();
    mocks.renderMermaidSvg.mockReset();
    mocks.renderChartOptionToPng.mockReset();

    mocks.getReport.mockResolvedValue({ report: sampleReport });
    mocks.getArtifact.mockImplementation(async (id: string) => {
      if (id === "res-1") {
        return {
          id: "res-1",
          kind: "result",
          conversationId: "conv-1",
          rowCount: 2,
          truncated: false,
          columns: [
            { name: "渠道", type: "string" },
            { name: "退款单数", type: "number" },
          ],
          createdAt: 1,
          spec: null,
        };
      }
      return {
        id: "chart-1",
        kind: "chart",
        conversationId: "conv-1",
        rowCount: 2,
        truncated: false,
        columns: [],
        createdAt: 2,
        spec: {
          chart: { title: "各渠道退款对比" },
          option: { series: [{ type: "bar", data: [15, 10] }] },
        },
      };
    });
    mocks.getArtifactRows.mockResolvedValue({
      columns: [
        { name: "渠道", type: "string" },
        { name: "退款单数", type: "number" },
      ],
      rows: [
        ["微信小程序", 15],
        ["App", 10],
      ],
      total: 2,
    });
    mocks.renderMermaidSvg.mockResolvedValue(
      '<svg width="200" height="80" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
    );
    mocks.renderChartOptionToPng.mockReturnValue({
      dataUrl: ONE_PIXEL_PNG_DATA_URL,
      width: 720,
      height: 340,
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("builds an offscreen article with light-theme mermaid/chart snapshots and cleans up exporters", async () => {
    const { article, cleanup } = await buildOffscreenReportArticle(sampleReport);
    try {
      expect(article.querySelector("header h1")?.textContent).toBe("2026年7月退款分析报告");
      expect(article.querySelector("table")?.textContent).toContain("微信小程序");
      expect(article.querySelector(".report-table-footer")?.textContent).toContain("显示 2 / 2 行");

      expect(mocks.renderMermaidSvg).toHaveBeenCalledWith("flowchart LR\n  A --> B", {
        dark: false,
      });
      const figure = article.querySelector("figure[data-mermaid-source]");
      expect(figure?.querySelector("svg")).not.toBeNull();

      const chartHost = article.querySelector("[role='img']");
      expect(chartHost?.getAttribute("aria-label")).toBe("各渠道退款对比");
      expect(captureRegisteredChart(chartHost!)).toMatchObject({
        dataUrl: ONE_PIXEL_PNG_DATA_URL,
        width: 720,
        height: 340,
      });
    } finally {
      cleanup();
    }

    const chartHostAfter = article.querySelector("[role='img']");
    expect(chartHostAfter).not.toBeNull();
    expect(captureRegisteredChart(chartHostAfter!)).toBeNull();
  });

  it("exports markdown, HTML (with embedded light chart PNG), and Word (.docx)", async () => {
    await exportReportById("rep-1", "md");
    expect(mocks.downloadTextFile).toHaveBeenCalledWith(
      "2026年7月退款分析报告.md",
      expect.stringContaining("# 2026年7月退款分析报告"),
      "text/markdown;charset=utf-8",
    );

    await exportReportById("rep-1", "html");
    expect(mocks.downloadTextFile).toHaveBeenLastCalledWith(
      "2026年7月退款分析报告.html",
      expect.stringContaining(ONE_PIXEL_PNG_DATA_URL),
      "text/html;charset=utf-8",
    );

    await exportReportById("rep-1", "docx");
    expect(mocks.downloadBlobFile).toHaveBeenCalledTimes(1);
    const [docxFilename, docxBlob] = mocks.downloadBlobFile.mock.calls[0] as [string, Blob];
    expect(docxFilename).toBe("2026年7月退款分析报告.docx");

    const entries = readZipEntries(await readBlobBuffer(docxBlob));
    const xml = new TextDecoder().decode(entries.get("word/document.xml"));
    expect(xml).toContain("2026年7月退款分析报告");
    expect(xml).toContain("微信小程序");
    expect(xml).toContain("各渠道退款对比");
    expect(xml).toContain("<w:drawing>");
  });
});
