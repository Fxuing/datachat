import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsType } from "echarts/core";
import {
  AreaChart,
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUp,
  ArrowUpDown,
  ArrowUpNarrowWide,
  BarChart3,
  Download,
  LineChart,
  Maximize2,
  PieChart,
  Pin,
  ScatterChart,
  Table2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import type { ChartOption } from "./EChart";
import {
  availableChartModes,
  detectChartBaseMode,
  extractChartTable,
  normalizeChartOption,
  transformChartOption,
  type ChartSortOrder,
  type ChartTableColumn,
  type ChartTableData,
  type ChartViewMode,
} from "../../lib/chart-option";
import { cn } from "../../lib/utils";

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

const MODE_META: Record<ChartViewMode, { label: string; icon: LucideIcon }> = {
  bar: { label: "柱状图", icon: BarChart3 },
  line: { label: "折线图", icon: LineChart },
  area: { label: "面积图", icon: AreaChart },
  pie: { label: "饼图", icon: PieChart },
  scatter: { label: "散点图", icon: ScatterChart },
  table: { label: "明细表", icon: Table2 },
};

const SORT_CYCLE: ChartSortOrder[] = ["default", "desc", "asc"];

const SORT_META: Record<ChartSortOrder, { label: string; icon: LucideIcon }> = {
  default: { label: "排序：默认", icon: ArrowUpDown },
  desc: { label: "排序：降序", icon: ArrowDownWideNarrow },
  asc: { label: "排序：升序", icon: ArrowUpNarrowWide },
};

function formatTableCell(value: string | number | null, column: ChartTableColumn): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (column.percent) return `${(value * 100).toFixed(1)}%`;
    return value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
  }
  return value;
}

function compareCells(
  left: string | number | null,
  right: string | number | null,
  direction: "asc" | "desc",
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  let diff: number;
  if (typeof left === "number" && typeof right === "number") {
    diff = left - right;
  } else {
    diff = String(left).localeCompare(String(right), "zh-CN", { numeric: true });
  }
  return direction === "asc" ? diff : -diff;
}

