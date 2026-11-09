import { describe, expect, it } from "vitest";
import { normalizeChartOption } from "./chart-option";

describe("normalizeChartOption", () => {
  it("sorts category dates and formats ISO labels", () => {
    const option = normalizeChartOption({
      title: { text: "月度走势" },
      xAxis: { type: "category", data: ["2026-08", "2026-05", "2026-07"] },
      yAxis: { type: "value", name: "cnt" },
      series: [{ type: "line", name: "警情", data: [30, 20, 25] }],
    });

    expect(option?.title).toBeUndefined();
    expect((option?.xAxis as { data: string[] }).data).toEqual([
      "2026-05",
      "2026-07",
      "2026-08",
    ]);
    expect((option?.series as { data: number[] }[])[0]?.data).toEqual([20, 25, 30]);
    expect((option?.yAxis as { name: string }).name).toBe("");
    const label = (option?.xAxis as { axisLabel: { formatter: (v: string) => string } })
      .axisLabel;
    expect(label.formatter("2026-08")).toBe("8月");
  });

  it("drops the legend for a single series and keeps it for several", () => {
    const single = normalizeChartOption({
      legend: { show: true },
      series: [{ type: "bar", data: [1] }],
    });
    expect(single?.legend).toBeUndefined();

    const multi = normalizeChartOption({
      series: [{ type: "bar", data: [1] }, { type: "bar", data: [2] }],
    });
    expect((multi?.legend as { top: number }).top).toBe(4);
  });
});
