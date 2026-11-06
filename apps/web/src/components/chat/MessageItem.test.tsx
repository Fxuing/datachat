import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageItem } from "./MessageItem";
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

  it("falls back when an old run has no persisted error", () => {
    render(<MessageItem message={message()} />);
    expect(screen.getByText("本次回答失败，请重试。")).toBeInTheDocument();
  });
});
