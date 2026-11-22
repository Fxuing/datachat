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

export interface EChartProps {
  option: ChartOption | null | undefined;
  className?: string;
  ariaLabel?: string;
  /** Receives the instance once it is ready; called with null after disposal. */
  onReady?: (instance: EChartsType | null) => void;
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

export function EChart({ option, className, ariaLabel = "图表", onReady }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const { theme } = useTheme();
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
      observer?.disconnect();
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
      className={cn("h-full min-h-40 w-full", className)}
    />
  );
}
