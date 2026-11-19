import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuggestedQuestions } from "./SuggestedQuestions";

describe("SuggestedQuestions", () => {
  it("renders suggestion pills and triggers select and dismiss callbacks", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDismiss = vi.fn();

    render(
      <SuggestedQuestions
        suggestions={["按品类拆解销售额", "对比上月变化"]}
        onSelect={onSelect}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("建议追问")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "按品类拆解销售额" }));
    expect(onSelect).toHaveBeenCalledWith("按品类拆解销售额");

    await user.click(screen.getByRole("button", { name: "隐藏建议问题" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when empty and disables buttons when disabled", () => {
    const { container, rerender } = render(
      <SuggestedQuestions
        suggestions={[]}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();

    rerender(
      <SuggestedQuestions
        suggestions={["查看明细分布"]}
        disabled
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "查看明细分布" })).toBeDisabled();
  });
});
