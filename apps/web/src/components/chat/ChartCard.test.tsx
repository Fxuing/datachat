import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChartCard } from "./ChartCard";

vi.mock("./EChart", () => ({
  EChart: ({ height }: { height?: number }) => (
    <div data-testid="mock-echart" style={{ height }} />
  ),
}));

const sampleOption = {
  xAxis: { type: "category", name: "地区", data: ["华东", "华北", "华南"] },
  yAxis: { type: "value", name: "销售额" },
  series: [{ type: "bar", name: "销售额", data: [120, 300, 180] }],
};

describe("ChartCard interactive switching", () => {
  it("switches to table view, hides PNG download, and sorts columns client-side", async () => {
    const browser = userEvent.setup();
    render(<ChartCard title="各地区销售额" option={sampleOption} points={3} />);

    expect(screen.getByRole("button", { name: "柱状图" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "折线图" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "饼图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下载 PNG/ })).toBeInTheDocument();

    // Cycle chart sort order button.
    const sortButton = screen.getByRole("button", { name: "排序：默认" });
    await browser.click(sortButton);
    expect(screen.getByRole("button", { name: "排序：降序" })).toBeInTheDocument();

    // Switch to table view.
    await browser.click(screen.getByRole("button", { name: "明细表" }));
    expect(screen.getByRole("button", { name: "明细表" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /下载 PNG/ })).not.toBeInTheDocument();

    const rows = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));

    // Inherits the desc sort order applied before switching to table.
    expect(rows()).toEqual([
      ["华北", "300"],
      ["华南", "180"],
      ["华东", "120"],
    ]);

    // Click numeric header once (desc), twice (asc).
    const valueHeader = screen.getByRole("button", { name: "销售额" });
    await browser.click(valueHeader);
    expect(rows()).toEqual([
      ["华北", "300"],
      ["华南", "180"],
      ["华东", "120"],
    ]);
    await browser.click(valueHeader);
    expect(rows()).toEqual([
      ["华东", "120"],
      ["华南", "180"],
      ["华北", "300"],
    ]);
  });
});
