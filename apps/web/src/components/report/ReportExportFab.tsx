import { useState } from "react";
import { Download, FileCode2, FileText, FileType, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export interface ReportExportFabProps {
  disabled?: boolean;
  exportingWord?: boolean;
  exportError?: string | null;
  onExportMarkdown: () => void;
  onExportHtml: () => void;
  onExportWord: () => void;
}

export function ReportExportFab({
  disabled = false,
  exportingWord = false,
  exportError = null,
  onExportMarkdown,
  onExportHtml,
  onExportWord,
}: ReportExportFabProps) {
  const [open, setOpen] = useState(false);
  const triggerDisabled = disabled || exportingWord;

  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="report-export-fab absolute bottom-6 right-6 z-20 flex flex-col items-end gap-2 print:hidden">
      {exportError ? (
        <p
          role="alert"
          className="rounded-lg border border-danger/20 bg-dangersoft px-3 py-1.5 text-xs text-danger shadow-card"
        >
          {exportError}
        </p>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={triggerDisabled}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2.5 text-xs font-medium text-brandink shadow-pop transition-colors hover:bg-brandhover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60"
          >
            {exportingWord ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="h-4 w-4" aria-hidden />
            )}
            {exportingWord ? "导出中…" : "导出"}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" sideOffset={10} className="w-52 p-1.5">
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => choose(onExportMarkdown)}
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
            <button
              type="button"
              onClick={() => choose(onExportHtml)}
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
              onClick={() => choose(onExportWord)}
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
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
