import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatResult } from "../../lib/api";
import { ResultsPanel } from "./ResultsPanel";

function makeResults(count: number): ChatResult[] {
  return Array.from({ length: count }, (_, index) => ({
    artifactId: `artifact-${index}`,
    columns: [{ name: "id", type: "number" }],
    rows: [[index]],
    rowCount: index + 1,
    truncated: false,
  })) as ChatResult[];
}

describe("ResultsPanel", () => {
  it("keeps up to three results as individual cards", () => {
    render(<ResultsPanel results={makeResults(3)} />);

    expect(screen.getByText("查询结果 1")).toBeInTheDocument();
    expect(screen.getByText("查询结果 3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /查询结果\s*3 个/ })).not.toBeInTheDocument();
  });

  it("collapses larger result sets and expands on demand", async () => {
    const user = userEvent.setup();
    render(<ResultsPanel results={makeResults(10)} />);

    const toggle = screen.getByRole("button", { name: /查询结果\s*10 个 · 共 55 行/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("查询结果 1")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("查询结果 1")).toBeInTheDocument();
    expect(screen.getByText("查询结果 10")).toBeInTheDocument();
  });
});
