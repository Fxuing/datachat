import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConversationMinimap } from "./ConversationMinimap";
import type { ChatMessage } from "../../lib/api";

function message(runId: string, question: string, answer: string): ChatMessage {
  return {
    runId,
    status: "ok",
    user: { content: question },
    assistant: { content: answer },
    tools: [],
    results: [],
    sqls: [],
    error: null,
    createdAt: 1,
  };
}

describe("ConversationMinimap", () => {
  it("previews a turn on hover and jumps on click", () => {
    const messages = [
      message("run-1", "第一个问题", "第一个回答"),
      message("run-2", "第二个问题", "第二个回答"),
      message("run-3", "第三个问题", "第三个回答"),
    ];
    const container = document.createElement("div");
    const target = document.createElement("div");
    target.id = "turn-run-2";
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    container.append(target);

    render(
      <div ref={() => undefined}>
        <ConversationMinimap
          messages={messages}
          containerRef={{ current: container }}
        />
      </div>,
    );

    const tick = screen.getByRole("button", { name: "跳到第 2 轮" });
    fireEvent.mouseEnter(tick);
    expect(screen.getByText("3 轮对话")).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /第二个问题/ });
    fireEvent.click(row);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("stays hidden for very short conversations", () => {
    const messages = [message("run-1", "问题", "回答")];
    render(
      <ConversationMinimap messages={messages} containerRef={{ current: null }} />,
    );
    expect(screen.queryByLabelText("会话导航")).not.toBeInTheDocument();
  });
});
