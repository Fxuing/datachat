import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("keeps the thinking transcript collapsed until opened", async () => {
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
    expect(screen.queryByText("先确认表结构，再统计 7 月数据。")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /思考过程/ }));
    expect(screen.getByText("先确认表结构，再统计 7 月数据。")).toBeInTheDocument();
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

  it("keeps standalone results inside the collapsed process block", async () => {
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

    const user = userEvent.setup();
    expect(screen.queryByText("查询结果")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /执行步骤/ }));

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
});
