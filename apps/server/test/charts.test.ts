import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "../src/services/artifacts.js";
import {
  ChartError,
  OTHER_SLICE,
  buildChartOption,
  type ChartInput,
} from "../src/services/charts.js";

const xy: ColumnInfo[] = [
  { name: "x", type: "number" },
  { name: "y", type: "number" },
];

type SeriesShape = { name: string; type: string; data: unknown[]; areaStyle?: unknown };

function seriesOf(option: Record<string, unknown>): SeriesShape[] {
  return option.series as SeriesShape[];
}

function chart(overrides: Partial<ChartInput> = {}): ChartInput {
  return { type: "bar", x: "x", y: "y", ...overrides };
}

describe("buildChartOption", () => {
  it("aggregates by x and groups series while sorting numeric x ascending", () => {
    const columns: ColumnInfo[] = [...xy, { name: "series", type: "string" }];
    const { option, points } = buildChartOption({
      columns,
      rows: [
        [2, 10, "a"],
        [1, 5, "a"],
        [2, 7, "b"],
      ],
      chart: chart({ series: "series", aggregate: "sum" }),
    });

    expect(points).toBe(3);
    expect((option.xAxis as { data: string[] }).data).toEqual(["1", "2"]);
    const series = seriesOf(option);
    expect(series.map((item) => item.name)).toEqual(["a", "b"]);
    expect(series[0]!.data).toEqual([5, 10]);
    expect(series[1]!.data).toEqual([null, 7]);
    expect((option.tooltip as { trigger: string }).trigger).toBe("axis");
    expect(option.legend).toMatchObject({ type: "scroll" });
  });

  it("supports sum, avg, count, min and max", () => {
    const rows = [
      [1, 10],
      [1, 20],
      [1, 0],
    ];
    const expectations: Array<[ChartInput["aggregate"], number]> = [
      ["sum", 30],
      ["avg", 10],
      ["count", 3],
      ["min", 0],
      ["max", 20],
    ];
    for (const [aggregate, expected] of expectations) {
      const { option, points } = buildChartOption({
        columns: xy,
        rows,
        chart: chart({ aggregate }),
      });
      expect(points).toBe(1);
      expect(seriesOf(option)[0]!.data).toEqual([expected]);
    }
  });

  it("sorts date x values chronologically", () => {
    const columns: ColumnInfo[] = [
      { name: "day", type: "date" },
      { name: "y", type: "number" },
    ];
    const { option } = buildChartOption({
      columns,
      rows: [
        [new Date("2024-03-01T00:00:00Z"), 3],
        [new Date("2024-01-01T00:00:00Z"), 1],
        [new Date("2024-02-01T00:00:00Z"), 2],
      ],
      chart: chart({ x: "day", aggregate: "sum" }),
    });

    expect((option.xAxis as { data: string[] }).data).toEqual([
      "2024-01-01T00:00:00.000Z",
      "2024-02-01T00:00:00.000Z",
      "2024-03-01T00:00:00.000Z",
    ]);
    expect(seriesOf(option)[0]!.data).toEqual([1, 2, 3]);
  });

  it("keeps the top 20 pie slices and merges the rest into 其他", () => {
    const rows = Array.from({ length: 25 }, (_, index) => [index + 1, index + 1]);
    const { option, points } = buildChartOption({
      columns: xy,
      rows,
      chart: chart({ type: "pie", aggregate: "sum" }),
    });

    expect(points).toBe(21);
    expect(option.xAxis).toBeUndefined();
    const data = seriesOf(option)[0]!.data as Array<{ name: string; value: number }>;
    expect(data).toHaveLength(21);
    expect(data[0]).toEqual({ name: "25", value: 25 });
    expect(data[20]).toEqual({ name: OTHER_SLICE, value: 15 });
    expect((option.tooltip as { trigger: string }).trigger).toBe("item");
  });

  it("drops groups without numeric y instead of plotting 0 or ±Infinity", () => {
    const rows: unknown[][] = [
      ["a", 10],
      ["a", null],
      ["b", null],
    ];
    for (const aggregate of ["avg", "min", "max"] as const) {
      const { option, points, skipped } = buildChartOption({
        columns: xy,
        rows,
        chart: chart({ x: "x", aggregate }),
      });
      expect(points).toBe(1);
      expect(skipped).toBe(2);
      expect((option.xAxis as { data: string[] }).data).toEqual(["a"]);
      expect(seriesOf(option)[0]!.data).toEqual([10]);
      expect(JSON.stringify(option)).not.toContain("Infinity");
      expect(JSON.stringify(option)).not.toContain("null,");
    }
  });

  it("drops a single-row group with a null y when no aggregate is given", () => {
    const { option, points, skipped } = buildChartOption({
      columns: xy,
      rows: [
        ["a", 5],
        ["b", null],
      ],
      chart: chart({ x: "x" }),
    });
    expect(points).toBe(1);
    expect(skipped).toBe(1);
    expect((option.xAxis as { data: string[] }).data).toEqual(["a"]);
    expect(seriesOf(option)[0]!.data).toEqual([5]);
  });

  it("keeps sum/count groups whose y rows are all null", () => {
    const rows: unknown[][] = [
      [1, null],
      [2, 4],
    ];
    const sum = buildChartOption({ columns: xy, rows, chart: chart({ aggregate: "sum" }) });
    expect(sum.points).toBe(2);
    expect(seriesOf(sum.option)[0]!.data).toEqual([0, 4]);

    const count = buildChartOption({ columns: xy, rows, chart: chart({ aggregate: "count" }) });
    expect(count.points).toBe(2);
    expect(seriesOf(count.option)[0]!.data).toEqual([1, 1]);
  });

  it("counts only rendered scatter points and reports unparsable x rows as skipped", () => {
    const columns: ColumnInfo[] = [
      { name: "x", type: "string" },
      { name: "y", type: "number" },
    ];
    const { option, points, skipped } = buildChartOption({
      columns,
      rows: [
        ["1", 10],
        ["n/a", 20],
        ["n/a", null],
        ["3", null],
      ],
      chart: chart({ type: "scatter", x: "x", aggregate: "avg" }),
    });
    expect(points).toBe(1);
    expect(skipped).toBe(3);
    expect(seriesOf(option)[0]!.data).toEqual([[1, 10]]);
  });

  it("rejects more than 5000 points", () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => [index, 1]);
    expect(() =>
      buildChartOption({ columns: xy, rows, chart: chart({ aggregate: "sum" }) }),
    ).toThrowError(ChartError);
    try {
      buildChartOption({ columns: xy, rows, chart: chart({ aggregate: "sum" }) });
    } catch (error) {
      expect((error as ChartError).code).toBe("TOO_MANY_POINTS");
    }
  });

  it("rejects missing and duplicate columns", () => {
    expect(() =>
      buildChartOption({ columns: xy, rows: [[1, 2]], chart: chart({ x: "nope" }) }),
    ).toThrowError(/不存在/);

    const duplicated: ColumnInfo[] = [
      { name: "x", type: "number" },
      { name: "x", type: "string" },
      { name: "y", type: "number" },
    ];
    try {
      buildChartOption({ columns: duplicated, rows: [[1, "a", 2]], chart: chart() });
      throw new Error("expected ChartError");
    } catch (error) {
      expect(error).toBeInstanceOf(ChartError);
      expect((error as ChartError).code).toBe("COLUMN_NOT_FOUND");
    }
  });

  it("rejects a y column without numeric values", () => {
    const columns: ColumnInfo[] = [
      { name: "x", type: "string" },
      { name: "y", type: "string" },
    ];
    try {
      buildChartOption({
        columns,
        rows: [["a", "n/a"]],
        chart: chart({ x: "x", aggregate: "sum" }),
      });
      throw new Error("expected ChartError");
    } catch (error) {
      expect(error).toBeInstanceOf(ChartError);
      expect((error as ChartError).code).toBe("Y_NOT_NUMERIC");
    }
  });

  it("asks for an aggregate when a group has multiple rows", () => {
    try {
      buildChartOption({
        columns: xy,
        rows: [
          [1, 1],
          [1, 2],
        ],
        chart: chart(),
      });
      throw new Error("expected ChartError");
    } catch (error) {
      expect(error).toBeInstanceOf(ChartError);
      expect((error as ChartError).code).toBe("AGGREGATE_REQUIRED");
    }
  });

  it("returns an empty chart for empty input", () => {
    const { option, points } = buildChartOption({ columns: xy, rows: [], chart: chart() });
    expect(points).toBe(0);
    expect(seriesOf(option)[0]!.data).toEqual([]);
  });

  it("maps area and scatter to the ECharts shapes", () => {
    const rows = [
      [1, 2],
      [2, 3],
    ];
    const area = buildChartOption({ columns: xy, rows, chart: chart({ type: "area" }) });
    expect(seriesOf(area.option)[0]).toMatchObject({ type: "line", areaStyle: {} });

    const scatter = buildChartOption({ columns: xy, rows, chart: chart({ type: "scatter" }) });
    expect((scatter.option.xAxis as { type: string }).type).toBe("value");
    expect((scatter.option.tooltip as { trigger: string }).trigger).toBe("item");
    expect(seriesOf(scatter.option)[0]!.data).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });
});
