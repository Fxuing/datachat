import { useEffect, useState } from "react";
import {
  ChevronDown,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  FileType,
  Loader2,
} from "lucide-react";
import { Link } from "react-router-dom";
import { getReport } from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { exportReportById, type ReportExportFormat } from "../../lib/report-offscreen-export";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export interface ReportCardProps {
  reportId: string;
  title?: string;
}

export function ReportCard({ reportId, title: initialTitle }: ReportCardProps) {
  const [title, setTitle] = useState<string>(initialTitle?.trim() || "");
  const [status, setStatus] = useState<"ready" | "loading" | "failed">(
    initialTitle?.trim() ? "ready" : "loading",
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<ReportExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = initialTitle?.trim() ?? "";
    if (trimmed) {
      setTitle(trimmed);
      setStatus("ready");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    getReport(reportId)
      .then((res) => {
        if (cancelled) return;
        setTitle(res.report.title.trim() || "分析报告");
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [reportId, initialTitle]);

  const handleExport = async (format: ReportExportFormat) => {
    if (exportingFormat !== null) return;
    setMenuOpen(false);
    setExportError(null);
    setExportingFormat(format);
    try {
      const result = await exportReportById(reportId, format);
      if (result.title.trim()) {
        setTitle(result.title.trim());
        setStatus("ready");
      }
    } catch (error) {
      setExportError(describeApiError(error, "导出失败，请稍后重试。"));
    } finally {
      setExportingFormat(null);
    }
  };

  if (status === "failed") {
    return <p className="text-[11px] text-muted">报告不可用</p>;
  }

  const displayTitle =
    status === "loading" ? "加载报告信息…" : title || "分析报告";
  const busy = exportingFormat !== null;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface p-3 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brandsoft text-brandtext">
            <FileText className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{displayTitle}</p>
            <p className="text-[11px] text-muted">
              分析报告 · 支持导出 Word / HTML / Markdown
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex items-center">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleExport("docx")}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-l-md bg-ink px-3 text-xs font-medium text-canvas shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Download className="h-3.5 w-3.5" aria-hidden />
              )}
              {busy ? "导出中…" : "导出 Word"}
            </button>
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="更多导出格式"
                  disabled={busy}
                  className="inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-r-md border-l border-canvas/20 bg-ink text-canvas shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={6} className="w-48 p-1.5">
                <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => void handleExport("docx")}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs text-ink transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <span className="flex items-center gap-2">
                      <FileType className="h-4 w-4 text-muted" aria-hidden />
                      导出 Word
                    </span>
                    <span aria-hidden className="font-mono text-[11px] text-muted">
                      .docx
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleExport("html")}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs text-ink transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <span className="flex items-center gap-2">
                      <FileCode2 className="h-4 w-4 text-muted" aria-hidden />
                      导出 HTML
                    </span>
                    <span aria-hidden className="font-mono text-[11px] text-muted">
                      .html
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleExport("md")}
                    className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs text-ink transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <span className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted" aria-hidden />
                      导出 Markdown
                    </span>
                    <span aria-hidden className="font-mono text-[11px] text-muted">
                      .md
                    </span>
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <Link
            to={`/reports/${reportId}`}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-linestrong bg-surface px-2.5 text-xs font-medium text-inksoft transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            查看详情
          </Link>
        </div>
      </div>

      {exportError ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {exportError}
        </p>
      ) : null}
    </div>
  );
}
