import { AlertCircle, CheckCircle2, CircleDashed } from "lucide-react";
import { Spinner } from "../ui/spinner";
import { cn } from "../../lib/utils";

/** Mirrors AI Elements' trace status: `done` is the resting state of a step
 * that finished without error, so callers can omit it entirely. */
export type TraceStatus = "pending" | "running" | "done" | "error";

const ICON_BASE = "h-4 w-4 shrink-0";

export function TraceStatusIcon({
  status,
  className,
}: {
  status: TraceStatus;
  className?: string;
}) {
  if (status === "running") {
    return <Spinner className={cn("h-3.5 w-3.5", className)} />;
  }
  if (status === "error") {
    return <AlertCircle className={cn(ICON_BASE, "text-danger", className)} aria-label="失败" />;
  }
  if (status === "pending") {
    return (
      <CircleDashed className={cn(ICON_BASE, "text-muted/60", className)} aria-label="待执行" />
    );
  }
  return (
    <CheckCircle2 className={cn(ICON_BASE, "text-success", className)} aria-label="已完成" />
  );
}
