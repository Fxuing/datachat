import { describe, expect, it } from "vitest";
import { buildConversationMarkdown, sanitizeFileName } from "./conversation-export";
import type { ChatArtifact, ChatMessage } from "./api";

const chartId = "11111111-1111-4111-8111-111111111111";
const resultId = "22222222-2222-4222-8222-222222222222";
const excelId = "33333333-3333-4333-8333-333333333333";

describe("conversation-export", () => {
  it("builds markdown with cleaned inline placeholders and SQL blocks", () => {
    const messages: ChatMessage[] = [
      {
        runId: "run-1",
        status: "ok",
        user: { content: "统计各区域 GMV", skill: "sales-summary" },
        assistant: {
          content: `华北排名第一。\n\n[[chart:${chartId}]]\n\n明细见 [[result:${resultId}|各区域明细]]\n\n[[excel:${excelId}]]`,
        },
        tools: [],
        sqls: [
          {
            auditId: "audit-1",
            status: "ok",
            sql: "SELECT region, SUM(amount) FROM orders GROUP BY region",
          },
        ],
        results: [],
        error: null,
        createdAt: 1_700_000_000_000,
      },
      {
        runId: "run-2",
        status: "error",
        user: { content: "查不存在的表" },
        assistant: null,
        tools: [],
        sqls: [],
        results: [],
        error: "表不存在",
        createdAt: 1_700_000_010_000,
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

    const md = buildConversationMarkdown({
      title: "区域经营复盘",
      sourceLabel: "主库 · MySQL",
      messages,
      artifacts,
      exportedAt: new Date(2026, 10, 22, 18, 0, 0).getTime(),
    });

    expect(md).toContain("# 区域经营复盘");
    expect(md).toContain("- 数据来源：主库 · MySQL");
    expect(md).toContain("`/sales-summary` 统计各区域 GMV");
    expect(md).toContain("> [图表] 区域 GMV 对比");
    expect(md).toContain("> [数据表] 各区域明细");
    expect(md).toContain("> [Excel 文件] 区域销售汇总.xlsx");
    expect(md).not.toContain(`[[chart:${chartId}]]`);
    expect(md).not.toContain(`[[result:${resultId}`);
    expect(md).not.toContain(`[[excel:${excelId}]]`);
    expect(md).toContain("```sql\nSELECT region, SUM(amount) FROM orders GROUP BY region\n```");
    expect(md).toContain("> 错误：表不存在");
  });

  it("sanitizes unsafe file names", () => {
    expect(sanitizeFileName("2026/11 销售:复盘?", "chat", "md")).toBe("2026-11-销售-复盘.md");
    expect(sanitizeFileName("   ", "chat", "md")).toBe("chat.md");
  });
});