function ChartTableView({ table }: { table: ChartTableData | null }) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    setSortCol(null);
    setSortDir("desc");
  }, [table]);

  const sortedRows = useMemo(() => {
    if (!table) return [];
    if (sortCol === null) return table.rows;
    return [...table.rows].sort((left, right) =>
      compareCells(left[sortCol] ?? null, right[sortCol] ?? null, sortDir),
    );
  }, [table, sortCol, sortDir]);

  if (!table || table.rows.length === 0) {
    return (
      <div className="flex h-full min-h-40 w-full items-center justify-center rounded-md border border-dashed border-line bg-subtle text-xs text-muted">
        暂无可展示的表格数据
      </div>
    );
  }

  const handleSort = (colIndex: number) => {
    if (sortCol !== colIndex) {
      setSortCol(colIndex);
      setSortDir(table.columns[colIndex]?.numeric ? "desc" : "asc");
      return;
    }
    if (sortDir === "desc") {
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortCol(null);
    }
  };

  return (
    <div className="h-full w-full overflow-auto rounded-md border border-line">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 z-10 bg-subtle text-inksoft">
          <tr>
            {table.columns.map((column, index) => {
              const active = sortCol === index;
              const SortIcon = !active
                ? ArrowUpDown
                : sortDir === "asc"
                  ? ArrowUp
                  : ArrowDown;
              return (
                <th
                  key={`${column.label}-${index}`}
                  scope="col"
                  aria-sort={
                    active ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                  }
                  className={cn(
                    "whitespace-nowrap border-b border-line px-3 py-2 font-medium",
                    column.numeric && "text-right",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSort(index)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-line/60 hover:text-ink",
                      column.numeric && "flex-row-reverse",
                    )}
                  >
                    <span>{column.label}</span>
                    <SortIcon
                      className={cn("h-3 w-3 shrink-0", active ? "text-brand" : "text-muted/70")}
                    />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60 bg-surface text-ink">
          {sortedRows.map((row, rowIndex) => (
            <tr key={rowIndex} className="hover:bg-subtle/60">
              {table.columns.map((column, colIndex) => (
                <td
                  key={colIndex}
                  className={cn(
                    "whitespace-nowrap px-3 py-1.5",
                    column.numeric && "text-right tabular-nums",
                  )}
                >
                  {formatTableCell(row[colIndex] ?? null, column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ChartCardProps {
  title: string;
  option: ChartOption | null | undefined;
  /** Number of plotted points, shown as metadata when provided. */
  points?: number;
  className?: string;
  /** Optional handler to pin this chart to a user dashboard. */
  onPin?: () => void;
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

export function ChartCard({ title, option, points, className, onPin }: ChartCardProps) {
  const inlineRef = useRef<EChartsType | null>(null);
  const fullscreenRef = useRef<EChartsType | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenReady, setFullscreenReady] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<ChartViewMode | null>(null);
  const [sortOrder, setSortOrder] = useState<ChartSortOrder>("default");

  const baseMode = useMemo(() => detectChartBaseMode(option), [option]);
  const modes = useMemo(() => availableChartModes(option), [option]);

  useEffect(() => {
    setSelectedMode(null);
    setSortOrder("default");
  }, [option]);

  const activeMode: ChartViewMode | null =
    selectedMode && modes.includes(selectedMode) ? selectedMode : baseMode;

  const displayOption = useMemo(() => {
    if (!option) return null;
    if (!activeMode || activeMode === "table") return normalizeChartOption(option);
    if (activeMode === baseMode && sortOrder === "default") {
      return normalizeChartOption(option);
    }
    return transformChartOption(option, activeMode, sortOrder);
  }, [option, activeMode, baseMode, sortOrder]);

  const tableData = useMemo(
    () => (activeMode === "table" ? extractChartTable(option, sortOrder) : null),
    [option, activeMode, sortOrder],
  );

  const canSortChart =
    activeMode !== null && activeMode !== "table" && activeMode !== "scatter" && modes.length > 1;

  const cycleSortOrder = () => {
    setSortOrder((current) => {
      const nextIndex = (SORT_CYCLE.indexOf(current) + 1) % SORT_CYCLE.length;
      return SORT_CYCLE[nextIndex] ?? "default";
    });
  };

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

  const SortIcon = SORT_META[sortOrder].icon;

  const renderModeControls = () => (
    <>
      {modes.length > 1 ? (
        <div
          role="group"
          aria-label="切换图表展示方式"
          className="inline-flex items-center rounded-md border border-line bg-surface p-0.5"
        >
          {modes.map((mode) => {
            const { label, icon: Icon } = MODE_META[mode];
            const active = activeMode === mode;
            return (
              <Tooltip key={mode}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={active}
                    onClick={() => {
                      setDownloadError(null);
                      setSelectedMode(mode);
                    }}
                    className={cn(
                      "inline-flex h-6 w-6 items-center justify-center rounded transition-colors",
                      active
                        ? "bg-brandsoft text-brandtext"
                        : "text-muted hover:bg-subtle hover:text-ink",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
      {canSortChart ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={sortOrder === "default" ? "ghost" : "secondary"}
              size="icon"
              className="h-7 w-7"
              aria-label={SORT_META[sortOrder].label}
              onClick={cycleSortOrder}
            >
              <SortIcon className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{SORT_META[sortOrder].label}（点击切换）</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );

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
          {renderModeControls()}
          {onPin ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="固定到看板"
                  onClick={onPin}
                >
                  <Pin className="h-3.5 w-3.5" />
                  固定
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">固定到数据看板</TooltipContent>
            </Tooltip>
          ) : null}
          {activeMode !== "table" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              disabled={fullscreen && !fullscreenReady}
            >
              <Download className="h-3.5 w-3.5" />
              下载 PNG
            </Button>
          ) : null}
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
        {activeMode === "table" ? (
          <ChartTableView table={tableData} />
        ) : (
          <Suspense fallback={<ChartLoading />}>
            <LazyEChart
              option={displayOption}
              ariaLabel={title}
              onReady={(instance) => {
                inlineRef.current = instance;
              }}
            />
          </Suspense>
        )}
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
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <DialogTitle className="truncate text-sm font-medium text-inksoft">{title}</DialogTitle>
            <div className="flex shrink-0 items-center gap-1.5">
              {renderModeControls()}
              {activeMode !== "table" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDownload}
                  disabled={!fullscreenReady}
                >
                  <Download className="h-3.5 w-3.5" />
                  下载 PNG
                </Button>
              ) : null}
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
            {activeMode === "table" ? (
              <ChartTableView table={tableData} />
            ) : (
              <Suspense fallback={<ChartLoading />}>
                <LazyEChart
                  option={displayOption}
                  ariaLabel={title}
                  onReady={(instance) => {
                    fullscreenRef.current = instance;
                    setFullscreenReady(instance !== null);
                  }}
                />
              </Suspense>
            )}
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
