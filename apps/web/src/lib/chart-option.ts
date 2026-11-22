import type { ChartOption } from "../components/chat/EChart";

type Axis = Record<string, unknown>;
type Series = Record<string, unknown>;

export type ChartVisualMode = "bar" | "line" | "area" | "pie" | "scatter";
export type ChartViewMode = ChartVisualMode | "table";
export type ChartSortOrder = "default" | "desc" | "asc";

export interface ChartTableColumn {
  label: string;
  numeric?: boolean;
  percent?: boolean;
}

export interface ChartTableData {
  columns: ChartTableColumn[];
  rows: (string | number | null)[][];
}

const DATE_LABEL = /^\d{4}-\d{2}(-\d{2})?([T ].*)?$/;
const MACHINE_NAME = /^[a-z][a-z0-9_]*$/i;
const MAX_PIE_SLICES = 20;
const OTHER_SLICE = "其他";

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function categories(axis: Axis): string[] | null {
  if (axis.type !== "category" || !Array.isArray(axis.data)) return null;
  const data = axis.data;
  if (data.length < 2 || !data.every((item) => typeof item === "string")) return null;
  const values = data as string[];
  return values.every((value) => DATE_LABEL.test(value)) ? values : null;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function extractNumber(datum: unknown): number | null {
  if (typeof datum === "number") return Number.isFinite(datum) ? datum : null;
  if (datum && typeof datum === "object" && !Array.isArray(datum)) {
    const val = (datum as Record<string, unknown>).value;
    if (typeof val === "number") return Number.isFinite(val) ? val : null;
  }
  return null;
}

function formatDateAxis(axis: Axis, values: string[]): Axis {
  const sameYear = new Set(values.map((value) => value.slice(0, 4))).size === 1;
  const withTime = values.some((value) => value.includes("T"));
  const formatter = (raw: unknown): string => {
    const value = String(raw);
    if (withTime) return sameYear ? value.slice(5, 10) : value.slice(0, 10);
    if (/^\d{4}-\d{2}$/.test(value)) {
      return sameYear ? `${Number(value.slice(5, 7))}月` : value;
    }
    return value;
  };
  return {
    ...axis,
    axisLabel: {
      ...(axis.axisLabel as object | undefined),
      rotate: 0,
      hideOverlap: true,
      formatter,
    },
  };
}

/** Reorder a category axis (and aligned series data) chronologically. */
function sortByDate(
  axis: Axis,
  series: Series[],
  preserveOrder = false,
): { axis: Axis; series: Series[] } {
  const values = categories(axis);
  if (!values) return { axis, series };

  if (preserveOrder) {
    return { axis: formatDateAxis(axis, values), series };
  }

  const sorted = [...values].sort((a, b) => timestamp(a) - timestamp(b));
  const changed = sorted.some((value, index) => value !== values[index]);
  const position = new Map(values.map((value, index) => [value, index]));
  const order = sorted.map((value) => position.get(value) ?? 0);

  const nextAxis: Axis = {
    ...formatDateAxis(axis, values),
    ...(changed ? { data: sorted } : {}),
  };

  const nextSeries = series.map((entry) => {
    if (!Array.isArray(entry.data)) return entry;
    const data = entry.data as unknown[];
    const pointsByDate = data.every((item) => Array.isArray(item));
    const nextData = pointsByDate
      ? order.map((index) => data[index])
      : changed
        ? order.map((index) => data[index])
        : data;
    return { ...entry, data: nextData };
  });

  return { axis: nextAxis, series: nextSeries };
}

function normalizeInternal(
  option: ChartOption | null | undefined,
  preserveCategoryOrder: boolean,
): ChartOption | null {
  if (!option) return null;
  const next: ChartOption = { ...option };
  delete next.title;

  const rawSeries = asArray(option.series as Series | Series[] | undefined);
  const axes = asArray(option.xAxis as Axis | Axis[] | undefined);

  const sorted = axes.map((axis) => sortByDate(axis, rawSeries, preserveCategoryOrder));
  const mergedSeries = sorted[0]?.series ?? rawSeries;

  if (axes.length > 0) {
    next.xAxis = Array.isArray(option.xAxis)
      ? sorted.map((entry) => entry.axis)
      : sorted[0]?.axis;
  }
  if (rawSeries.length > 0) next.series = mergedSeries;

  const isPie = rawSeries[0]?.type === "pie";
  if (rawSeries.length > 1 || isPie) {
    next.legend = { ...(option.legend as object | undefined), top: 4 };
  } else {
    delete next.legend;
  }

  if (!isPie) {
    next.grid = {
      left: 12,
      right: 20,
      bottom: 12,
      top: rawSeries.length > 1 ? 44 : 20,
      containLabel: true,
      ...(option.grid as object | undefined),
    };
  }

  const stripName = (axis: Axis): Axis => {
    if (typeof axis.name !== "string" || !MACHINE_NAME.test(axis.name)) return axis;
    return { ...axis, name: "" };
  };
  if (option.yAxis) {
    next.yAxis = Array.isArray(option.yAxis)
      ? (option.yAxis as Axis[]).map(stripName)
      : stripName(option.yAxis as Axis);
  }
  if (next.xAxis) {
    next.xAxis = Array.isArray(next.xAxis)
      ? (next.xAxis as Axis[]).map(stripName)
      : stripName(next.xAxis as Axis);
  }

  return next;
}

/**
 * Presentation tweaks for model-generated chart specs:
 * the card already prints the title, single series need no legend, dates should
 * read chronologically and raw ISO timestamps are unreadable on an axis.
 */
export function normalizeChartOption(option: ChartOption | null | undefined): ChartOption | null {
  return normalizeInternal(option, false);
}

/** Detect the base visual chart type from a persisted ECharts option. */
export function detectChartBaseMode(
  option: ChartOption | null | undefined,
): ChartVisualMode | null {
  if (!option) return null;
  const series = asArray(option.series as Series | Series[] | undefined);
  const first = series[0];
  if (!first || typeof first !== "object") return null;
  if (first.type === "pie") return "pie";
  if (first.type === "scatter") return "scatter";
  if (first.type === "line") {
    return first.areaStyle !== undefined && first.areaStyle !== null ? "area" : "line";
  }
  if (first.type === "bar") return "bar";
  return null;
}

interface PieSlice {
  name: string;
  value: number;
}

function extractPieSlices(series: Series | undefined): PieSlice[] {
  if (!series || !Array.isArray(series.data)) return [];
  const slices: PieSlice[] = [];
  for (const item of series.data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const value = extractNumber(record.value);
    if (value === null) continue;
    const name = typeof record.name === "string" ? record.name : String(record.name ?? "");
    slices.push({ name, value });
  }
  return slices;
}

function getPrimaryCategoryAxis(option: ChartOption): Axis | null {
  const axes = asArray(option.xAxis as Axis | Axis[] | undefined);
  const first = axes[0];
  if (!first || first.type !== "category" || !Array.isArray(first.data)) return null;
  return first;
}

/** Determine which interactive view modes are valid for the given chart option. */
export function availableChartModes(option: ChartOption | null | undefined): ChartViewMode[] {
  if (!option) return [];
  const base = detectChartBaseMode(option);
  if (!base) return [];
  const series = asArray(option.series as Series | Series[] | undefined);

  if (base === "scatter") {
    const hasPoints = series.some(
      (entry) =>
        Array.isArray(entry.data) &&
        entry.data.some((point) => Array.isArray(point) && point.length >= 2),
    );
    return hasPoints ? ["scatter", "table"] : [];
  }

  if (base === "pie") {
    return extractPieSlices(series[0]).length > 0 ? ["pie", "bar", "line", "area", "table"] : [];
  }

  const xAxis = getPrimaryCategoryAxis(option);
  if (!xAxis || !Array.isArray(xAxis.data) || xAxis.data.length === 0) return [];

  const modes: ChartViewMode[] = ["bar", "line", "area"];
  if (series.length === 1 && Array.isArray(series[0]?.data)) {
    const values = (series[0]!.data as unknown[])
      .map(extractNumber)
      .filter((value): value is number => value !== null);
    if (values.length > 0 && values.every((value) => value >= 0) && values.some((value) => value > 0)) {
      modes.push("pie");
    }
  }
  modes.push("table");
  return modes;
}

function sortOrderIndices(
  length: number,
  series: Series[],
  order: Exclude<ChartSortOrder, "default">,
): number[] {
  const scores = Array.from({ length }, (_, index) => {
    let total = 0;
    let hasValue = false;
    for (const entry of series) {
      if (!Array.isArray(entry.data)) continue;
      const value = extractNumber(entry.data[index]);
      if (value !== null) {
        total += value;
        hasValue = true;
      }
    }
    return { index, value: hasValue ? total : null };
  });

  scores.sort((left, right) => {
    if (left.value === null && right.value === null) return left.index - right.index;
    if (left.value === null) return 1;
    if (right.value === null) return -1;
    const diff = order === "desc" ? right.value - left.value : left.value - right.value;
    return diff !== 0 ? diff : left.index - right.index;
  });

  return scores.map((item) => item.index);
}

function applyCategorySeriesStyle(entry: Series, targetMode: "bar" | "line" | "area"): Series {
  const next: Series = { ...entry };
  delete next.areaStyle;
  delete next.smooth;
  if (targetMode === "bar") {
    next.type = "bar";
  } else if (targetMode === "line") {
    next.type = "line";
    next.smooth = true;
  } else {
    next.type = "line";
    next.areaStyle = {};
    next.smooth = false;
  }
  return next;
}

function capPieSlices(slices: PieSlice[]): PieSlice[] {
  if (slices.length <= MAX_PIE_SLICES) return slices;
  const top = slices.slice(0, MAX_PIE_SLICES);
  const rest = slices.slice(MAX_PIE_SLICES);
  top.push({
    name: OTHER_SLICE,
    value: rest.reduce((sum, slice) => sum + slice.value, 0),
  });
  return top;
}

/**
 * Transform an existing chart option into another visual type and/or sort order
 * entirely on the client without re-running the LLM or re-querying the database.
 */
export function transformChartOption(
  option: ChartOption | null | undefined,
  targetMode: ChartVisualMode,
  sortOrder: ChartSortOrder = "default",
): ChartOption | null {
  if (!option) return null;
  const base = detectChartBaseMode(option);
  if (!base || base === "scatter") return normalizeChartOption(option);

  const rawSeries = asArray(option.series as Series | Series[] | undefined);

  if (base === "pie") {
    const rawSlices = extractPieSlices(rawSeries[0]);
    const orderedSlices =
      sortOrder === "default"
        ? rawSlices
        : [...rawSlices].sort((left, right) =>
            sortOrder === "desc" ? right.value - left.value : left.value - right.value,
          );
    const seriesName =
      typeof rawSeries[0]?.name === "string" && rawSeries[0].name.trim()
        ? rawSeries[0].name
        : "数值";

    if (targetMode === "pie") {
      return normalizeInternal(
        {
          ...option,
          series: [{ ...rawSeries[0], type: "pie", data: orderedSlices }],
        },
        true,
      );
    }

    if (targetMode === "bar" || targetMode === "line" || targetMode === "area") {
      const converted: ChartOption = {
        ...(option.color ? { color: option.color } : {}),
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: orderedSlices.map((slice) => slice.name),
          axisLabel: { rotate: orderedSlices.length > 12 ? 30 : 0 },
        },
        yAxis: { type: "value" },
        series: [
          applyCategorySeriesStyle(
            {
              name: seriesName,
              data: orderedSlices.map((slice) => slice.value),
            },
            targetMode,
          ),
        ],
      };
      return normalizeInternal(converted, sortOrder !== "default");
    }
    return normalizeChartOption(option);
  }

  // Category-based charts (bar / line / area)
  const normalized = normalizeChartOption(option);
  if (!normalized) return null;
  const xAxis = getPrimaryCategoryAxis(normalized);
  const series = asArray(normalized.series as Series | Series[] | undefined);
  if (!xAxis || !Array.isArray(xAxis.data) || series.length === 0) return normalized;

  const labels = xAxis.data.map((value) => String(value ?? ""));

  if (targetMode === "pie") {
    const firstSeries = series[0]!;
    const seriesData = Array.isArray(firstSeries.data) ? firstSeries.data : [];
    const slices: PieSlice[] = [];
    for (let index = 0; index < labels.length; index += 1) {
      const value = extractNumber(seriesData[index]);
      if (value === null || value < 0) continue;
      slices.push({ name: labels[index] ?? "", value });
    }
    const effectiveOrder = sortOrder === "asc" ? "asc" : "desc";
    slices.sort((left, right) =>
      effectiveOrder === "desc" ? right.value - left.value : left.value - right.value,
    );
    const capped = capPieSlices(slices);
    const seriesName =
      typeof firstSeries.name === "string" && firstSeries.name.trim()
        ? firstSeries.name
        : "数值";
    return {
      ...(normalized.color ? { color: normalized.color } : {}),
      tooltip: { trigger: "item" },
      legend: { top: 4, type: "scroll" },
      series: [
        {
          name: seriesName,
          type: "pie",
          radius: ["40%", "70%"],
          avoidLabelOverlap: true,
          data: capped,
        },
      ],
    };
  }

  if (targetMode === "bar" || targetMode === "line" || targetMode === "area") {
    let nextAxis: Axis = xAxis;
    let nextSeries = series;

    if (sortOrder !== "default") {
      const order = sortOrderIndices(labels.length, series, sortOrder);
      nextAxis = {
        ...xAxis,
        data: order.map((index) => (xAxis.data as unknown[])[index]),
      };
      nextSeries = series.map((entry) => {
        if (!Array.isArray(entry.data)) return entry;
        const data = entry.data as unknown[];
        return { ...entry, data: order.map((index) => data[index]) };
      });
    }

    const styledSeries = nextSeries.map((entry) => applyCategorySeriesStyle(entry, targetMode));
    return {
      ...normalized,
      xAxis: Array.isArray(normalized.xAxis)
        ? [nextAxis, ...(normalized.xAxis as Axis[]).slice(1)]
        : nextAxis,
      series: styledSeries,
    };
  }

  return normalized;
}

