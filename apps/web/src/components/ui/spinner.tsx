import { cn } from "../../lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="加载中"
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700",
        className,
      )}
    />
  );
}

export function PageSpinner({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-3 text-sm text-neutral-500">
      <Spinner className="h-5 w-5" />
      <span>{label}</span>
    </div>
  );
}
