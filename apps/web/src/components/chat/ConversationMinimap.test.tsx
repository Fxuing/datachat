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
    expect(screen.queryByText("第二个回答")).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: "跳到第 2 轮" });
    fireEvent.click(row);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("highlights the tick matching the visible turn while scrolling", () => {
    const messages = [
      message("run-1", "第一个问题", "第一个回答"),
      message("run-2", "第二个问题", "第二个回答"),
      message("run-3", "第三个问题", "第三个回答"),
    ];
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(container, "scrollHeight", { value: 1200, configurable: true });
    Object.defineProperty(container, "scrollTop", { value: 300, writable: true, configurable: true });
    container.getBoundingClientRect = () =>
      ({ top: 0, bottom: 400, height: 400, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const tops: Record<string, number> = { "run-1": -200, "run-2": 80, "run-3": 500 };
    for (const msg of messages) {
      const el = document.createElement("div");
      el.id = `turn-${msg.runId}`;
      el.getBoundingClientRect = () =>
        ({ top: tops[msg.runId]!, bottom: tops[msg.runId]! + 200, height: 200, left: 0, right: 800, width: 800, x: 0, y: tops[msg.runId]!, toJSON: () => ({}) }) as DOMRect;
      container.append(el);
    }

    render(
      <ConversationMinimap messages={messages} containerRef={{ current: container }} />,
    );

    const tick2 = screen.getByRole("button", { name: "跳到第 2 轮" });
    expect(tick2).toHaveAttribute("aria-current", "true");
    expect(tick2.firstElementChild).toHaveClass("bg-brand");

    tops["run-1"] = 20;
    tops["run-2"] = 300;
    tops["run-3"] = 700;
    container.scrollTop = 0;
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });
    fireEvent.scroll(container);
    rafSpy.mockRestore();

    const tick1 = screen.getByRole("button", { name: "跳到第 1 轮" });
    expect(tick1).toHaveAttribute("aria-current", "true");
    expect(tick1.firstElementChild).toHaveClass("bg-brand");
    expect(tick2).not.toHaveAttribute("aria-current");
  });

  it("stays hidden for very short conversations", () => {
    const messages = [message("run-1", "问题", "回答")];
    render(
      <ConversationMinimap messages={messages} containerRef={{ current: null }} />,
    );
    expect(screen.queryByLabelText("会话导航")).not.toBeInTheDocument();
  });
});
