import type { Column, RunEvent } from "@datachat/shared";

export type RunStatusValue = "idle" | "queued" | "running" | "ok" | "error" | "aborted";

export type RunConnection = "idle" | "connecting" | "reconnecting" | "open" | "closed";

export interface RunToolState {
  toolCallId: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  durationMs?: number;
  summary?: string;
}

export interface RunSqlState {
  auditId: string;
  sql: string;
  status: "ok" | "rejected" | "error";
}

export interface RunResultState {
  artifactId: string;
  columns: Column[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export interface RunNotice {
  kind: "retry" | "compaction";
  message: string;
}

export interface RunStreamState {
  status: RunStatusValue;
  connection: RunConnection;
  text: string;
  thinking: string;
  tools: RunToolState[];
  sqls: RunSqlState[];
  results: RunResultState[];
  notices: RunNotice[];
  error: string | null;
  queuePosition: number | null;
  finalText: string | null;
  lastSeq: number;
}

export const initialRunStreamState: RunStreamState = {
  status: "idle",
  connection: "idle",
  text: "",
  thinking: "",
  tools: [],
  sqls: [],
  results: [],
  notices: [],
  error: null,
  queuePosition: null,
  finalText: null,
  lastSeq: 0,
};

export type RunStreamAction =
  | { type: "reset" }
  | { type: "connection"; connection: RunConnection }
  | { type: "event"; seq: number; event: RunEvent }
  | { type: "failure"; message: string };

function upsertTool(tools: RunToolState[], patch: RunToolState): RunToolState[] {
  const index = tools.findIndex((tool) => tool.toolCallId === patch.toolCallId);
  if (index === -1) return [...tools, patch];
  return tools.map((tool, current) => (current === index ? { ...tool, ...patch } : tool));
}

function upsertSql(sqls: RunSqlState[], patch: RunSqlState): RunSqlState[] {
  const index = sqls.findIndex((sql) => sql.auditId === patch.auditId);
  if (index === -1) return [...sqls, patch];
  return sqls.map((sql, current) => (current === index ? { ...sql, ...patch } : sql));
}

function upsertResult(results: RunResultState[], patch: RunResultState): RunResultState[] {
  const index = results.findIndex((result) => result.artifactId === patch.artifactId);
  if (index === -1) return [...results, patch];
  return results.map((result, current) => (current === index ? patch : result));
}

export function runStreamReducer(
  state: RunStreamState,
  action: RunStreamAction,
): RunStreamState {
  switch (action.type) {
    case "reset":
      return initialRunStreamState;
    case "connection":
      return { ...state, connection: action.connection };
    case "failure":
      return {
        ...state,
        connection: "closed",
        status:
          state.status === "queued" || state.status === "running" ? "error" : state.status,
        error: action.message,
      };
    case "event": {
      if (action.seq > 0 && action.seq <= state.lastSeq) return state;
      const event = action.event;
      const base = { ...state, lastSeq: Math.max(state.lastSeq, action.seq) };

      switch (event.type) {
        case "run_queued":
          return { ...base, status: "queued", queuePosition: event.payload.position, error: null };
        case "run_start":
          return { ...base, status: "running", queuePosition: null };
        case "user_message":
          return base;
        case "assistant_message":
          return {
            ...base,
            finalText: event.payload.content,
            text: state.text.length > 0 ? state.text : event.payload.content,
          };
        case "text_delta":
          return { ...base, text: state.text + event.payload.text };
        case "thinking_delta":
          return { ...base, thinking: state.thinking + event.payload.text };
        case "tool_start":
          return {
            ...base,
            tools: upsertTool(state.tools, {
              toolCallId: event.payload.toolCallId,
              name: event.payload.name,
              args: event.payload.args,
              status: "running",
            }),
          };
        case "tool_end": {
          const existing = state.tools.find(
            (tool) => tool.toolCallId === event.payload.toolCallId,
          );
          return {
            ...base,
            tools: upsertTool(state.tools, {
              toolCallId: event.payload.toolCallId,
              name: event.payload.name,
              args: existing?.args ?? null,
              status: event.payload.isError ? "error" : "ok",
              durationMs: event.payload.durationMs,
              summary: event.payload.summary,
            }),
          };
        }
        case "sql":
          return {
            ...base,
            sqls: upsertSql(state.sqls, {
              auditId: event.payload.auditId,
              sql: event.payload.sql,
              status: event.payload.status,
            }),
          };
        case "result":
          return {
            ...base,
            results: upsertResult(state.results, {
              artifactId: event.payload.artifactId,
              columns: event.payload.columns,
              rows: event.payload.rows,
              rowCount: event.payload.rowCount,
              truncated: event.payload.truncated,
            }),
          };
        case "retry":
          return {
            ...base,
            text: "",
            thinking: "",
            finalText: null,
            notices: [
              ...state.notices,
              {
                kind: "retry",
                message: `上游请求失败，正在重试（第 ${event.payload.attempt} 次，${Math.round(
                  event.payload.delayMs / 1_000,
                )} 秒后）${event.payload.message ? `：${event.payload.message}` : ""}`,
              },
            ],
          };
        case "compaction":
          return {
            ...base,
            notices: [
              ...state.notices,
              {
                kind: "compaction",
                message: `上下文已压缩${event.payload.reason ? `：${event.payload.reason}` : ""}`,
              },
            ],
          };
        case "run_end":
          return {
            ...base,
            status: event.payload.status,
            queuePosition: null,
            error: event.payload.error ?? null,
            connection: "closed",
          };
        case "usage":
        case "chart":
        case "report":
          return base;
        default:
          return base;
      }
    }
    default:
      return state;
  }
}
