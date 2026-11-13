import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ChatSql } from "../../lib/api";
import { cn } from "../../lib/utils";
import { copyToClipboard } from "../../lib/clipboard";

const STATUS_LABELS: Record<ChatSql["status"], string> = {
  ok: "已执行",
  rejected: "已拒绝",
  error: "执行失败",
};

export function SqlCard({ sql, flat = false }: { sql: ChatSql; flat?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async () => {
    if (!(await copyToClipboard(sql.sql))) return;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div
      className={cn(
        "overflow-hidden bg-[#0b0e14]",
        !flat && "rounded-lg border border-white/10 shadow-sm",
      )}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/50">SQL</span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px]",
            sql.status === "ok"
              ? "bg-emerald-400/10 text-emerald-300 ring-1 ring-inset ring-emerald-400/20"
              : sql.status === "rejected"
                ? "bg-amber-400/10 text-amber-300 ring-1 ring-inset ring-amber-400/20"
                : "bg-red-400/10 text-red-300 ring-1 ring-inset ring-red-400/20",
          )}
        >
          {STATUS_LABELS[sql.status]}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-white/55 transition-colors hover:bg-white/10 hover:text-white"
          aria-label={copied ? "已复制 SQL" : "复制 SQL"}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="max-h-64 overflow-auto px-3 py-2 text-[11px] leading-relaxed text-neutral-100/90">
        {sql.sql}
      </pre>
    </div>
  );
}
