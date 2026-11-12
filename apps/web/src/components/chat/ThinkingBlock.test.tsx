import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThinkingBlock } from "./ThinkingBlock";

describe("ThinkingBlock", () => {
  it("starts expanded while running and follows the latest text", () => {
    const { rerender } = render(<ThinkingBlock thinking="第一步" running />);
    expect(screen.getByRole("button", { name: /思考过程/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByTestId("thinking-content")).toHaveTextContent("第一步");

    const content = screen.getByTestId("thinking-content");
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 480 });
    rerender(<ThinkingBlock thinking={"第一步\n第二步\n第三步"} running />);

    expect(content).toHaveTextContent("第三步");
    expect(content.scrollTop).toBe(480);
  });

  it("collapses automatically when the run finishes", () => {
    const { rerender } = render(<ThinkingBlock thinking="推理内容" running />);
    expect(screen.getByTestId("thinking-content")).toBeInTheDocument();

    rerender(<ThinkingBlock thinking="推理内容" running={false} />);

    expect(screen.getByRole("button", { name: /思考过程/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("thinking-content")).not.toBeInTheDocument();
  });

  it("lets the user collapse and reopen a live transcript", async () => {
    const user = userEvent.setup();
    render(<ThinkingBlock thinking="推理内容" running />);

    await user.click(screen.getByRole("button", { name: /思考过程/ }));
    expect(screen.queryByTestId("thinking-content")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /思考过程/ }));
    expect(screen.getByTestId("thinking-content")).toBeInTheDocument();
  });

  it("stays collapsed for a completed message", () => {
    render(<ThinkingBlock thinking="历史思考" />);
    expect(screen.queryByTestId("thinking-content")).not.toBeInTheDocument();
  });
});
