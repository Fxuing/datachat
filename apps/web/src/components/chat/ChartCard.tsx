import { Suspense, lazy, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";
import { Download, Maximize2, X } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import type { ChartOption } from "./EChart";
import { normalizeChartOption } from "../../lib/chart-option";

// ECharts is heavy; only load it once a chart card is actually rendered.
const LazyEChart = lazy(() =>
  import("./EChart").then((module) => ({ default: module.EChart })),
);

function ChartLoading() {
  return (
    <div className="flex h-full min-h-40 w-full items-center justify-center rounded-md border border-dashed border-line bg-subtle text-xs text-muted">
      图表加载中…
    </div>
  );
}

export interface ChartCardProps {
  title: string;
  option: ChartOption | null | undefined;
  /** Number of plotted points, shown as metadata when provided. */
  points?: number;
  className?: string;
}

/** Extract the ECharts option from a persisted chart spec (`{option, chart}`). */
export function chartOptionFromSpec(spec: unknown): ChartOption | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const record = spec as Record<string, unknown>;
  const option = record.option;
  if (option && typeof option === "object" && !Array.isArray(option)) {
    return option as ChartOption;
  }
  // Tolerate bare options that were stored without the wrapper.
  return Array.isArray(record.series) ? record : null;
}

/** Title of a persisted chart spec, falling back to the provided default. */
export function chartTitleFromSpec(spec: unknown, fallback = "图表"): string {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return fallback;
  const chart = (spec as Record<string, unknown>).chart;
  if (chart && typeof chart === "object" && !Array.isArray(chart)) {
    const title = (chart as Record<string, unknown>).title;
    if (typeof title === "string" && title.trim().length > 0) return title;
  }
  return fallback;
}

function pngFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safe || "chart"}.png`;
}

export function ChartCard({ title, option, points, className }: ChartCardProps) {
  const inlineRef = useRef<EChartsType | null>(null);
  const fullscreenRef = useRef<EChartsType | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenReady, setFullscreenReady] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const normalized = normalizeChartOption(option);

  const closeFullscreen = () => {
    setFullscreen(false);
    setFullscreenReady(false);
    fullscreenRef.current = null;
  };

  const handleDownload = () => {
    const instance = fullscreen ? fullscreenRef.current : inlineRef.current;
    if (!instance) {
      setDownloadError("图表尚未渲染完成，请稍后重试");
      return;
    }
    setDownloadError(null);
    const canvas = getComputedStyle(document.documentElement)
      .getPropertyValue("--canvas")
      .trim();
    const url = instance.getDataURL({
      type: "png",
      pixelRatio: 2,
      backgroundColor: canvas ? `rgb(${canvas})` : "#ffffff",
    });
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = pngFileName(title);
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  return (
    <div
      className={`overflow-hidden rounded-lg border border-line bg-surface ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-subtle px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-xs font-medium text-inksoft">{title}</span>
          {points !== undefined ? (
            <span className="shrink-0 text-[11px] text-muted">{points} 个数据点</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={handleDownload} disabled={fullscreen && !fullscreenReady}>
            <Download className="h-3.5 w-3.5" />
            下载 PNG
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="全屏查看图表"
            onClick={() => {
              setFullscreenReady(false);
              setFullscreen(true);
            }}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            全屏
          </Button>
        </div>
      </div>
      <div className="h-64 px-2 py-2">
        <Suspense fallback={<ChartLoading />}>
          <LazyEChart
            option={normalized}
            ariaLabel={title}
            onReady={(instance) => {
              inlineRef.current = instance;
            }}
          />
        </Suspense>
      </div>
      {downloadError ? (
        <p role="alert" className="border-t border-line px-3 py-1.5 text-[11px] text-danger">
          {downloadError}
        </p>
      ) : null}

      <Dialog open={fullscreen} onOpenChange={(open) => { if (!open) closeFullscreen(); }}>
        <DialogContent
          hideClose
          className="flex h-[85vh] max-h-[85vh] max-w-5xl flex-col gap-0 p-0"
        >
          <DialogDescription className="sr-only">{title} 全屏图表视图</DialogDescription>
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <DialogTitle className="truncate text-sm font-medium text-inksoft">{title}</DialogTitle>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDownload}
                disabled={!fullscreenReady}
              >
                <Download className="h-3.5 w-3.5" />
                下载 PNG
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="关闭全屏"
                onClick={() => closeFullscreen()}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 p-3">
            <Suspense fallback={<ChartLoading />}>
              <LazyEChart
                option={normalized}
                ariaLabel={title}
                onReady={(instance) => {
                  fullscreenRef.current = instance;
                  setFullscreenReady(instance !== null);
                }}
              />
            </Suspense>
          </div>
          {downloadError ? (
            <p role="alert" className="border-t border-line px-4 py-2 text-[11px] text-danger">
              {downloadError}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
