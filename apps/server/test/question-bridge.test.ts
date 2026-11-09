import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { QuestionBridge } from "../src/agent/question-bridge.js";

const prompt = {
  toolCallId: "call-1",
  questions: [
    {
      question: "选哪个数据源？",
      header: "数据源",
      multiSelect: false,
      options: [
        { label: "订单库", description: "只读副本", hasPreview: false },
        { label: "用户库", description: "", hasPreview: false },
      ],
    },
  ],
};

describe("QuestionBridge", () => {
  it("turns extension prompts into host events and forwards answers back", () => {
    const onQuestion = vi.fn();
    const onResolved = vi.fn();
    const bridge = new QuestionBridge({ onQuestion, onResolved });
    const bus = createEventBus();
    bridge.bind(bus);

    bus.emit("rpiv:ask-user:prompt", prompt);
    expect(onQuestion).toHaveBeenCalledWith(prompt);

    bus.on("rpiv:ask-user:answer", (data) => {
      const request = data as { requestId: string; toolCallId: string };
      bus.emit("rpiv:ask-user:answer-result", {
        toolCallId: request.toolCallId,
        requestId: request.requestId,
        ok: true,
      });
    });

    const verdict = bridge.answer("call-1", {
      answers: [{ questionIndex: 0, optionIndexes: [1] }],
    });
    expect(verdict).toEqual({ toolCallId: "call-1", ok: true });
    expect(onResolved).toHaveBeenCalledWith({ toolCallId: "call-1", ok: true });
    expect(bridge.get("call-1")).toBeUndefined();
  });

  it("reports the plugin verdict when an answer is rejected", () => {
    const bridge = new QuestionBridge({ onQuestion: vi.fn(), onResolved: vi.fn() });
    const bus = createEventBus();
    bridge.bind(bus);
    bus.emit("rpiv:ask-user:prompt", prompt);

    bus.on("rpiv:ask-user:answer", (data) => {
      const request = data as { requestId: string; toolCallId: string };
      bus.emit("rpiv:ask-user:answer-result", {
        toolCallId: request.toolCallId,
        requestId: request.requestId,
        ok: false,
        code: "invalid_answer",
        reason: "选项超出范围",
      });
    });

    expect(bridge.answer("call-1", { answers: [{ questionIndex: 0, optionIndexes: [9] }] })).toEqual({
      toolCallId: "call-1",
      ok: false,
      code: "invalid_answer",
      reason: "选项超出范围",
    });
    // A rejected answer keeps the questionnaire open for a retry.
    expect(bridge.get("call-1")).toBeDefined();
  });

  it("refuses answers for unknown or malformed prompts", () => {
    const onQuestion = vi.fn();
    const bridge = new QuestionBridge({ onQuestion, onResolved: vi.fn() });
    const bus = createEventBus();
    bridge.bind(bus);

    bus.emit("rpiv:ask-user:prompt", { toolCallId: "bad" });
    expect(onQuestion).not.toHaveBeenCalled();
    expect(bridge.answer("bad", { cancel: true })).toMatchObject({ ok: false, code: "not_found" });
  });
});
