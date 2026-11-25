import type { RunStatusValue } from "../../lib/run-events";
import type { TraceStatus } from "../trace";

/** The subset of `ChatTool` (history) and `RunToolState` (live stream) we show. */
export interface TurnTool {
  toolCallId: string;
  name: string;
  status: "running" | "ok" | "error";
  args?: unknown;
  durationMs?: number | null;
  summary?: string | null;
  url?: string | null;
}

/** Past-tense wording: a trace line describes work that already happened. */
export const TOOL_TITLES: Record<string, string> = {
  db_schema: "读取表结构",
  db_explain: "分析执行计划",
  db_query: "执行查询",
  make_chart: "生成图表",
  create_excel: "生成 Excel",
  create_report: "生成报告",
  list_artifacts: "查看历史结果",
  read: "读取技能文档",
};

export function traceLabel(status: RunStatusValue): string {
  switch (status) {
    case "queued":
      return "本轮排队中";
    case "running":
      return "本轮执行中";
    case "error":
      return "本轮失败";
    case "aborted":
      return "本轮已停止";
    default:
      return "本轮完成";
  }
}

export function traceStatus(status: RunStatusValue): TraceStatus {
  if (status === "error") return "error";
  if (status === "queued" || status === "running") return "running";
  return "done";
}
