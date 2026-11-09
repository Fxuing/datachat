import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/spinner";

export interface ProcessBlockProps {
  thinking?: string;
  tools?: ReactNode;
  sqls?: ReactNode;
  toolCount?: number;
  sqlCount?: number;
  running?: boolean;
  defaultOpen?: boolean;
}

/**
 * Collapsible container for the agent's intermediate work: reasoning, tool calls
 * and executed SQL. Results and charts stay outside so they remain visible.
 */
export function ProcessBlock({
  thinking,
  tools,
  sqls,
  toolCount = 0,
  sqlCount = 0,
  running = false,
  defaultOpen = false,
}: ProcessBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const steps = toolCount + sqlCount;

  // Open once when the run actually starts, but never fight a manual collapse.
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  if (!thinking && steps === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-subtle/60"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-[11px] font-medium text-inksoft">执行过程</span>
        {thinking ? (
          <span className="inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
            <Sparkles className="h-2.5 w-2.5" />
            思考
          </span>
        ) : null}
        {steps > 0 ? (
          <span className="text-[10px] text-muted">{steps} 个步骤</span>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-muted">
          {running ? <Spinner className="h-3 w-3" /> : null}
          {running ? "进行中" : "已完成"}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-line bg-canvas/40 p-2">
          {thinking ? (
            <div className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface px-3 py-2 text-xs leading-relaxed text-muted">
              {thinking}
            </div>
          ) : null}
          {tools}
          {sqls}
        </div>
      ) : null}
    </div>
  );
}
