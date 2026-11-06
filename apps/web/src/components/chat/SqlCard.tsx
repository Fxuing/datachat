import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ChatSql } from "../../lib/api";
import { cn } from "../../lib/utils";

const STATUS_LABELS: Record<ChatSql["status"], string> = {
  ok: "已执行",
  rejected: "已拒绝",
  error: "执行失败",
};

export function SqlCard({ sql }: { sql: ChatSql }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(sql.sql);
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access can be blocked; leave the SQL visible for manual copy.
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-neutral-900">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">SQL</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px]",
            sql.status === "ok"
              ? "bg-emerald-900/40 text-emerald-300"
              : sql.status === "rejected"
                ? "bg-amber-900/40 text-amber-300"
                : "bg-red-900/40 text-red-300",
          )}
        >
          {STATUS_LABELS[sql.status]}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          aria-label={copied ? "已复制 SQL" : "复制 SQL"}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="max-h-64 overflow-auto px-3 py-2 text-[11px] leading-relaxed text-neutral-100">
        {sql.sql}
      </pre>
    </div>
  );
}
