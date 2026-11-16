import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ChatResult, ChatSql } from "../../lib/api";
import type { QueryPair } from "../../lib/pair-queries";
import { TurnTrace } from "./TurnTrace";
import type { TurnTool } from "./turn-trace-model";

const sql: ChatSql = {
  sql: "SELECT id, name FROM users LIMIT 10",
  auditId: "audit-1",
  status: "ok",
};

const result: ChatResult = {
  artifactId: "artifact-1",
  columns: [
    { name: "id", type: "number" },
    { name: "name", type: "string" },
  ],
  rows: [[1, "Ada"]],
  rowCount: 1,
  truncated: false,
  sql: sql.sql,
};

const queries: QueryPair<ChatResult>[] = [{ sql, result }];

const tools: TurnTool[] = [
  {
    toolCallId: "tool-1",
    name: "db_schema",
    status: "ok",
    args: { table: "users" },
    durationMs: 420,
    summary: "1 张表 · 2 个字段",
  },
  {
    toolCallId: "tool-2",
    name: "db_query",
    status: "ok",
    durationMs: 1_200,
    summary: "查询完成",
  },
];

function expandedNames() {
  return screen.getAllByTestId("trace-line").map((line) => line.textContent ?? "");
}

describe("TurnTrace", () => {
  it("folds a settled turn into one summary line", async () => {
    const user = userEvent.setup();
    render(<TurnTrace status="ok" thinking="先看表结构" tools={tools} queries={queries} durationMs={23_000} />);

    const summary = screen.getByRole("button", { name: /本轮完成 3 步/ });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(summary).toHaveTextContent("23s");
    expect(screen.queryByText("读取表结构")).not.toBeInTheDocument();

    await user.click(summary);
    expect(screen.getByText("读取表结构")).toBeInTheDocument();
  });

  it("carries the token count on the summary line", () => {
    render(
      <TurnTrace
        status="ok"
        tools={tools}
        durationMs={23_000}
        usage={{ input: 20_000, output: 6_800, cacheRead: 0, cacheWrite: 0 }}
      />,
    );

    expect(screen.getByRole("button", { name: /本轮完成/ })).toHaveTextContent(
      "2 步 · 23s · 26.8k tokens",
    );
  });

  it("keeps thinking first, then tools and queries in execution order", async () => {
    const user = userEvent.setup();
    render(<TurnTrace status="ok" thinking="先看表结构" tools={tools} queries={queries} />);

    await user.click(screen.getByRole("button", { name: /本轮完成/ }));

    // Reasoning rows carry the model's own words, not a "思考" label.
    expect(expandedNames()[0]).toContain("先看表结构");
    expect(expandedNames()[0]).not.toContain("思考");
    expect(expandedNames().slice(1)).toEqual([
      expect.stringContaining("读取表结构"),
      expect.stringContaining("执行查询"),
    ]);
  });

  it("puts the SQL next to the rows it produced", async () => {
    const user = userEvent.setup();
    render(<TurnTrace status="ok" queries={queries} />);

    await user.click(screen.getByRole("button", { name: /本轮完成/ }));
    expect(screen.getByText("1 行")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /执行查询/ }));

    expect(screen.getByText(/SELECT id, name/)).toBeInTheDocument();
    expect(screen.getByText("1 行 · 2 列")).toBeInTheDocument();
  });

  it("keeps an in-flight query on the trace before its SQL is recorded", () => {
    render(
      <TurnTrace
        status="running"
        tools={[{ toolCallId: "tool-2", name: "db_query", status: "running" }]}
      />,
    );

    expect(screen.getByRole("button", { name: /本轮执行中 1 步/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("执行查询")).toBeInTheDocument();
  });

  it("opens a failed run and names the tool that broke", () => {
    render(
      <TurnTrace
        status="error"
        tools={[
          {
            toolCallId: "tool-3",
            name: "make_chart",
            status: "error",
            summary: "ECharts 渲染失败",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /本轮失败/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("生成图表失败")).toBeInTheDocument();
    expect(screen.getByText("ECharts 渲染失败")).toBeInTheDocument();
  });

  it("marks a rejected query without inventing a result", async () => {
    const user = userEvent.setup();
    render(
      <TurnTrace
        status="ok"
        queries={[{ sql: { sql: "DROP TABLE users", auditId: "audit-2", status: "rejected" } }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /本轮完成/ }));
    expect(screen.getByText("查询被拒绝")).toBeInTheDocument();
    expect(screen.queryByText("查询结果")).not.toBeInTheDocument();
  });

  it("updates the reasoning line in place while it streams", () => {
    render(<TurnTrace status="running" thinking="先确认表结构" />);

    expect(screen.getByRole("button", { name: /本轮执行中 1 步/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(expandedNames()[0]).toContain("先确认表结构");
    expect(screen.queryByText("思考中")).not.toBeInTheDocument();
    // Folded even while live: a detail body that grows on every delta makes the
    // page jump around, so the one-line summary is all that moves.
    expect(screen.queryByTestId("turn-thinking")).not.toBeInTheDocument();
  });

  it("summarises each reasoning stretch on its own row", async () => {
    const user = userEvent.setup();
    render(
      <TurnTrace
        status="ok"
        thinkingSegments={[
          "好的，用户想看 10 月份的数据。先确认 orders 表和 channels 表的关联字段，再看订单量按渠道怎么分布，最后给出环比结论。",
          "看到 orders 上只有 channel_id。",
        ]}
        tools={tools}
      />,
    );

    await user.click(screen.getByRole("button", { name: /本轮完成/ }));

    // Collapsed rows read as a narrative: 摘要 → 步骤 → 摘要 → 步骤, and each
    // row carries as much of its stretch as the line can hold.
    expect(screen.getByText((content) => content.startsWith("好的，用户想看 10 月份的数据。"))).toBeInTheDocument();
    expect(screen.getByText("看到 orders 上只有 channel_id。")).toBeInTheDocument();
    expect(screen.queryByText(/105 字/)).not.toBeInTheDocument();
  });

  it("opens a finished stretch at its first line", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TurnTrace status="ok" thinking="第一段推理。" />);
    await user.click(screen.getByRole("button", { name: /本轮完成/ }));
    await user.click(screen.getByRole("button", { name: /第一段推理/ }));

    const detail = screen.getByTestId("turn-thinking");
    Object.defineProperty(detail, "scrollHeight", { value: 900, configurable: true });

    rerender(<TurnTrace status="ok" thinking="第一段推理。\n\n第二段推理，长到装不下。" />);

    expect(detail.scrollTop).toBe(0);
  });

  it("follows the bottom only while the stretch is still being written", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TurnTrace status="running" thinking="先看表结构" />);
    await user.click(screen.getByRole("button", { name: /先看表结构/ }));

    const detail = screen.getByTestId("turn-thinking");
    Object.defineProperty(detail, "scrollHeight", { value: 900, configurable: true });

    rerender(<TurnTrace status="running" thinking="先看表结构，再核对字段口径。" />);

    expect(detail.scrollTop).toBe(900);
  });

  it("lets the row fill its width instead of stopping at the first sentence", async () => {
    const user = userEvent.setup();
    // No character budget on our side: the line is `truncate`, so the browser
    // cuts it exactly at the edge of whatever room the layout gives it.
    const long =
      "用户在问一个非常具体的问题而且这段话一直不停地说下去没有任何标点符号让人无法判断重点在哪里" +
      "只能靠长度硬切一刀并且加上省略号收尾才好放进这一行";
    render(<TurnTrace status="ok" thinking={long} />);
    await user.click(screen.getByRole("button", { name: /本轮完成/ }));

    const row = screen.getByText(long);
    expect(row).toHaveClass("truncate");
  });

  it("alternates reasoning and execution as the run works", () => {
    render(
      <TurnTrace
        status="running"
        thinkingSegments={["先确认表结构", "表里没有 channel 字段，换成渠道维度"]}
        tools={tools}
      />,
    );

    // 思考原文 → 读取表结构 → 正在写的那段：the second stretch is still arriving.
    const lines = expandedNames();
    expect(lines[0]).toContain("先确认表结构");
    expect(lines[1]).toContain("读取表结构");
    expect(lines[2]).toContain("表里没有 channel 字段，换成渠道维度");
    expect(expandedNames()[2]).toContain("换成渠道维度");

    // Every reasoning stretch stays folded, live or not; the line carries the gist.
    const rows = screen.getAllByTestId("trace-line");
    expect(within(rows[0]!).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(within(rows[2]!).getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the reasoning folded and unchanged when the run ends", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <TurnTrace
        status="running"
        thinkingSegments={["先确认表结构", "再统计渠道"]}
        tools={tools}
      />,
    );

    const lines = expandedNames();
    expect(lines[0]).toContain("先确认表结构");
    expect(lines[2]).toContain("再统计渠道");

    rerender(
      <TurnTrace status="ok" thinkingSegments={["先确认表结构", "再统计渠道"]} tools={tools} />,
    );
    // The turn folds to one line, and reopening gives back the same three rows:
    // the reasoning never reorganises itself under the reader.
    expect(screen.queryAllByTestId("trace-line")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /本轮完成/ }));
    expect(expandedNames()).toEqual(lines);
  });

  it("links a finished report line to the report", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <TurnTrace
          status="ok"
          tools={[
            {
              toolCallId: "tool-4",
              name: "create_report",
              status: "ok",
              summary: "月度经营报告",
              url: "/reports/abc",
            },
          ]}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: /本轮完成/ }));
    await user.click(screen.getByRole("button", { name: /生成报告/ }));
    expect(screen.getByRole("link", { name: /查看报告/ })).toHaveAttribute("href", "/reports/abc");
  });

  it("does not make a step expandable when it has no detail", async () => {
    const user = userEvent.setup();
    render(
      <TurnTrace
        status="ok"
        tools={[{ toolCallId: "tool-5", name: "db_schema", status: "ok", args: {} }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /本轮完成/ }));
    expect(screen.getByText("读取表结构")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /读取表结构/ })).not.toBeInTheDocument();
  });

  it("renders nothing for a turn that has no process to show", () => {
    const { container } = render(<TurnTrace status="ok" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels a stopped run separately", () => {
    render(<TurnTrace status="aborted" thinking="先确认表结构" />);
    expect(screen.getByRole("button", { name: /本轮已停止/ })).toBeInTheDocument();
  });
});
