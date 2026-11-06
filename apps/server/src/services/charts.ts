import type { ColumnInfo } from "./artifacts.js";

export type ChartType = "bar" | "line" | "area" | "pie" | "scatter";
export type ChartAggregate = "sum" | "avg" | "count" | "min" | "max";

export interface ChartInput {
  type: ChartType;
  x: string;
  y: string;
  series?: string;
  aggregate?: ChartAggregate;
  title?: string;
}

export class ChartError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChartError";
  }
}

/** Keep a single chart response bounded; the tool asks the model to filter first. */
export const MAX_CHART_POINTS = 5_000;
export const MAX_PIE_SLICES = 20;
export const OTHER_SLICE = "其他";

const NEUTRAL_COLORS = [
  "#4E79A7",
  "#F28E2B",
  "#E15759",
  "#76B7B2",
  "#59A14F",
  "#EDC948",
  "#B07AA1",
  "#FF9DA7",
  "#9C755F",
  "#BAB0AC",
];

interface Group {
  xKey: string;
  xLabel: string;
  xNumber: number | null;
  series: string | null;
  total: number;
  count: number;
  min: number;
  max: number;
  value: number;
  rows: number;
}

function columnIndex(columns: ColumnInfo[], name: string): number {
  const matches = columns
    .map((column, index) => ({ column, index }))
    .filter((entry) => entry.column.name === name);
  if (matches.length !== 1) {
    throw new ChartError("COLUMN_NOT_FOUND", `列「${name}」不存在，可用列：${columns.map((c) => c.name).join("、")}`);
  }
  return matches[0]!.index;
}

