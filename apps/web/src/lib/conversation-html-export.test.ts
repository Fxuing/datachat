import type { ReportDetail } from "@datachat/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatArtifact, ChatMessage } from "./api";

const ONE_PIXEL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW0cAAAAASUVORK5CYII=";

const mocks = vi.hoisted(() => ({
  getReport: vi.fn(),
  getArtifact: vi.fn(),
  getArtifactRows: vi.fn(),
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

import { buildConversationHtml } from "./conversation-html-export";

const chartId = "11111111-1111-4111-8111-111111111111";
const standaloneChartId = "11111111-1111-4111-8111-111111111112";
const reportOnlyChartId = "11111111-1111-4111-8111-111111111113";
const resultId = "22222222-2222-4222-8222-222222222222";
const reportTableId = "22222222-2222-4222-8222-222222222223";
const excelId = "33333333-3333-4333-8333-333333333333";
const reportId = "44444444-4444-4444-8444-444444444444";
const missingReportId = "44444444-4444-4444-8444-444444444445";

describe("conversation-html-export", () => {
  beforeEach(() => {
    mocks.getReport.mockReset();
    mocks.getArtifact.mockReset();
    mocks.getArtifactRows.mockReset();
    mocks.renderMermaidSvg.mockReset();
    mocks.renderChartOptionToPng.mockReset();

    mocks.renderMermaidSvg.mockResolvedValue('<svg data-test="mermaid"><rect /></svg>');
    mocks.renderChartOptionToPng.mockReturnValue({
      dataUrl: ONE_PIXEL_PNG_DATA_URL,
      width: 720,
      height: 340,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a zero-script offline HTML with charts, tables, mermaid, SQL, and collapsible embedded reports", async () => {
    const reportDetail: ReportDetail = {
      id: reportId,
      conversationId: "c-1",
      title: "区域经营深度报告",
      markdown: [
        "## 报告摘要",
        "",
        "华北区域环比增长 18%。",
        "",
        `[[chart:${reportOnlyChartId}]]`,
        "",
        `[[artifact:${reportTableId}]]`,
      ].join("\n"),
      artifactIds: [reportOnlyChartId, reportTableId],
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_050_000,
    };

    mocks.getReport.mockImplementation(async (id: string) => {
      if (id === reportId) return { report: reportDetail };
      throw new Error("not found");
    });

    mocks.getArtifact.mockImplementation(async (id: string) => {
      if (id === reportOnlyChartId) {
        return {
          id: reportOnlyChartId,
          kind: "chart",
          columns: [],
          rowCount: 2,
          truncated: false,
          spec: { chart: { title: "报告专属趋势图" }, option: { series: [] } },
          createdAt: 1_700_000_000_000,
        };
      }
      if (id === reportTableId) {
        return {
          id: reportTableId,
          kind: "result",
          columns: [{ name: "区域", type: "string" }, { name: "GMV", type: "number" }],
          rowCount: 1,
          truncated: false,
          spec: null,
          createdAt: 1_700_000_000_000,
        };
      }
      throw new Error(`unexpected getArtifact(${id})`);
    });

    mocks.getArtifactRows.mockResolvedValue({
      columns: [{ name: "区域", type: "string" }, { name: "GMV", type: "number" }],
      rows: [["华北", 98000]],
      total: 1,
    });

    const messages: ChatMessage[] = [
      {
        runId: "run-1",
        status: "ok",
        user: { content: "统计各区域 GMV <script>alert(1)</script>", skill: "sales-summary" },
        assistant: {
          content: [
            "华北排名第一。",
            "",
            "```mermaid",
            "flowchart LR",
            "A[华北] --> B[增长18%]",
            "```",
            "",
            `[[chart:${chartId}]]`,
            "",
            `明细见 [[result:${resultId}|各区域明细]]`,
            "",
            `[[excel:${excelId}]]`,
            "",
            `[[report:${reportId}]]`,
          ].join("\n"),
        },
        tools: [
          {
            toolCallId: "tool-1",
            name: "create_report",
            status: "ok",
            args: { artifactIds: [reportOnlyChartId] },
          },
        ],
        sqls: [
          {
            auditId: "audit-1",
            status: "ok",
            sql: "SELECT region, SUM(amount) FROM orders WHERE note <> '<script>' GROUP BY region",
          },
        ],
        results: [
          {
            artifactId: resultId,
            columns: [{ name: "region", type: "string" }, { name: "gmv", type: "number" }],
            rows: [["华北", 50000]],
            rowCount: 1,
            truncated: false,
          },
        ],
        reports: [
          { reportId, title: "区域经营深度报告" },
          { reportId: missingReportId, title: "已删除报告" },
        ],
        scope: { departments: ["华北区"] },
        error: null,
        createdAt: 1_700_000_000_000,
      },
    ];

    const artifacts: ChatArtifact[] = [
      {
        id: chartId,
        runId: "run-1",
        kind: "chart",
        columns: [],
        rowCount: 3,
        truncated: false,
        spec: { chart: { title: "区域 GMV 对比" }, option: {} },
        createdAt: 1_700_000_000_000,
      },
      {
        id: reportOnlyChartId,
        runId: "run-1",
        kind: "chart",
        columns: [],
        rowCount: 2,
        truncated: false,
        spec: { chart: { title: "报告专属趋势图" }, option: {} },
        createdAt: 1_700_000_000_050,
      },
      {
        id: standaloneChartId,
        runId: "run-1",
        kind: "chart",
        columns: [],
        rowCount: 4,
        truncated: false,
        spec: { chart: { title: "独立补充图表" }, option: {} },
        createdAt: 1_700_000_000_080,
      },
      {
        id: excelId,
        runId: "run-1",
        kind: "excel",
        columns: [],
        rowCount: 15,
        truncated: false,
        spec: {
          filename: "区域销售汇总",
          sheets: [{ name: "区域汇总", artifactId: resultId, rowCount: 15 }],
          totalRows: 15,
        },
        createdAt: 1_700_000_000_100,
      },
    ];

    const html = await buildConversationHtml({
      title: "区域经营复盘 <2026>",
      sourceLabel: "主库 · MySQL",
      messages,
      artifacts,
      exportedAt: new Date(2026, 10, 27, 10, 0, 0).getTime(),
    });

    // Self-contained document without embedded scripts or raw unescaped user HTML
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("区域经营复盘 &lt;2026&gt;");

    // Metadata, TOC anchors, scope notice, skill badge, and SQL details
    expect(html).toContain("数据来源：主库 · MySQL");
    expect(html).toContain("技能 · sales-summary");
    expect(html).toContain("数据范围：华北区（含下级部门）");
    expect(html).toContain('href="#turn-1"');
    expect(html).toContain('href="#report-1"');
    expect(html).toContain('class="sql-details"');
    expect(html).toContain("SELECT region, SUM(amount) FROM orders");

    // Conversation charts (inline + standalone), Mermaid SVG, result table, Excel summary
    expect(html).toContain("区域 GMV 对比");
    expect(html).toContain("独立补充图表");
    expect(html).toContain(ONE_PIXEL_PNG_DATA_URL);
    expect(html).toContain('<svg data-test="mermaid">');
    expect(html).toContain("各区域明细");
    expect(html).toContain("50000");
    expect(html).toContain("区域销售汇总.xlsx");

    // Embedded collapsible full report includes report body, report chart PNG, and report table
    expect(html).toContain('class="embedded-report" id="report-1"');
    expect(html).toContain("区域经营深度报告");
    expect(html).toContain("报告摘要");
    expect(html).toContain("华北区域环比增长 18%");
    expect(html).toContain("报告专属趋势图");
    expect(html).toContain("98000");

    // Missing report renders graceful fallback instead of crashing
    expect(html).toContain("分析报告「已删除报告」不可用或已被删除。");

    // Verify DOM parse correctness & zero duplicate standalone rendering of report-only chart
    const doc = new DOMParser().parseFromString(html, "text/html");
    const conversationCharts = Array.from(doc.querySelectorAll(".chart-card-title")).map(
      (el) => el.textContent,
    );
    expect(conversationCharts).toEqual(["区域 GMV 对比", "独立补充图表"]);
    expect(doc.querySelectorAll("details.embedded-report")).toHaveLength(1);
  });
});