function readableAxisName(axis: Axis | undefined, fallback: string): string {
  if (!axis || typeof axis.name !== "string") return fallback;
  const trimmed = axis.name.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Extract structured tabular rows from an ECharts option for inline table inspection. */
export function extractChartTable(
  option: ChartOption | null | undefined,
  sortOrder: ChartSortOrder = "default",
): ChartTableData | null {
  if (!option) return null;
  const base = detectChartBaseMode(option);
  if (!base) return null;

  const rawAxes = asArray(option.xAxis as Axis | Axis[] | undefined);
  const rawYAxes = asArray(option.yAxis as Axis | Axis[] | undefined);
  const rawSeries = asArray(option.series as Series | Series[] | undefined);

  if (base === "pie") {
    const slices = extractPieSlices(rawSeries[0]);
    if (slices.length === 0) return null;
    const ordered =
      sortOrder === "default"
        ? slices
        : [...slices].sort((left, right) =>
            sortOrder === "desc" ? right.value - left.value : left.value - right.value,
          );
    const total = ordered.reduce((sum, slice) => sum + (slice.value > 0 ? slice.value : 0), 0);
    const valueLabel =
      typeof rawSeries[0]?.name === "string" && rawSeries[0].name.trim()
        ? rawSeries[0].name
        : "数值";
    return {
      columns: [
        { label: "类别" },
        { label: valueLabel, numeric: true },
        { label: "占比", numeric: true, percent: true },
      ],
      rows: ordered.map((slice) => [
        slice.name,
        slice.value,
        total > 0 ? slice.value / total : null,
      ]),
    };
  }

  if (base === "scatter") {
    const xLabel = readableAxisName(rawAxes[0], "X");
    const yLabel = readableAxisName(rawYAxes[0], "Y");
    const multiSeries = rawSeries.length > 1;
    const rows: (string | number | null)[][] = [];
    for (let index = 0; index < rawSeries.length; index += 1) {
      const entry = rawSeries[index]!;
      if (!Array.isArray(entry.data)) continue;
      const seriesName =
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name
          : `系列 ${index + 1}`;
      for (const point of entry.data) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const xVal = extractNumber(point[0]);
        const yVal = extractNumber(point[1]);
        rows.push(multiSeries ? [seriesName, xVal, yVal] : [xVal, yVal]);
      }
    }
    if (rows.length === 0) return null;
    return {
      columns: multiSeries
        ? [
            { label: "系列" },
            { label: xLabel, numeric: true },
            { label: yLabel, numeric: true },
          ]
        : [
            { label: xLabel, numeric: true },
            { label: yLabel, numeric: true },
          ],
      rows,
    };
  }

  // Category-based charts: apply normalized chronological ordering first, then optional sortOrder.
  const normalized = normalizeChartOption(option);
  if (!normalized) return null;
  const xAxis = getPrimaryCategoryAxis(normalized);
  const series = asArray(normalized.series as Series | Series[] | undefined);
  if (!xAxis || !Array.isArray(xAxis.data) || series.length === 0) return null;

  const labels = xAxis.data.map((value) => String(value ?? ""));
  const order =
    sortOrder === "default"
      ? labels.map((_, index) => index)
      : sortOrderIndices(labels.length, series, sortOrder);

  const xLabel = readableAxisName(rawAxes[0], "类别");
  const valueColumns: ChartTableColumn[] =
    series.length === 1
      ? [
          {
            label:
              readableAxisName(rawYAxes[0], "") ||
              (typeof series[0]?.name === "string" && series[0].name.trim()
                ? series[0].name
                : "数值"),
            numeric: true,
          },
        ]
      : series.map((entry, index) => ({
          label:
            typeof entry.name === "string" && entry.name.trim()
              ? entry.name
              : `系列 ${index + 1}`,
          numeric: true,
        }));

  const rows: (string | number | null)[][] = order.map((rowIndex) => [
    labels[rowIndex] ?? "",
    ...series.map((entry) =>
      Array.isArray(entry.data) ? extractNumber(entry.data[rowIndex]) : null,
    ),
  ]);

  return {
    columns: [{ label: xLabel }, ...valueColumns],
    rows,
  };
}
