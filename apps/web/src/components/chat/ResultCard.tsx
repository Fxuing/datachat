import { useState, type ReactNode } from "react";
import { ChevronDown, Eye, Table2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { ResultTable, type ResultTableProps } from "./ResultTable";

export interface ResultCardProps extends ResultTableProps {
  /** Shown as "查询结果 N" when a reply contains several tables. */
  index?: number;
  /** Guarded SQL that produced the rows; collapsed by default. */
  sql?: string;
  /** Inside a grouped list: drop the card border and rounding. */
  flat?: boolean;
}

/**
 * Query results stay collapsed: a compact summary with a "查看数据" dialog.
 * Dumping every result table into the transcript buries the answer, so users
 * only open the details they actually asked for.
 */
export function ResultCard({ index, sql, flat, ...props }: ResultCardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sqlOpen, setSqlOpen] = useState(false);
  const title = index ? `查询结果 ${index}` : "查询结果";

  return (
    <>
      <div className={cn("overflow-hidden bg-surface", !flat && "rounded-lg border border-line")}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2">
          <Table2 className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          <span className="text-[11px] font-medium text-ink">{title}</span>
          <span className="text-[11px] text-muted">
            {props.rowCount} 行 · {props.columns.length} 列
          </span>
          {props.truncated ? (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
              已截断
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {sql ? (
              <button
                type="button"
                onClick={() => setSqlOpen((open) => !open)}
                aria-expanded={sqlOpen}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted transition-colors hover:bg-line/60 hover:text-ink"
              >
                查看 SQL
                <ChevronDown
                  className={cn("h-3 w-3 transition-transform", sqlOpen && "rotate-180")}
                  aria-hidden
                />
              </button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => setDetailsOpen(true)}
            >
              <Eye className="h-3.5 w-3.5" aria-hidden />
              查看数据
            </Button>
          </div>
        </div>
        {sqlOpen && sql ? (
          <pre className="max-h-40 overflow-auto border-t border-line bg-[#0b0e14] px-3 py-2 text-[11px] leading-relaxed text-[#d6deeb]">
            <code>{sql}</code>
          </pre>
        ) : null}
      </div>

      {detailsOpen ? (
        <ResultDetailDialog title={title} sql={sql} onClose={() => setDetailsOpen(false)}>
          <ResultTable {...props} embedded maxBodyHeightClass="max-h-[60vh]" />
        </ResultDetailDialog>
      ) : null}
    </>
  );
}

function ResultDetailDialog({
  title,
  sql,
  onClose,
  children,
}: {
  title: string;
  sql?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col gap-0 p-0">
        <DialogHeader className="flex-row items-center gap-2 pr-10">
          <Table2 className="h-4 w-4 text-muted" aria-hidden />
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
        {sql ? (
          <details className="border-t border-line px-3 py-2 text-[11px] text-muted">
            <summary className="cursor-pointer select-none py-1 hover:text-ink">查看 SQL</summary>
            <pre className="mt-1 max-h-32 overflow-auto rounded bg-[#0b0e14] px-3 py-2 text-[11px] leading-relaxed text-[#d6deeb]">
              <code>{sql}</code>
            </pre>
          </details>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