function dateValue(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function numericValue(value: unknown, type: ColumnInfo["type"]): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return dateValue(value);
  if (type === "date") return dateValue(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function labelOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function groupValue(group: Group, aggregate: ChartAggregate | undefined): number {
  switch (aggregate) {
    case "sum":
      return group.total;
    case "avg":
      return group.count === 0 ? 0 : group.total / group.count;
    case "count":
      return group.rows;
    case "min":
      return group.min;
    case "max":
      return group.max;
    case undefined:
      return group.value;
  }
}

/**
 * A group without any numeric y row has no meaningful avg/min/max (and no value at
 * all without an aggregate). Rendering it would show 0 or ±Infinity, so drop it
 * instead; `count` and `sum` stay valid for all-null groups.
 */
function hasPlottedValue(group: Group, aggregate: ChartAggregate | undefined): boolean {
  if (aggregate === "count" || aggregate === "sum") return true;
  return group.count > 0;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

/** Build an ECharts option plus the number of plotted points from artifact rows. */
export function buildChartOption(input: {
  rows: unknown[][];
  columns: ColumnInfo[];
  chart: ChartInput;
}): { option: Record<string, unknown>; points: number; skipped: number } {
  const { rows, columns, chart } = input;
  const xIndex = columnIndex(columns, chart.x);
  const yIndex = columnIndex(columns, chart.y);
  const seriesIndex = chart.series === undefined ? null : columnIndex(columns, chart.series);
  const xType = columns[xIndex]!.type;
  const isScatter = chart.type === "scatter";
  const isPie = chart.type === "pie";

  const groups = new Map<string, Group>();
  let numericRows = 0;
  let skipped = 0;
  let skippedY = 0;

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const xRaw = row[xIndex];
    if (xRaw === null || xRaw === undefined) {
      skipped += 1;
      continue;
    }
    const seriesRaw = seriesIndex === null ? null : row[seriesIndex];
    const seriesLabel = seriesRaw === null || seriesRaw === undefined ? "" : labelOf(seriesRaw);
    const xLabel = labelOf(xRaw);
    const key = `${xLabel}\u0000${seriesLabel}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        xKey: xLabel,
        xLabel,
        xNumber: numericValue(xRaw, xType),
        series: seriesIndex === null ? null : seriesLabel,
        total: 0,
        count: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        value: 0,
        rows: 0,
      };
      groups.set(key, group);
    }
    group.rows += 1;

    if (chart.aggregate === "count") continue;
    const yValue = numericValue(row[yIndex], columns[yIndex]!.type);
    if (yValue === null) {
      skipped += 1;
      skippedY += 1;
      continue;
    }
    numericRows += 1;
    group.total += yValue;
    group.count += 1;
    group.min = Math.min(group.min, yValue);
    group.max = Math.max(group.max, yValue);
    group.value = yValue;
  }

  if (rows.length > 0 && chart.aggregate !== "count" && numericRows === 0) {
    throw new ChartError(
      "Y_NOT_NUMERIC",
      skippedY > 0 ? `列「${chart.y}」没有可用的数值` : `列「${chart.y}」不是数值列`,
    );
  }

  if (chart.aggregate === undefined) {
    for (const group of groups.values()) {
      if (group.rows > 1) {
        throw new ChartError(
          "AGGREGATE_REQUIRED",
          `「${group.xLabel}」对应多条记录，请指定 aggregate（sum/avg/count/min/max）`,
        );
      }
    }
  }

  const sorted = [...groups.values()].filter((group) =>
    hasPlottedValue(group, chart.aggregate),
  );
  // Scatter points need a numeric x too; rows the plot cannot place are reported
  // as skipped instead of being counted as rendered points.
  if (isScatter) {
    for (const group of sorted) {
      if (group.xNumber === null) {
        // Rows with a null y are already counted above; only add rows that were
        // otherwise plottable. `count` does not parse y, so every row counts there.
        skipped += chart.aggregate === "count" ? group.rows : group.count;
      }
    }
  }
  const hasNumericX = sorted.length > 0 && sorted.every((group) => group.xNumber !== null);
  const sortByX = !isPie && hasNumericX && (xType === "number" || xType === "date");
  sorted.sort((left, right) => {
    if (sortByX) {
      const diff = (left.xNumber ?? 0) - (right.xNumber ?? 0);
      if (diff !== 0) return diff;
    } else {
      const diff = groupValue(right, chart.aggregate) - groupValue(left, chart.aggregate);
      if (diff !== 0) return diff;
    }
    return compareText(left.xLabel, right.xLabel) || compareText(left.series ?? "", right.series ?? "");
  });

  if (sorted.length > MAX_CHART_POINTS) {
    throw new ChartError(
      "TOO_MANY_POINTS",
      `聚合后有 ${sorted.length} 个数据点，超过 ${MAX_CHART_POINTS} 上限，请增加筛选条件或改用聚合`,
    );
  }

  const yName = chart.y;
  const title = chart.title?.trim() || yName;

  if (isPie) {
    const slices = sorted.map((group) => ({
      name: group.series ? `${group.xLabel} · ${group.series}` : group.xLabel,
      value: groupValue(group, chart.aggregate),
    }));
    const top = slices.slice(0, MAX_PIE_SLICES);
    const rest = slices.slice(MAX_PIE_SLICES);
    if (rest.length > 0) {
      top.push({
        name: OTHER_SLICE,
        value: rest.reduce((sum, slice) => sum + slice.value, 0),
      });
    }
    const option: Record<string, unknown> = {
      color: NEUTRAL_COLORS,
      tooltip: { trigger: "item" },
      legend: { top: 0 },
      series: [
        {
          name: title,
          type: "pie",
          radius: ["40%", "70%"],
          avoidLabelOverlap: true,
          data: top,
        },
      ],
    };
    if (chart.title?.trim()) option.title = { text: title, left: "center" };
    return { option, points: top.length, skipped };
  }

  const hasSeries = seriesIndex !== null;
  const categories = [...new Set(sorted.map((group) => group.xLabel))];
  const byKey = new Map(sorted.map((group) => [`${group.xKey}\u0000${group.series ?? ""}`, group]));
  // Without a series column the group key suffix is "", while the display name
  // is the chart title; keep them separate so lookups still match.
  const seriesNames = hasSeries
    ? [...new Set(sorted.map((group) => group.series ?? ""))]
    : [""];

  const series = seriesNames.map((name, index) => {
    let data: unknown[];
    if (isScatter) {
      data = sorted
        .filter((group) => (hasSeries ? (group.series ?? "") === name : true))
        .flatMap((group) => {
          if (group.xNumber === null) return [];
          return [[group.xNumber, groupValue(group, chart.aggregate)]];
        });
    } else {
      data = categories.map((category) => {
        const group = byKey.get(`${category}\u0000${name}`);
        return group ? groupValue(group, chart.aggregate) : null;
      });
    }
    return {
      name: hasSeries ? name || "（空）" : title,
      type: chart.type === "area" ? "line" : chart.type,
      ...(chart.type === "area" ? { areaStyle: {} } : {}),
      ...(isScatter ? {} : { smooth: chart.type === "line" }),
      data,
      itemStyle: { color: NEUTRAL_COLORS[index % NEUTRAL_COLORS.length] },
    };
  });

  const option: Record<string, unknown> = {
    color: NEUTRAL_COLORS,
    tooltip: { trigger: isScatter ? "item" : "axis" },
    grid: { left: 48, right: 24, top: hasSeries ? 56 : 32, bottom: 48, containLabel: true },
    xAxis: {
      type: isScatter ? "value" : "category",
      name: chart.x,
      ...(isScatter ? {} : { data: categories }),
      axisLabel: { rotate: categories.length > 12 ? 30 : 0 },
    },
    yAxis: { type: "value", name: chart.y },
    series,
  };
  if (hasSeries) {
    option.legend = { top: 0, type: "scroll" };
  }
  if (chart.title?.trim()) option.title = { text: title, left: "center" };

  const points = isScatter
    ? series.reduce((sum, item) => sum + item.data.length, 0)
    : sorted.length;
  return { option, points, skipped };
}
