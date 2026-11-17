import { useEffect, useRef, type ReactNode } from "react";
import { AlertCircle, ChevronDown } from "lucide-react";
import { cn, formatDuration, formatTokens } from "../../lib/utils";
import { type TraceStatus } from "./status";
import { useTraceOpen } from "./use-trace-open";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export interface TraceProps {
  /** Summary headline: 「本轮完成」/「本轮执行中」/「查询失败」. */
  label: string;
  status?: TraceStatus;
  /** Number of steps, rendered as 「4 步」. Omitted when 0 or undefined. */
  stepCount?: number;
  durationMs?: number | null;
  /** Total tokens for the turn, rendered as 「26.8k tokens」 after the duration. */
  tokens?: number | null;
  /** Native tooltip for the token count: the input/output breakdown. */
  tokensHint?: string;
  /** One more summary item after the token count (e.g. 「记忆 2」). */
  extra?: ReactNode;
  /** `TraceLine` items. */
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  testId?: string;
}

/** Collapsible call chain for one agent turn: a one-line summary that unfolds
 * into `TraceLine` steps. Collapsed when settled, unfolded while running. */
export function Trace({
  label,
  status = "done",
  stepCount,
  durationMs,
  tokens,
  tokensHint,
  extra,
  children,
  open: openProp,
  defaultOpen,
  onOpenChange,
  className,
  testId = "trace",
}: TraceProps) {
  const hasSteps = children !== undefined && children !== null;
  // A live or failed run unfolds itself; a settled one folds back down.
  const { open, toggle } = useTraceOpen({
    open: openProp,
    defaultOpen: defaultOpen ?? (status === "running" || status === "error"),
    onOpenChange,
  });
  const failed = status === "error";
  const listRef = useRef<HTMLOListElement>(null);

  // A long run keeps the newest step in view instead of pushing the answer down.
  useEffect(() => {
    const list = listRef.current;
    if (!list || status !== "running") return;
    list.scrollTop = list.scrollHeight;
  }, [children, status, open]);

  const meta: ReactNode[] = [
    stepCount && stepCount > 0 ? `${stepCount} 步` : null,
    typeof durationMs === "number" ? formatDuration(durationMs) : null,
    typeof tokens === "number" && tokens > 0 ? (
      // The summary is a button already, so the count is the whole trigger and
      // the breakdown lives in the shared tooltip rather than a native title.
      <Tooltip key="tokens">
        <TooltipTrigger asChild>
          <span className="tabular-nums">{formatTokens(tokens)} tokens</span>
        </TooltipTrigger>
        {tokensHint ? (
          <TooltipContent side="top" className="max-w-xs">
            {tokensHint}
          </TooltipContent>
        ) : null}
      </Tooltip>
    ) : null,
    extra ?? null,
  ].filter(Boolean);

  const summary = (
    <>
      <ChevronDown
        className={cn("h-3.5 w-3.5 shrink-0 text-muted transition-transform", open && "rotate-180")}
      />
      <span
        className={cn(
          "text-xs font-medium",
          failed ? "text-danger" : "text-inksoft",
          status === "running" && "trace-shimmer",
        )}
      >
        {label}
      </span>
      {meta.length > 0 ? (
        <span className="text-[11px] text-muted">
          {meta.map((item, index) => (
            <span key={index}>
              {index > 0 ? " · " : null}
              {item}
            </span>
          ))}
        </span>
      ) : null}
      {failed ? (
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="执行失败" />
      ) : null}
    </>
  );

  return (
    <section className={cn("flex flex-col", className)} data-testid={testId}>
      {hasSteps ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {summary}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-1.5 py-1">{summary}</div>
      )}
      {hasSteps && open ? (
        <ol
          ref={listRef}
          className="ml-2 mt-1 flex max-h-72 flex-col gap-0.5 overflow-y-auto overscroll-contain border-l border-line pl-3 pr-1"
          data-testid="trace-steps"
        >
          {children}
        </ol>
      ) : null}
    </section>
  );
}
