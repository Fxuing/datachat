import { describe, expect, it } from "vitest";
import {
  availableChartModes,
  detectChartBaseMode,
  extractChartTable,
  normalizeChartOption,
  transformChartOption,
} from "./chart-option";

describe("normalizeChartOption", () => {
  it("sorts category dates and formats ISO labels", () => {
    const option = normalizeChartOption({
      title: { text: "月度走势" },
      xAxis: { type: "category", data: ["2026-08", "2026-05", "2026-07"] },
      yAxis: { type: "value", name: "cnt" },
      series: [{ type: "line", name: "数量", data: [30, 20, 25] }],
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

describe("chart view mode detection and transforms", () => {
  const barOption = {
    xAxis: { type: "category", name: "region", data: ["华东", "华北", "华南"] },
    yAxis: { type: "value", name: "gmv" },
    series: [{ type: "bar", name: "GMV", data: [120, 300, 180] }],
  };

  it("detects base modes and valid switch targets", () => {
    expect(detectChartBaseMode(barOption)).toBe("bar");
    expect(availableChartModes(barOption)).toEqual(["bar", "line", "area", "pie", "table"]);

    // Negative values disqualify pie conversion.
    const withNegative = {
      ...barOption,
      series: [{ type: "bar", name: "利润", data: [120, -30, 80] }],
    };
    expect(availableChartModes(withNegative)).toEqual(["bar", "line", "area", "table"]);

    // Multi-series disqualifies pie conversion.
    const multiSeries = {
      ...barOption,
      series: [
        { type: "line", name: "2025", data: [10, 20, 30] },
        { type: "line", name: "2026", data: [15, 25, 35] },
      ],
    };
    expect(availableChartModes(multiSeries)).toEqual(["bar", "line", "area", "table"]);

    // Area chart detection.
    const areaOption = {
      ...barOption,
      series: [{ type: "line", areaStyle: {}, name: "GMV", data: [120, 300, 180] }],
    };
    expect(detectChartBaseMode(areaOption)).toBe("area");

    // Scatter allows only scatter and table.
    const scatterOption = {
      xAxis: { type: "value", name: "单价" },
      yAxis: { type: "value", name: "销量" },
      series: [{ type: "scatter", name: "商品", data: [[10, 50], [20, 30]] }],
    };
    expect(detectChartBaseMode(scatterOption)).toBe("scatter");
    expect(availableChartModes(scatterOption)).toEqual(["scatter", "table"]);
  });

  it("transforms bar chart to line, area, pie and applies sort order", () => {
    const line = transformChartOption(barOption, "line", "desc");
    expect((line?.xAxis as { data: string[] }).data).toEqual(["华北", "华南", "华东"]);
    const lineSeries = (line?.series as { type: string; smooth?: boolean; data: number[] }[])[0]!;
    expect(lineSeries.type).toBe("line");
    expect(lineSeries.smooth).toBe(true);
    expect(lineSeries.data).toEqual([300, 180, 120]);

    const area = transformChartOption(barOption, "area", "asc");
    expect((area?.xAxis as { data: string[] }).data).toEqual(["华东", "华南", "华北"]);
    const areaSeries = (area?.series as { type: string; areaStyle?: object; data: number[] }[])[0]!;
    expect(areaSeries.type).toBe("line");
    expect(areaSeries.areaStyle).toEqual({});
    expect(areaSeries.data).toEqual([120, 180, 300]);

    const pie = transformChartOption(barOption, "pie", "default");
    const pieSeries = (pie?.series as { type: string; data: { name: string; value: number }[] }[])[0]!;
    expect(pieSeries.type).toBe("pie");
    expect(pieSeries.data).toEqual([
      { name: "华北", value: 300 },
      { name: "华南", value: 180 },
      { name: "华东", value: 120 },
    ]);
  });

  it("converts pie charts to bar charts and preserves sort order", () => {
    const pieOption = {
      series: [
        {
          type: "pie",
          name: "占比",
          data: [
            { name: "A", value: 40 },
            { name: "B", value: 60 },
          ],
        },
      ],
    };
    expect(availableChartModes(pieOption)).toEqual(["pie", "bar", "line", "area", "table"]);

    const bar = transformChartOption(pieOption, "bar", "desc");
    expect((bar?.xAxis as { data: string[] }).data).toEqual(["B", "A"]);
    expect((bar?.series as { type: string; data: number[] }[])[0]).toMatchObject({
      type: "bar",
      data: [60, 40],
    });
  });

  it("extracts table rows for category, pie and scatter charts", () => {
    const catTable = extractChartTable(barOption, "desc");
    expect(catTable?.columns.map((c) => c.label)).toEqual(["region", "gmv"]);
    expect(catTable?.rows).toEqual([
      ["华北", 300],
      ["华南", 180],
      ["华东", 120],
    ]);

    const pieTable = extractChartTable({
      series: [
        {
          type: "pie",
          name: "销售额",
          data: [
            { name: "自营", value: 75 },
            { name: "分销", value: 25 },
          ],
        },
      ],
    });
    expect(pieTable?.columns.map((c) => c.label)).toEqual(["类别", "销售额", "占比"]);
    expect(pieTable?.rows).toEqual([
      ["自营", 75, 0.75],
      ["分销", 25, 0.25],
    ]);

    const scatterTable = extractChartTable({
      xAxis: { type: "value", name: "价格" },
      yAxis: { type: "value", name: "复购率" },
      series: [{ type: "scatter", name: "品类", data: [[100, 0.4]] }],
    });
    expect(scatterTable?.columns.map((c) => c.label)).toEqual(["价格", "复购率"]);
    expect(scatterTable?.rows).toEqual([[100, 0.4]]);
  });
});
