import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Spinner } from "../ui/spinner";
import type { RunToolState } from "../../lib/run-events";
import { cn, formatDuration } from "../../lib/utils";

const TOOL_LABELS: Record<string, string> = {
  db_schema: "查询表结构",
  db_query: "执行 SQL 查询",
  db_explain: "分析执行计划",
  list_artifacts: "查看历史结果",
  read: "读取技能文档",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function hasArgs(args: unknown): boolean {
  if (args === null || args === undefined) return false;
  if (typeof args === "object") return Object.keys(args as Record<string, unknown>).length > 0;
  return true;
}

export function ToolCard({ tool }: { tool: RunToolState }) {
  const failed = tool.status === "error";

  return (
    <div
      className={cn(
        "rounded-lg border bg-white",
        failed ? "border-red-200" : "border-neutral-200",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {tool.status === "running" ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : failed ? (
            <AlertCircle className="h-4 w-4 text-red-500" aria-label="工具执行失败" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-label="工具执行完成" />
          )}
        </span>
        <span className={cn("text-xs font-medium", failed ? "text-red-700" : "text-neutral-800")}>
          {toolLabel(tool.name)}
        </span>
        <span className="truncate font-mono text-[10px] text-neutral-400">{tool.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-neutral-400">
          {typeof tool.durationMs === "number" ? formatDuration(tool.durationMs) : null}
        </span>
      </div>
      {tool.summary ? (
        <p
          className={cn(
            "border-t px-3 py-2 text-xs",
            failed ? "border-red-100 text-red-700" : "border-neutral-100 text-neutral-500",
          )}
        >
          {tool.summary}
        </p>
      ) : null}
      {hasArgs(tool.args) ? (
        <details className="group border-t border-neutral-100">
          <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] text-neutral-500 hover:text-neutral-700">
            参数
          </summary>
          <pre className="max-h-48 overflow-auto border-t border-neutral-100 bg-neutral-50 px-3 py-2 text-[11px] leading-relaxed text-neutral-600">
            {JSON.stringify(tool.args, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
