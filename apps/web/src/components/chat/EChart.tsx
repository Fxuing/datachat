import { useEffect, useMemo, useRef, useState } from "react";
import { init, use as setupECharts, type EChartsType } from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import {
  registerChartExporter,
  type ChartExportSnapshot,
} from "../../lib/chart-export-registry";
import { useTheme, type Theme } from "../../lib/theme";
import { cn } from "../../lib/utils";

// Only the chart types and components the server-side engine emits are bundled.
setupECharts([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export type ChartOption = Record<string, unknown>;

export interface EChartClickPoint {
  name: string;
  seriesName?: string;
  value?: string | number | null;
}

export interface EChartProps {
  option: ChartOption | null | undefined;
  className?: string;
  ariaLabel?: string;
  /** Receives the instance once it is ready; called with null after disposal. */
  onReady?: (instance: EChartsType | null) => void;
  /** Called when the user clicks a plotted series data point. */
  onPointClick?: (point: EChartClickPoint) => void;
}

function isEmptyOption(option: ChartOption | null | undefined): boolean {
  return !option || Object.keys(option).length === 0;
}

type AxisLike = Record<string, unknown>;

/**
 * The option is produced server-side without any theme. Paint it with the
 * current app tokens so axes/legend stay readable on both backgrounds.
 */
function withChartTheme(option: ChartOption, theme: Theme): ChartOption {
  const dark = theme === "dark";
  const ink = dark ? "#d4d4d8" : "#3f3f46";
  const line = dark ? "#2a2a32" : "#e4e4e7";
  const tooltipBg = dark ? "#121216" : "#ffffff";

  const styleAxis = (axis: unknown): unknown => {
    if (Array.isArray(axis)) return axis.map(styleAxis);
    if (!axis || typeof axis !== "object") return axis;
    const value = axis as AxisLike;
    return {
      ...value,
      axisLabel: { color: ink, ...(value.axisLabel as object | undefined) },
      axisLine: { lineStyle: { color: line }, ...(value.axisLine as object | undefined) },
      splitLine: { lineStyle: { color: line }, ...(value.splitLine as object | undefined) },
    };
  };

  return {
    ...option,
    backgroundColor: "transparent",
    textStyle: { color: ink, ...(option.textStyle as object | undefined) },
    ...(option.title
      ? {
          title: {
            ...(option.title as object | undefined),
            textStyle: {
              color: ink,
              ...((option.title as AxisLike | undefined)?.textStyle as object | undefined),
            },
          },
        }
      : {}),
    ...(option.legend
      ? {
          legend: {
            ...(option.legend as object | undefined),
            textStyle: {
              color: ink,
              ...((option.legend as AxisLike | undefined)?.textStyle as object | undefined),
            },
          },
        }
      : {}),
    tooltip: {
      backgroundColor: tooltipBg,
      borderColor: line,
      textStyle: { color: dark ? "#f5f5f6" : "#18181b" },
      ...(option.tooltip as object | undefined),
    },
    xAxis: styleAxis(option.xAxis),
    yAxis: styleAxis(option.yAxis),
  };
}

function extractClickPoint(params: unknown): EChartClickPoint | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (record.componentType && record.componentType !== "series") return null;

  let rawName = record.name;
  let rawValue = record.value;
  if (Array.isArray(rawValue)) {
    if ((rawName === undefined || rawName === "") && rawValue.length >= 1) {
      rawName = rawValue[0];
    }
    rawValue = rawValue.length >= 2 ? rawValue[1] : rawValue[0];
  } else if (rawValue && typeof rawValue === "object") {
    const obj = rawValue as Record<string, unknown>;
    if ((rawName === undefined || rawName === "") && obj.name !== undefined) {
      rawName = obj.name;
    }
    rawValue = obj.value;
  }

  const name = rawName === undefined || rawName === null ? "" : String(rawName).trim();
  if (!name) return null;

  const seriesName =
    typeof record.seriesName === "string" && record.seriesName.trim().length > 0
      ? record.seriesName.trim()
      : undefined;
  const value =
    typeof rawValue === "number" || typeof rawValue === "string" ? rawValue : null;

  return { name, seriesName, value };
}

/** Render an ECharts option offscreen in light mode to a high-DPI PNG snapshot. */
export function renderChartOptionToPng(
  option: ChartOption | null | undefined,
  size: { width?: number; height?: number } = {},
): ChartExportSnapshot | null {
  if (!option || isEmptyOption(option)) return null;
  const probeCanvas =
    typeof document !== "undefined" ? document.createElement("canvas") : null;
  if (
    !probeCanvas ||
    typeof probeCanvas.getContext !== "function" ||
    !probeCanvas.getContext("2d")
  ) {
    return null;
  }

  const width = Math.max(1, Math.round(size.width ?? 720));
  const height = Math.max(1, Math.round(size.height ?? 340));
  const offscreen = document.createElement("div");
  let offscreenChart: EChartsType;
  try {
    offscreenChart = init(offscreen, undefined, {
      renderer: "canvas",
      width,
      height,
    });
  } catch {
    return null;
  }

  try {
    offscreenChart.setOption(
      { ...withChartTheme(option, "light"), animation: false },
      { notMerge: true },
    );
    const dataUrl = offscreenChart.getDataURL({
      type: "png",
      pixelRatio: 2,
      backgroundColor: "#ffffff",
    });
    return dataUrl && dataUrl !== "data:," ? { dataUrl, width, height } : null;
  } catch {
    return null;
  } finally {
    try {
      offscreenChart.dispose();
    } catch {
      // Ignore offscreen teardown failures.
    }
  }
}

export function EChart({
  option,
  className,
  ariaLabel = "图表",
  onReady,
  onPointClick,
}: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onPointClickRef = useRef(onPointClick);
  onPointClickRef.current = onPointClick;

  const { theme } = useTheme();
  const optionRef = useRef(option);
  optionRef.current = option;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const empty = isEmptyOption(option);
  const themedOption = useMemo(
    () => (option ? withChartTheme(option, theme) : option),
    [option, theme],
  );
  const [failed, setFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const lastOptionRef = useRef(option);

  // A failed init may be environment-transient; try again when the chart data
  // changes instead of latching the placeholder forever.
  useEffect(() => {
    if (option === lastOptionRef.current) return;
    lastOptionRef.current = option;
    if (!failed) return;
    setFailed(false);
    setRetryKey((key) => key + 1);
  }, [option, failed]);

  useEffect(() => {
    if (empty) return;
    const element = containerRef.current;
    if (!element) return;

    // Headless / jsdom environments return null for canvas 2D contexts; ECharts 6
    // defers context creation until setOption(), so probe upfront to degrade cleanly.
    const probeCanvas =
      typeof document !== "undefined" ? document.createElement("canvas") : null;
    if (!probeCanvas || typeof probeCanvas.getContext !== "function" || !probeCanvas.getContext("2d")) {
      setFailed(true);
      return;
    }

    let instance: EChartsType;
    try {
      instance = init(element, undefined, { renderer: "canvas" });
    } catch {
      // Environments without a usable canvas (e.g. jsdom) keep the placeholder.
      setFailed(true);
      return;
    }
    setFailed(false);
    chartRef.current = instance;
    onReadyRef.current?.(instance);

    const unregisterExporter = registerChartExporter(element, () => {
      const width = element.clientWidth || 640;
      const height = element.clientHeight || 260;
      if (themeRef.current === "light") {
        const dataUrl = instance.getDataURL({
          type: "png",
          pixelRatio: 2,
          backgroundColor: "#ffffff",
        });
        return dataUrl && dataUrl !== "data:," ? { dataUrl, width, height } : null;
      }
      return renderChartOptionToPng(optionRef.current, { width, height });
    });

    const handleClick = (params: unknown) => {
      const handler = onPointClickRef.current;
      if (!handler) return;
      const point = extractClickPoint(params);
      if (point) handler(point);
    };
    instance.on("click", handleClick);

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            try {
              instance.resize();
            } catch {
              // Ignore resize failures on detached containers.
            }
          });
    observer?.observe(element);

    return () => {
      unregisterExporter();
      observer?.disconnect();
      try {
        instance.off("click", handleClick);
      } catch {
        // Ignore teardown errors.
      }
      onReadyRef.current?.(null);
      try {
        instance.dispose();
      } catch {
        // Ignore canvas teardown failures in headless environments.
      }
      chartRef.current = null;
    };
  }, [empty, retryKey]);

  useEffect(() => {
    if (empty || !chartRef.current) return;
    try {
      chartRef.current.setOption(themedOption as ChartOption, { notMerge: true });
    } catch {
      setFailed(true);
    }
  }, [empty, themedOption]);

  if (empty || failed) {
    return (
      <div
        className={cn(
          "flex h-full min-h-40 w-full items-center justify-center rounded-md border border-dashed border-line bg-subtle text-xs text-muted",
          className,
        )}
      >
        {failed ? "图表渲染不可用" : "暂无可展示的图表数据"}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={ariaLabel}
      className={cn("h-full min-h-40 w-full", onPointClick && "cursor-pointer", className)}
    />
  );
}
