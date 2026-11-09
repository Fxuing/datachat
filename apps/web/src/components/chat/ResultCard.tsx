import { useState } from "react";
import { ChevronDown, Table2 } from "lucide-react";
import { cn, formatCount } from "../../lib/utils";
import { ResultTable, type ResultTableProps } from "./ResultTable";

export interface ResultCardProps extends ResultTableProps {
  /** Shown as "查询结果 N" when a reply contains several tables. */
  index?: number;
  /** Guarded SQL that produced the rows; collapsed by default. */
  sql?: string;
}

/**
 * A result table with its own context header: what it is, how many rows and
 * columns it has, and the statement that produced it. Keeping this separate
 * from the assistant prose stops raw tables from appearing unexplained.
 */
export function ResultCard({ index, sql, ...props }: ResultCardProps) {
  const [sqlOpen, setSqlOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-subtle/40 px-3 py-1.5">
        <Table2 className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="text-[11px] font-medium text-ink">
          {index ? `查询结果 ${index}` : "查询结果"}
        </span>
        <span className="text-[11px] text-muted">
          {formatCount(props.rowCount)} 行 · {props.columns.length} 列
        </span>
        {props.truncated ? (
          <span className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
            已截断
          </span>
        ) : null}
        {sql ? (
          <button
            type="button"
            onClick={() => setSqlOpen((open) => !open)}
            aria-expanded={sqlOpen}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-line/60 hover:text-ink"
          >
            查看 SQL
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", sqlOpen && "rotate-180")}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
      {sqlOpen && sql ? (
        <pre className="max-h-40 overflow-auto border-b border-line bg-[#0b0e14] px-3 py-2 text-[11px] leading-relaxed text-[#d6deeb]">
          <code>{sql}</code>
        </pre>
      ) : null}
      <ResultTable {...props} embedded />
    </div>
  );
}
