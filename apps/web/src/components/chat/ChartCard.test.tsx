import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChartCard } from "./ChartCard";

vi.mock("./EChart", () => ({
  EChart: ({
    height,
    onPointClick,
  }: {
    height?: number;
    onPointClick?: (point: { name: string; seriesName?: string; value?: number }) => void;
  }) => (
    <div
      data-testid="mock-echart"
      style={{ height }}
      onClick={() => onPointClick?.({ name: "华北", seriesName: "销售额", value: 300 })}
    />
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

  it("triggers onDrillDown when clicking a plotted chart point or table row", async () => {
    const browser = userEvent.setup();
    const onDrillDown = vi.fn();
    render(
      <ChartCard
        title="各地区销售额"
        option={sampleOption}
        points={3}
        onDrillDown={onDrillDown}
      />,
    );

    expect(screen.getByText(/点击数据点下钻追问/)).toBeInTheDocument();
    await browser.click(await screen.findByTestId("mock-echart"));
    expect(onDrillDown).toHaveBeenCalledWith({
      title: "各地区销售额",
      category: "华北",
      seriesName: "销售额",
      value: 300,
    });

    // Also works in table view by clicking a row.
    await browser.click(screen.getByRole("button", { name: "明细表" }));
    await browser.click(screen.getByText("华东"));
    expect(onDrillDown).toHaveBeenLastCalledWith({
      title: "各地区销售额",
      category: "华东",
      seriesName: "销售额",
      value: 120,
    });
  });
});
