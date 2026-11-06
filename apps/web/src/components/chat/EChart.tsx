import { useEffect, useRef, useState } from "react";
import { init, use, type EChartsType } from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { cn } from "../../lib/utils";

// Only the chart types and components the server-side engine emits are bundled.
use([
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

export function EChart({ option, className, ariaLabel = "图表", onReady }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const empty = isEmptyOption(option);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (empty) return;
    const element = containerRef.current;
    if (!element) return;

    let instance: EChartsType;
    try {
      instance = init(element, undefined, { renderer: "canvas" });
    } catch {
      // Environments without a usable canvas (e.g. jsdom) keep the placeholder.
      setFailed(true);
      return;
    }
    chartRef.current = instance;
    onReadyRef.current?.(instance);

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => instance.resize());
    observer?.observe(element);

    return () => {
      observer?.disconnect();
      onReadyRef.current?.(null);
      instance.dispose();
      chartRef.current = null;
    };
  }, [empty]);

  useEffect(() => {
    if (empty) return;
    chartRef.current?.setOption(option as ChartOption, { notMerge: true });
  }, [empty, option]);

  if (empty || failed) {
    return (
      <div
        className={cn(
          "flex h-full min-h-40 w-full items-center justify-center rounded-md border border-dashed border-neutral-200 bg-neutral-50 text-xs text-neutral-400",
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
