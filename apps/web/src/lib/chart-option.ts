import type { ChartOption } from "../components/chat/EChart";

type Axis = Record<string, unknown>;
type Series = Record<string, unknown>;

const DATE_LABEL = /^\d{4}-\d{2}(-\d{2})?([T ].*)?$/;
const MACHINE_NAME = /^[a-z][a-z0-9_]*$/i;

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

/** Reorder a category axis (and aligned series data) chronologically. */
function sortByDate(axis: Axis, series: Series[]): { axis: Axis; series: Series[] } {
  const values = categories(axis);
  if (!values) return { axis, series };

  const sorted = [...values].sort((a, b) => timestamp(a) - timestamp(b));
  const changed = sorted.some((value, index) => value !== values[index]);
  const position = new Map(values.map((value, index) => [value, index]));
  const order = sorted.map((value) => position.get(value) ?? 0);

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

  const nextAxis: Axis = {
    ...axis,
    ...(changed ? { data: sorted } : {}),
    axisLabel: {
      ...(axis.axisLabel as object | undefined),
      rotate: 0,
      hideOverlap: true,
      formatter,
    },
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

/**
 * Presentation tweaks for model-generated chart specs:
 * the card already prints the title, single series need no legend, dates should
 * read chronologically and raw ISO timestamps are unreadable on an axis.
 */
export function normalizeChartOption(option: ChartOption | null | undefined): ChartOption | null {
  if (!option) return null;
  const next: ChartOption = { ...option };
  delete next.title;

  const rawSeries = asArray(option.series as Series | Series[] | undefined);
  const axes = asArray(option.xAxis as Axis | Axis[] | undefined);

  const sorted = axes.map((axis) => sortByDate(axis, rawSeries));
  const mergedSeries = sorted[0]?.series ?? rawSeries;

  if (axes.length > 0) {
    next.xAxis = Array.isArray(option.xAxis)
      ? sorted.map((entry) => entry.axis)
      : sorted[0]?.axis;
  }
  if (rawSeries.length > 0) next.series = mergedSeries;

  if (rawSeries.length > 1) {
    next.legend = { ...(option.legend as object | undefined), top: 4 };
  } else {
    delete next.legend;
  }

  next.grid = {
    left: 12,
    right: 20,
    bottom: 12,
    top: rawSeries.length > 1 ? 44 : 20,
    containLabel: true,
    ...(option.grid as object | undefined),
  };

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
