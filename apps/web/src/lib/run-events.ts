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
  url?: string;
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
  sql?: string;
}

export interface RunChartState {
  chartArtifactId: string;
  /** Persisted ECharts spec (`{option, chart}`), as emitted by `make_chart`. */
  spec: Record<string, unknown>;
  points: number;
  title: string;
}

export interface RunQuestionOption {
  label: string;
  description: string;
  hasPreview: boolean;
}

export interface RunQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: RunQuestionOption[];
}

export interface RunContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface RunQuestionState {
  toolCallId: string;
  questions: RunQuestion[];
}

export interface RunNotice {
  kind: "retry" | "compaction";
  message: string;
}

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RunStreamState {
  status: RunStatusValue;
  connection: RunConnection;
  text: string;
  /** Reasoning in the order it arrived; a tool call starts a new segment. */
  thinkingSegments: string[];
  tools: RunToolState[];
  sqls: RunSqlState[];
  results: RunResultState[];
  charts: RunChartState[];
  questions: RunQuestionState[];
  contextUsage: RunContextUsage | null;
  usage: RunUsage | null;
  startedAt: number | null;
  durationMs: number | null;
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
  thinkingSegments: [""],
  tools: [],
  sqls: [],
  results: [],
  charts: [],
  questions: [],
  contextUsage: null,
  usage: null,
  startedAt: null,
  durationMs: null,
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

/** Chart events can be replayed on reconnect, so dedupe by chart artifact id. */
function upsertChart(charts: RunChartState[], patch: RunChartState): RunChartState[] {
  const index = charts.findIndex(
    (chart) => chart.chartArtifactId === patch.chartArtifactId,
  );
  if (index === -1) return [...charts, patch];
  return charts.map((chart, current) => (current === index ? patch : chart));
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
          return {
            ...base,
            status: "running",
            queuePosition: null,
            startedAt: event.payload.startedAt,
          };
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
        case "thinking_delta": {
          const segments = [...state.thinkingSegments];
          const last = segments.length - 1;
          segments[last] = `${segments[last] ?? ""}${event.payload.text}`;
          return { ...base, thinkingSegments: segments };
        }
        case "tool_start":
          return {
            ...base,
            // The model reasons again after the tool result: start a new stretch.
            thinkingSegments: [...state.thinkingSegments, ""],
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
              url: event.payload.url,
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
              ...(event.payload.sql ? { sql: event.payload.sql } : {}),
            }),
          };
        case "chart":
          return {
            ...base,
            charts: upsertChart(state.charts, {
              chartArtifactId: event.payload.chartArtifactId,
              spec: event.payload.spec,
              points: event.payload.points,
              title: event.payload.title,
            }),
          };
        case "question":
          return {
            ...base,
            questions: [
              ...state.questions.filter((item) => item.toolCallId !== event.payload.toolCallId),
              { toolCallId: event.payload.toolCallId, questions: event.payload.questions },
            ],
          };
        case "question_resolved":
          return {
            ...base,
            questions: state.questions.filter(
              (item) => item.toolCallId !== event.payload.toolCallId,
            ),
          };
        case "retry":
          return {
            ...base,
            text: "",
            thinkingSegments: [""],
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
            durationMs:
              base.startedAt !== null ? Math.max(0, Date.now() - base.startedAt) : null,
            connection: "closed",
          };
        case "context_usage":
          return { ...base, contextUsage: event.payload };
        case "usage":
          return { ...base, usage: event.payload };
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
