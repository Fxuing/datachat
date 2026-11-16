import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileText } from "lucide-react";
import type { ChatResult, ChatSql, ChatUsage } from "../../lib/api";
import type { QueryPair } from "../../lib/pair-queries";
import type { RunStatusValue } from "../../lib/run-events";
import { Trace, TraceLine, type TraceStatus } from "../trace";
import { ResultCard } from "./ResultCard";
import { SqlCard } from "./SqlCard";
import { TOOL_TITLES, traceLabel, traceStatus, type TurnTool } from "./turn-trace-model";

export interface TurnTraceProps {
  status: RunStatusValue;
  /** Reasoning split where tool calls interrupted it, oldest first. */
  thinkingSegments?: string[] | null;
  /** Shorthand for a transcript that was never split into segments. */
  thinking?: string | null;
  tools?: TurnTool[];
  /** SQL paired with the rows it produced; see `pairQueries`. */
  queries?: QueryPair<ChatResult>[];
  durationMs?: number | null;
  /** Token usage of the turn, shown after the duration on the summary line. */
  usage?: ChatUsage | null;
  onCreateReport?: (artifactId: string) => void;
  canExport?: boolean;
  className?: string;
}

interface TurnStep {
  key: string;
  title: string;
  status: TraceStatus;
  description?: ReactNode;
  durationMs?: number | null;
  detail?: ReactNode;
  /** The title is the model's own words rather than a step name. */
  reasoning?: boolean;
  /** Live output the reader is waiting on (reasoning while it streams). */
  defaultOpen?: boolean;
}

/** Reasoning follows the live stream, then folds with its line once the turn
 * settles so the answer stays compact.
 *
 * Only the stretch still being written follows the bottom; a finished one opens
 * at its first line, so opening it to read never drops the reader at the end. */
function ThinkingDetail({ text, live = false }: { text: string; live?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (node && live) node.scrollTop = node.scrollHeight;
  }, [text, live]);

  return (
    <div
      ref={ref}
      data-testid="turn-thinking"
      className="max-h-80 overflow-y-auto whitespace-pre-wrap text-[12px] leading-6 text-muted"
    >
      {text || "…"}
    </div>
  );
}

function hasArgs(args: unknown): boolean {
  if (args === null || args === undefined) return false;
  if (typeof args === "object") {
    return Object.keys(args as Record<string, unknown>).length > 0;
  }
  return true;
}

function QueryDetail({
  sql,
  result,
  onCreateReport,
  canExport,
}: {
  sql: ChatSql;
  result?: ChatResult;
  onCreateReport?: (artifactId: string) => void;
  canExport: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      <SqlCard sql={sql} flat />
      {result ? (
        <div className="border-t border-line">
          <ResultCard
            {...result}
            sql={undefined}
            flat
            onCreateReport={onCreateReport}
            canExport={canExport}
          />
        </div>
      ) : null}
    </div>
  );
}

function ToolDetail({ tool }: { tool: TurnTool }) {
  return (
    <>
      {tool.url && tool.status !== "error" ? (
        <Link
          to={tool.url}
          className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-brandtext hover:underline"
        >
          <FileText className="h-3.5 w-3.5" />
          查看报告
        </Link>
      ) : null}
      {hasArgs(tool.args) ? (
        <pre className="max-h-48 overflow-auto rounded border border-line bg-subtle px-2 py-1.5 text-[11px] leading-relaxed text-muted">
          {JSON.stringify(tool.args, null, 2)}
        </pre>
      ) : null}
    </>
  );
}

/** Reasoning arrives in stretches: the model thinks, calls a tool, thinks again. */
function reasoningSegments(
  segments: string[] | null | undefined,
  thinking: string | null | undefined,
): string[] {
  const list = segments && segments.length > 0 ? segments : thinking ? [thinking] : [];
  // Blank entries are the boundaries left behind by a tool call: they keep the
  // indexes aligned with the tool list, so they are trimmed but preserved.
  return list.map((segment) => segment.trim());
}

/** One line of the thought so the chain reads without expanding.
 *
 * The row itself is `truncate`, so the browser does the cutting at whatever
 * width the layout gives it — no character budget, no gap on wide screens.
 * All this does is collapse the paragraph breaks into the same line. */
