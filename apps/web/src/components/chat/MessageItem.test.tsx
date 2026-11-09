import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { MarkdownText, MessageItem } from "./MessageItem";
import type { ChatMessage } from "../../lib/api";

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
  it("renders the persisted terminal error instead of a generic message", () => {
    render(<MessageItem message={message({ error: "upstream exploded" })} />);
    expect(screen.getByText("upstream exploded")).toBeInTheDocument();
    expect(screen.queryByText("本次回答失败，请重试。")).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /执行过程/ }));

    expect(screen.getByText("查询结果")).toBeInTheDocument();
    expect(screen.getByText("1 行 · 1 列")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /查看 SQL/ }));
    expect(screen.getByText("SELECT COUNT(*) AS total FROM users")).toBeInTheDocument();
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
