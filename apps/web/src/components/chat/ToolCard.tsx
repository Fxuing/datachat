import { AlertCircle, CheckCircle2, FileText } from "lucide-react";
import { Link } from "react-router-dom";
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
        "rounded-lg border bg-surface",
        failed ? "border-danger/20" : "border-line",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {tool.status === "running" ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : failed ? (
            <AlertCircle className="h-4 w-4 text-danger" aria-label="工具执行失败" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-success" aria-label="工具执行完成" />
          )}
        </span>
        <span className={cn("text-xs font-medium", failed ? "text-danger" : "text-inksoft")}>
          {toolLabel(tool.name)}
        </span>
        <span className="truncate font-mono text-[10px] text-muted">{tool.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted">
          {typeof tool.durationMs === "number" ? formatDuration(tool.durationMs) : null}
        </span>
      </div>
      {tool.summary ? (
        <p
          className={cn(
            "border-t px-3 py-2 text-xs",
            failed ? "border-danger/15 text-danger" : "border-line text-muted",
          )}
        >
          {tool.summary}
        </p>
      ) : null}
      {tool.url && !failed ? (
        <div className="border-t border-line px-3 py-2">
          <Link
            to={tool.url}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-brandtext hover:underline"
          >
            <FileText className="h-3.5 w-3.5" />
            查看报告
          </Link>
        </div>
      ) : null}
      {hasArgs(tool.args) ? (
        <details className="group border-t border-line">
          <summary className="cursor-pointer select-none px-3 py-1.5 text-[11px] text-muted hover:text-inksoft">
            参数
          </summary>
          <pre className="max-h-48 overflow-auto border-t border-line bg-subtle px-3 py-2 text-[11px] leading-relaxed text-muted">
            {JSON.stringify(tool.args, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