function gist(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function thinkingStep({
  key,
  text,
  streaming,
}: {
  key: string;
  text: string;
  streaming: boolean;
}): TurnStep {
  return {
    key,
    // The reasoning row reads as the model's own line of thought: no label in
    // front of it, just the opening of what it wrote.
    title: text ? gist(text) : "…",
    reasoning: true,
    status: streaming ? "running" : "done",
    detail: <ThinkingDetail text={text} live={streaming} />,
    // Always folded: the summary line updates in place, and a streaming detail
    // body would make the list jump around while the model types. One click
    // still opens the full text.
    defaultOpen: false,
  };
}

function queryStep(
  pair: QueryPair<ChatResult>,
  tool: TurnTool | undefined,
  onCreateReport: ((artifactId: string) => void) | undefined,
  canExport: boolean,
): TurnStep {
  const { sql, result } = pair;
  const rejected = sql.status === "rejected";
  const failed = sql.status === "error";

  return {
    key: `query-${sql.auditId}`,
    title: failed ? "查询失败" : rejected ? "查询被拒绝" : "执行查询",
    status: failed || rejected ? "error" : "done",
    description: result ? `${result.rowCount} 行` : (tool?.summary ?? undefined),
    durationMs: tool?.durationMs ?? null,
    detail: (
      <QueryDetail
        sql={sql}
        result={result}
        onCreateReport={onCreateReport}
        canExport={canExport}
      />
    ),
  };
}

function toolStep(tool: TurnTool): TurnStep {
  const failed = tool.status === "error";
  const label = TOOL_TITLES[tool.name] ?? tool.name;
  const showUrl = Boolean(tool.url) && !failed;

  return {
    key: `tool-${tool.toolCallId}`,
    title: failed ? `${label}失败` : label,
    status: tool.status === "running" ? "running" : failed ? "error" : "done",
    description: tool.summary ?? undefined,
    durationMs: tool.durationMs ?? null,
    detail: showUrl || hasArgs(tool.args) ? <ToolDetail tool={tool} /> : undefined,
  };
}

function buildTurnSteps({
  status,
  thinkingSegments,
  thinking,
  tools,
  queries,
  onCreateReport,
  canExport,
}: {
  status: RunStatusValue;
  thinkingSegments?: string[] | null;
  thinking?: string | null;
  tools: TurnTool[];
  queries: QueryPair<ChatResult>[];
  onCreateReport?: (artifactId: string) => void;
  canExport: boolean;
}): TurnStep[] {
  // One entry per reasoning stretch; empty entries mark a tool boundary, so the
  // last entry is only "still being written" while the run is live.
  const segments = reasoningSegments(thinkingSegments, thinking);
  const live = status === "running";
  const steps: TurnStep[] = [];

  // Segment i is what the model thought before tool i, which is how the run
  // alternates 思考 → 执行 → 思考 → 执行.
  const pushReasoning = (index: number): void => {
    const text = segments[index];
    if (!text) return;
    const streaming = live && index === segments.length - 1;
    steps.push(thinkingStep({ key: `thinking-${index}`, text, streaming }));
  };

  const queryTools = tools.filter((item) => item.name === "db_query");
  const querySteps = queries.map((pair, index) =>
    queryStep(pair, queryTools[index], onCreateReport, canExport),
  );

  // `db_query` tools and recorded SQL describe the same step: prefer the SQL
  // (it knows the rows) and keep everything else in execution order.
  let nextQuery = 0;
  tools.forEach((tool, index) => {
    pushReasoning(index);
    if (tool.name !== "db_query") {
      steps.push(toolStep(tool));
      return;
    }
    const step = querySteps[nextQuery];
    if (step) {
      steps.push(step);
      nextQuery += 1;
      return;
    }
    // No recorded statement yet (in flight) or ever (rejected before running):
    // the call still deserves a line of its own.
    steps.push(toolStep(tool));
  });

  // Reasoning produced after the last tool call.
  for (let index = tools.length; index < segments.length; index += 1) pushReasoning(index);

  // Nothing has arrived yet: show that the model is thinking.
  if (live && steps.length === 0) {
    steps.push(thinkingStep({ key: "thinking", text: "", streaming: true }));
  }

  steps.push(...querySteps.slice(nextQuery));

  return steps;
}

/** One turn's process (reasoning, tool calls, SQL) as an expandable trace. */
export function TurnTrace({
  status,
  thinkingSegments,
  thinking,
  tools = [],
  queries = [],
  durationMs,
  usage,
  onCreateReport,
  canExport = true,
  className,
}: TurnTraceProps) {
  const steps = buildTurnSteps({
    status,
    thinkingSegments,
    thinking,
    tools,
    queries,
    onCreateReport,
    canExport,
  });
  if (steps.length === 0) return null;

  return (
    <Trace
      label={traceLabel(status)}
      status={traceStatus(status)}
      stepCount={steps.length}
      durationMs={durationMs ?? null}
      tokens={usage ? usage.input + usage.output : null}
      tokensHint={
        usage
          ? `输入 ${usage.input} · 输出 ${usage.output} · 缓存读 ${usage.cacheRead} · 缓存写 ${usage.cacheWrite}`
          : undefined
      }
      className={className}
    >
      {steps.map((step) => (
        <TraceLine
          key={step.key}
          title={step.title}
          description={step.description}
          reasoning={step.reasoning}
          status={step.status}
          durationMs={step.durationMs}
          defaultOpen={step.defaultOpen}
        >
          {step.detail}
        </TraceLine>
      ))}
    </Trace>
  );
}
