import type { ReactNode } from "react";
import { Brain, ChevronDown } from "lucide-react";
import { cn, formatDuration } from "../../lib/utils";
import { TraceStatusIcon, type TraceStatus } from "./status";
import { useTraceOpen } from "./use-trace-open";

export interface TraceLineProps {
  /** Short, past-tense when settled: 「执行查询」/「查询失败」. */
  title: string;
  /** Secondary detail on the same row: row counts, table names, tool id. */
  description?: ReactNode;
  /** Reasoning row: the title is the model's own words, marked with a brain
   * instead of a step tick. Everything else matches a normal step. */
  reasoning?: boolean;
  status?: TraceStatus;
  durationMs?: number | null;
  /** Detail body: SQL, result summary, error text. Makes the row expandable. */
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  testId?: string;
}

/** One step of an agent run: status icon, title, optional description and
 * duration, plus a foldable detail body. */
export function TraceLine({
  title,
  description,
  reasoning = false,
  status = "done",
  durationMs,
  children,
  open: openProp,
  defaultOpen,
  onOpenChange,
  className,
  testId = "trace-line",
}: TraceLineProps) {
  const expandable = children !== undefined && children !== null;
  // Only a failure opens on its own: the error text is what the reader came for.
  const { open, toggle } = useTraceOpen({
    open: openProp,
    defaultOpen: defaultOpen ?? status === "error",
    onOpenChange,
  });
  const failed = status === "error";

  const content = (
    <>
      {reasoning ? (
        <Brain className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
      ) : (
        <TraceStatusIcon status={status} className="mt-0.5" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-xs font-medium",
            failed ? "text-danger" : "text-inksoft",
            status === "running" && "trace-shimmer",
            status === "pending" && "text-muted",
          )}
        >
          {title}
        </span>
        {description ? (
          <span className="truncate text-[11px] text-muted">{description}</span>
        ) : null}
      </span>
      {typeof durationMs === "number" ? (
        <span className="mt-0.5 shrink-0 text-[10px] tabular-nums text-muted">
          {formatDuration(durationMs)}
        </span>
      ) : null}
      {expandable ? (
        <ChevronDown
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0 text-muted transition-transform",
            open && "rotate-180",
          )}
        />
      ) : null}
    </>
  );

  return (
    <li className={cn("flex flex-col", className)} data-testid={testId}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {content}
        </button>
      ) : (
        <div className="flex items-start gap-2 px-1.5 py-1">{content}</div>
      )}
      {expandable && open ? (
        <div className="ml-2 flex flex-col gap-2 border-l border-line pb-1 pl-4 pt-1">
          {children}
        </div>
      ) : null}
    </li>
  );
}
