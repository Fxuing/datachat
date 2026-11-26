import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { MarkdownText, MessageItem } from "./MessageItem";
import type { ChatArtifact, ChatMessage } from "../../lib/api";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    runId: "run-1",
    status: "error",
    user: { content: "hello" },
    assistant: null,
    tools: [],
    results: [],
    sqls: [],
    error: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("MessageItem", () => {
  it("explains a scope rejection under the error", () => {
    render(
      <MessageItem
        message={message({ error: "DATA_SCOPE_NO_DEPARTMENT: 当前数据源已启用部门数据权限，但你还没有加入任何部门" })}
      />,
    );
    expect(screen.getByText(/部门管理」中分配/)).toBeInTheDocument();
  });

  it("shows which departments filtered the answer", () => {
    render(
      <MessageItem
        message={message({
          status: "ok",
          assistant: { content: "本月共有 142 条记录。" },
          scope: { departments: ["销售部", "华东区"] },
        })}
      />,
    );
    expect(screen.getByText("销售部、华东区")).toBeInTheDocument();
    expect(screen.getByText(/本次结果已按当前数据权限过滤/)).toBeInTheDocument();
  });

  it("summarizes long department lists in the scope banner", () => {
    render(
      <MessageItem
        message={message({
          status: "ok",
          assistant: { content: "统计完成。" },
          scope: { departments: ["销售部", "市场部", "研发部", "财务部"] },
        })}
      />,
    );
    expect(screen.getByText("销售部、市场部、研发部 等 4 个部门")).toBeInTheDocument();
  });


  it("shows the explicitly invoked skill on the user bubble", () => {
    render(
      <MessageItem
        message={message({
          status: "ok",
          user: { content: "本月收入是多少？", skill: "monthly-revenue" },
        })}
      />,
    );
    expect(screen.getByText(/技能 · monthly-revenue/)).toBeInTheDocument();
    expect(screen.getByText("本月收入是多少？")).toBeInTheDocument();
  });

  it("copies fenced code blocks from markdown", async () => {
    const user = userEvent.setup();
    render(<MarkdownText content={"```sql\nSELECT 1;\n```"} />);

    await user.click(screen.getByRole("button", { name: "复制代码" }));

    expect(await navigator.clipboard.readText()).toBe("SELECT 1;");
    expect(screen.getByRole("button", { name: "已复制代码" })).toBeInTheDocument();
  });

  it("does not add a copy action to inline code", () => {
    render(<MarkdownText content={"使用 `npm test` 运行。"} />);
    expect(screen.queryByRole("button", { name: /复制/ })).not.toBeInTheDocument();
  });

  it("shows the reasoning on its row and keeps the full transcript one click away", async () => {
    const user = userEvent.setup();
    render(
      <MessageItem
        message={message({
          status: "ok",
          thinking: "先确认表结构，再统计 7 月数据。",
          assistant: { content: "完成了。" },
        })}
      />,
    );
    expect(screen.queryByText(/先确认表结构/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /本轮完成/ }));
    const row = screen.getAllByTestId("trace-line")[0]!;
    expect(row).toHaveTextContent("先确认表结构，再统计 7 月数据。");
    expect(row).not.toHaveTextContent("思考");

    await user.click(within(row).getByRole("button"));
    expect(screen.getByTestId("turn-thinking")).toHaveTextContent("先确认表结构，再统计 7 月数据。");
  });

  it("renders the persisted terminal error instead of a generic message", () => {
    render(<MessageItem message={message({ error: "upstream exploded" })} />);
    expect(screen.getByText("upstream exploded")).toBeInTheDocument();
    expect(screen.queryByText("本次回答失败，请重试。")).not.toBeInTheDocument();
  });

  it("retries a failed turn as-is or with another model", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const failed = message({ error: "upstream exploded" });
    render(
      <MessageItem
        message={failed}
        models={[
          {
            id: "acme::backup",
            modelId: "backup",
            providerId: "acme",
            providerName: "Acme",
            name: "Backup",
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ]}
        onRetry={onRetry}
      />,
    );

    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenLastCalledWith(failed);

    await user.click(screen.getByRole("button", { name: /换模型重试/ }));
    await user.click(screen.getByText("Backup"));
    expect(onRetry).toHaveBeenLastCalledWith(failed, "acme::backup");
  });

  it("renders report-style artifact placeholders as inline result tables", () => {
    const artifactId = "4e6398fc-7fe5-45dd-b689-44ef6fed928a";
    render(
      <MemoryRouter>
        <MessageItem
          message={message({
            status: "ok",
            assistant: { content: `汇总如下：

[[artifact:${artifactId}]]` },
            results: [
              {
                artifactId,
                columns: [{ name: "total", type: "number" }],
                rows: [[42]],
                rowCount: 1,
                truncated: false,
              },
            ],
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/\[\[artifact:/)).not.toBeInTheDocument();
    // Detail rows stay closed until the user asks for them.
    expect(screen.queryByText("total")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看数据" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("total")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders a chat result reference as a compact link to the full result", async () => {
    const user = userEvent.setup();
    const artifactId = "result-1";
    render(
      <MemoryRouter>
        <MessageItem
          message={message({
            status: "ok",
            assistant: { content: `汇总如下：

[[result:${artifactId}]]` },
            results: [
              {
                artifactId,
                columns: [{ name: "total", type: "number" }],
                rows: [[42]],
                rowCount: 1,
                truncated: false,
                sql: "SELECT 42 AS total",
              },
            ],
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/\[\[result:/)).not.toBeInTheDocument();
    expect(screen.queryByText("查询结果")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /查看完整结果\s*1 行/ })).toBeInTheDocument();
    expect(screen.queryByText("total")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /查看完整结果\s*1 行/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("total")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("SELECT 42 AS total")).toBeInTheDocument();
  });

  it("labels a truncated result reference as partial", () => {
    render(
      <MemoryRouter>
        <MessageItem
          message={message({
            status: "ok",
            assistant: { content: "[[result:result-1]]" },
            results: [
              {
                artifactId: "result-1",
                columns: [{ name: "total", type: "number" }],
                rows: [[42]],
                rowCount: 1000,
                truncated: true,
              },
            ],
          })}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: /查看查询结果\s*已截断 · 1,000 行/ }),
    ).toBeInTheDocument();
  });

  it("shows an unavailable message for a missing result reference", () => {
    render(
      <MemoryRouter>
        <MessageItem
          message={message({
            status: "ok",
            assistant: { content: "[[result:missing-result]]" },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/结果引用不可用/)).toBeInTheDocument();
    expect(screen.getByText("missing-result")).toBeInTheDocument();
  });

  it("groups consecutive unlabelled result references horizontally and labels them by columns", () => {
    render(
      <MemoryRouter>
        <MessageItem
          message={message({
            status: "ok",
            assistant: { content: "完整明细：\n\n[[result:res-1]]\n[[result:res-2]]" },
            results: [
              {
                artifactId: "res-1",
                columns: [
                  { name: "类目", type: "string" },
                  { name: "销售额", type: "number" },
                ],
                rows: [["服饰", 100]],
                rowCount: 6,
                truncated: false,
              },
              {
                artifactId: "res-2",
                columns: [
                  { name: "状态", type: "string" },
                  { name: "订单数", type: "number" },
                  { name: "金额", type: "number" },
                ],
                rows: [["已完成", 10, 50]],
                rowCount: 8,
                truncated: false,
              },
            ],
          })}
        />
      </MemoryRouter>,
    );

    const first = screen.getByRole("button", { name: /类目 · 销售额\s*6 行/ });
    const second = screen.getByRole("button", { name: /状态 · 订单数 等\s*8 行/ });
    expect(first.parentElement).toBe(second.parentElement);
    expect(first.parentElement).toHaveClass("flex-wrap");
  });

  it("disambiguates consecutive result references with identical columns using numbered suffixes", () => {
    render(
      <MemoryRouter>
        <MessageItem
          message={message({
            status: "ok",
            assistant: { content: "[[result:res-1]]\n[[result:res-2]]" },
            results: [
              {
                artifactId: "res-1",
                columns: [
                  { name: "类目", type: "string" },
                  { name: "销售额", type: "number" },
                ],
                rows: [["服饰", 100]],
                rowCount: 6,
                truncated: false,
              },
              {
                artifactId: "res-2",
                columns: [
                  { name: "类目", type: "string" },
                  { name: "销售额", type: "number" },
                ],
                rows: [["家居", 200]],
                rowCount: 12,
                truncated: false,
              },
            ],
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: /类目 · 销售额 #1\s*6 行/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /类目 · 销售额 #2\s*12 行/ })).toBeInTheDocument();
  });

  it("uses an explicit result label on the chip and detail dialog title", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MessageItem
          message={message({
            status: "ok",
            assistant: { content: "[[result:res-1|类目销售明细]]" },
            results: [
              {
                artifactId: "res-1",
                columns: [{ name: "类目", type: "string" }],
                rows: [["服饰"]],
                rowCount: 6,
                truncated: false,
              },
            ],
          })}
        />
      </MemoryRouter>,
    );

    const chip = screen.getByRole("button", { name: /类目销售明细\s*6 行/ });
    await user.click(chip);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "类目销售明细" })).toBeInTheDocument();
  });

  it("shows a result without a recorded statement as a result card", () => {
    render(
      <MemoryRouter>
        <MessageItem
          message={message({
            status: "ok",
            assistant: { content: "共 1 行。" },
            results: [
              {
                artifactId: "artifact-1",
                columns: [{ name: "total", type: "number" }],
                rows: [[1]],
                rowCount: 1,
                truncated: false,
                sql: "SELECT COUNT(*) AS total FROM users",
              },
            ],
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("查询结果")).toBeInTheDocument();
    expect(screen.getByText("1 行 · 1 列")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /查看 SQL/ }));
    expect(screen.getByText("SELECT COUNT(*) AS total FROM users")).toBeInTheDocument();
  });

  it("renders a chart placeholder inline and hides the duplicate card", () => {
    const runId = "run-chart";
    const chart: ChatArtifact = {
      id: "chart-1",
      runId,
      kind: "chart",
      columns: [],
      rowCount: 6,
      truncated: false,
      spec: {
        chart: { title: "月度趋势" },
        option: { series: [{ type: "line", data: [1, 2] }] },
      },
      createdAt: 1,
    };
    render(
      <MemoryRouter>
        <MessageItem
          artifacts={[chart]}
          message={message({
            runId,
            status: "ok",
            assistant: { content: "趋势如下。\n\n[[chart:chart-1]]\n\n结论。" },
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("月度趋势")).toHaveLength(1);
    expect(screen.queryByText(/\[\[chart:/)).not.toBeInTheDocument();
  });

  it("renders an explicit chart placeholder even when the chart artifact belongs to an earlier run", () => {
    const chartFromEarlierRun: ChatArtifact = {
      id: "chart-earlier",
      runId: "run-failed-before",
      kind: "chart",
      columns: [],
      rowCount: 12,
      truncated: false,
      spec: {
        chart: { title: "1月热销商品" },
        option: { series: [{ type: "bar", data: [10, 20] }] },
      },
      createdAt: 1,
    };
    render(
      <MemoryRouter>
        <MessageItem
          artifacts={[chartFromEarlierRun]}
          message={message({
            runId: "run-retried",
            status: "ok",
            assistant: { content: "1月明细如下。\n\n[[chart:chart-earlier]]" },
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("1月热销商品")).toBeInTheDocument();
    expect(screen.queryByText("图表引用不可用")).not.toBeInTheDocument();
  });

  it("suppresses standalone fallback charts that are already included in a succeeded report", () => {
    const runId = "run-report-charts";
    const chart1: ChatArtifact = {
      id: "chart-1",
      runId,
      kind: "chart",
      columns: [],
      rowCount: 6,
      truncated: false,
      spec: {
        chart: { title: "月度趋势" },
        option: { series: [{ type: "line", data: [1, 2] }] },
      },
      createdAt: 1,
    };
    const chart2: ChatArtifact = {
      id: "chart-2",
      runId,
      kind: "chart",
      columns: [],
      rowCount: 5,
      truncated: false,
      spec: {
        chart: { title: "渠道对比" },
        option: { series: [{ type: "bar", data: [3, 4] }] },
      },
      createdAt: 2,
    };
    render(
      <MemoryRouter>
        <MessageItem
          artifacts={[chart1, chart2]}
          message={message({
            runId,
            status: "ok",
            assistant: {
              content: "趋势如下。\n\n[[chart:chart-1]]\n\n[查看完整报告](/reports/r-1)",
            },
            tools: [
              {
                toolCallId: "tc-report",
                name: "create_report",
                status: "ok",
                args: { artifactIds: ["chart-1", "chart-2"] },
              },
            ],
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("月度趋势")).toHaveLength(1);
    expect(screen.queryByText("渠道对比")).not.toBeInTheDocument();
  });

  it("keeps unreferenced charts visible when create_report fails", () => {
    const runId = "run-report-error";
    const chart1: ChatArtifact = {
      id: "chart-1",
      runId,
      kind: "chart",
      columns: [],
      rowCount: 6,
      truncated: false,
      spec: {
        chart: { title: "月度趋势" },
        option: { series: [{ type: "line", data: [1, 2] }] },
      },
      createdAt: 1,
    };
    const chart2: ChatArtifact = {
      id: "chart-2",
      runId,
      kind: "chart",
      columns: [],
      rowCount: 5,
      truncated: false,
      spec: {
        chart: { title: "渠道对比" },
        option: { series: [{ type: "bar", data: [3, 4] }] },
      },
      createdAt: 2,
    };
    render(
      <MemoryRouter>
        <MessageItem
          artifacts={[chart1, chart2]}
          message={message({
            runId,
            status: "ok",
            assistant: { content: "趋势如下。\n\n[[chart:chart-1]]" },
            tools: [
              {
                toolCallId: "tc-report",
                name: "create_report",
                status: "error",
                args: { artifactIds: ["chart-1", "chart-2"] },
              },
            ],
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("月度趋势")).toBeInTheDocument();
    expect(screen.getByText("渠道对比")).toBeInTheDocument();
  });

  it("turns a backticked report path into an internal link", () => {
    const id = "76bd34cc-a717-481e-9870-c03570875db2";
    render(
      <MemoryRouter>
        <MarkdownText content={`完整报告：\`/reports/${id}\``} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", `/reports/${id}`);
  });

  it("falls back when an old run has no persisted error", () => {
    render(<MessageItem message={message()} />);
    expect(screen.getByText("本次回答失败，请重试。")).toBeInTheDocument();
  });

  it("opens external markdown links in a new tab", () => {
    render(
      <MemoryRouter>
        <MarkdownText content="参考 [文档](https://example.com/docs)" />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "文档" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("lets the user edit a historical prompt inline and resend it with its skill", async () => {
    const browser = userEvent.setup();
    const onEditResend = vi.fn();
    render(
      <MemoryRouter>
        <MessageItem
          onEditResend={onEditResend}
          message={message({
            status: "ok",
            user: { content: "统计上月订单", skill: "order-check" },
            assistant: { content: "共 120 单。" },
          })}
        />
      </MemoryRouter>,
    );

    await browser.click(screen.getByRole("button", { name: "编辑并重新提问" }));
    const editor = screen.getByLabelText("编辑提问内容");
    await browser.clear(editor);
    await browser.type(editor, "统计本月订单");
    await browser.click(screen.getByRole("button", { name: "重新发送" }));

    expect(onEditResend).toHaveBeenCalledWith("统计本月订单", "order-check");
  });

  it("renders inline and standalone excel cards, unavailable fallback, and resolves cross-turn result links", () => {
    const excel1: ChatArtifact = {
      id: "xls-1",
      runId: "run-1",
      kind: "excel",
      columns: [],
      rowCount: 12,
      truncated: false,
      spec: {
        filename: "Q1汇总表",
        sheets: [{ name: "区域汇总", artifactId: "res-1", rowCount: 12 }],
        totalRows: 12,
      },
      createdAt: 1,
    };
    const excel2: ChatArtifact = {
      id: "xls-2",
      runId: "run-1",
      kind: "excel",
      columns: [],
      rowCount: 5,
      truncated: false,
      spec: {
        filename: "独立兜底表",
        sheets: [{ name: "Sheet1", artifactId: "res-1", rowCount: 5 }],
        totalRows: 5,
      },
      createdAt: 2,
    };
    const priorResult = {
      artifactId: "res-prior",
      columns: [{ name: "region", type: "string" as const }],
      rows: [["华东"]],
      rowCount: 1,
      truncated: false,
    };

    render(
      <MemoryRouter>
        <MessageItem
          artifacts={[excel1, excel2]}
          allResults={[priorResult]}
          message={message({
            runId: "run-1",
            status: "ok",
            results: [],
            assistant: {
              content:
                "参考历史结果：\n\n[[result:res-prior|华东历史明细]]\n\nExcel：\n\n[[excel:xls-1]]\n\n[[excel:xls-missing]]",
            },
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: /华东历史明细\s*1 行/ })).toBeInTheDocument();
    expect(screen.queryByText(/结果引用不可用/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Q1汇总表.xlsx")).toHaveLength(1);
    expect(screen.getByText("独立兜底表.xlsx")).toBeInTheDocument();
    expect(screen.getByText("Excel 文件不可用")).toBeInTheDocument();
  });

  it("renders inline, standalone, legacy-tool, and cross-turn report cards without duplicating inline references", () => {
    const repIdInline = "11111111-1111-4111-8111-111111111111";
    const repIdStandalone = "22222222-2222-4222-8222-222222222222";
    const repIdLegacy = "33333333-3333-4333-8333-333333333333";
    const repIdCrossTurn = "44444444-4444-4444-8444-444444444444";

    render(
      <MemoryRouter>
        <MessageItem
          allReports={[{ reportId: repIdCrossTurn, title: "第一轮历史报告" }]}
          message={message({
            runId: "run-report-card",
            status: "ok",
            reports: [
              { reportId: repIdInline, title: "内联报告" },
              { reportId: repIdStandalone, title: "兜底报告" },
            ],
            tools: [
              {
                toolCallId: "tc-legacy",
                name: "create_report",
                status: "ok",
                args: { title: "旧版历史报告" },
                url: `/reports/${repIdLegacy}`,
              },
            ],
            assistant: {
              content: `复盘如下：\n\n[[report:${repIdInline}]]\n\n以及历史报告：\n\n[[report:${repIdCrossTurn}]]`,
            },
          })}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("内联报告")).toHaveLength(1);
    expect(screen.getByText("兜底报告")).toBeInTheDocument();
    expect(screen.getByText("旧版历史报告")).toBeInTheDocument();
    expect(screen.getByText("第一轮历史报告")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "导出 Word" })).toHaveLength(4);
  });
});
