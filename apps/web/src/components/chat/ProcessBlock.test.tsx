import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProcessBlock } from "./ProcessBlock";

describe("ProcessBlock", () => {
  it("starts collapsed and expands on click", async () => {
    const user = userEvent.setup();
    render(
      <ProcessBlock
        thinking="先看表结构"
        toolCount={2}
        sqlCount={1}
        tools={<p>tool details</p>}
      />,
    );

    expect(screen.getByText("执行过程")).toBeInTheDocument();
    expect(screen.getByText("3 个步骤")).toBeInTheDocument();
    expect(screen.queryByText("先看表结构")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /执行过程/ }));

    expect(screen.getByText("先看表结构")).toBeInTheDocument();
    expect(screen.getByText("tool details")).toBeInTheDocument();
  });

  it("is open while a run is in progress", () => {
    render(<ProcessBlock running thinking="正在思考" toolCount={0} />);
    expect(screen.getByText("正在思考")).toBeInTheDocument();
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });
});
