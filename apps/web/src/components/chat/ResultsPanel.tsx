import { useState } from "react";
import { ChevronDown, Table2 } from "lucide-react";
import type { ChatResult } from "../../lib/api";
import { cn } from "../../lib/utils";
import { ResultCard } from "./ResultCard";

const COLLAPSE_THRESHOLD = 3;

export interface ResultsPanelProps {
  results: ChatResult[];
  onCreateReport?: (artifactId: string) => void;
}

/**
 * Groups query results so a reply with a dozen exploratory queries does not bury
 * the answer. Up to three results keep their individual cards; beyond that the
 * list starts collapsed behind one summary row.
 */
export function ResultsPanel({ results, onCreateReport }: ResultsPanelProps) {
  const collapsible = results.length > COLLAPSE_THRESHOLD;
  const [open, setOpen] = useState(!collapsible);

  if (!collapsible) {
    return (
      <div className="flex flex-col gap-2">
        {results.map((result, index) => (
          <ResultCard
            key={result.artifactId}
            {...result}
            index={results.length > 1 ? index + 1 : undefined}
            onCreateReport={onCreateReport}
          />
        ))}
      </div>
    );
  }

  const totalRows = results.reduce((sum, result) => sum + result.rowCount, 0);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-subtle/60"
      >
        <Table2 className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <span className="text-[11px] font-medium text-ink">查询结果</span>
        <span className="text-[11px] text-muted">
          {results.length} 个 · 共 {totalRows} 行
        </span>
        <ChevronDown
          className={cn("ml-auto h-3.5 w-3.5 text-muted transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="divide-y divide-line border-t border-line">
          {results.map((result, index) => (
            <ResultCard
              key={result.artifactId}
              {...result}
              flat
              index={index + 1}
              onCreateReport={onCreateReport}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
