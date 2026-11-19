import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuestionCard } from "./QuestionCard";

const { answerQuestion } = vi.hoisted(() => ({
  answerQuestion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  answerQuestion,
}));

const questions = [
  {
    question: "要查哪个库？",
    header: "数据源",
    multiSelect: false,
    options: [
      { label: "订单库", description: "只读副本", hasPreview: false },
      { label: "用户库", description: "", hasPreview: false },
    ],
  },
  {
    question: "需要哪些指标？",
    header: "指标",
    multiSelect: true,
    options: [
      { label: "GMV", description: "", hasPreview: false },
      { label: "订单数", description: "", hasPreview: false },
    ],
  },
];

describe("QuestionCard", () => {
  beforeEach(() => {
    answerQuestion.mockClear();
  });

  it("collects one answer per question and submits them together", async () => {
    const user = userEvent.setup();
    render(<QuestionCard conversationId="c1" toolCallId="call-1" questions={questions} />);

    await user.click(screen.getByRole("button", { name: /订单库/ }));
    await user.click(screen.getByRole("button", { name: "指标" }));
    await user.click(screen.getByRole("button", { name: /GMV/ }));
    await user.click(screen.getByRole("button", { name: /订单数/ }));
    await user.click(screen.getByRole("button", { name: /提交回答/ }));

    expect(answerQuestion).toHaveBeenCalledWith("c1", "call-1", {
      answers: [
        { questionIndex: 0, optionIndexes: [0] },
        { questionIndex: 1, optionIndexes: [0, 1] },
      ],
    });
  });

  it("accepts typed answers and keeps the submit disabled until every question is answered", async () => {
    const user = userEvent.setup();
    render(<QuestionCard conversationId="c1" toolCallId="call-2" questions={questions} />);

    const submit = screen.getByRole("button", { name: /提交回答/ });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/其他答案或补充说明/), "用只读账号查 orders");
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "指标" }));
    await user.type(screen.getByLabelText(/其他答案或补充说明/), "按天");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(answerQuestion).toHaveBeenCalledWith("c1", "call-2", {
      answers: [
        { questionIndex: 0, text: "用只读账号查 orders" },
        { questionIndex: 1, text: "按天" },
      ],
    });
  });

  it("cancels the questionnaire", async () => {
    const user = userEvent.setup();
    render(<QuestionCard conversationId="c1" toolCallId="call-3" questions={questions} />);

    await user.click(screen.getByRole("button", { name: /取消/ }));
    expect(answerQuestion).toHaveBeenCalledWith("c1", "call-3", { cancel: true });
  });

  it("navigates across multiple questions using previous and next buttons", async () => {
    const user = userEvent.setup();
    render(<QuestionCard conversationId="c1" toolCallId="call-4" questions={questions} />);

    const prev = screen.getByRole("button", { name: "上一题" });
    const next = screen.getByRole("button", { name: "下一题" });
    expect(prev).toBeDisabled();
    expect(next).toBeEnabled();
    expect(screen.getByText("要查哪个库？")).toBeInTheDocument();

    await user.click(next);
    expect(screen.getByText("需要哪些指标？")).toBeInTheDocument();
    expect(prev).toBeEnabled();
    expect(next).toBeDisabled();

    await user.click(prev);
    expect(screen.getByText("要查哪个库？")).toBeInTheDocument();
  });
});
