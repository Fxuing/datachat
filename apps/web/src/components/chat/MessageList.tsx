import { useEffect, useRef, useState } from "react";
import { ArrowDown, Bot } from "lucide-react";
import type { ChatArtifact, ChatMessage, ChatModelInfo } from "../../lib/api";
import type { RunStreamState } from "../../lib/run-events";
import { PageSpinner } from "../ui/spinner";
import { BrandMark } from "../BrandMark";
import { ChartCard, chartOptionFromSpec } from "./ChartCard";
import { MarkdownText, MessageItem, UserBubble } from "./MessageItem";
import { QueryPairList } from "./QueryPairList";
import { RunStatus } from "./RunStatus";
import { ToolCard } from "./ToolCard";
import { ThinkingBlock } from "./ThinkingBlock";
import { TurnFooter } from "./TurnFooter";
import { ConversationMinimap } from "./ConversationMinimap";
import { ResultCard } from "./ResultCard";
import { parseReportMarkdown } from "../../lib/report-markdown";

export interface MessageListProps {
  messages: ChatMessage[];
  stream: RunStreamState;
  showStream: boolean;
  optimisticText: string | null;
  optimisticSkill?: string | null;
  loading?: boolean;
  /** Conversation artifacts, used to restore charts for persisted runs. */
  artifacts?: ChatArtifact[];
  /** Turns a result artifact into a report and opens it. */
  onCreateReport?: (artifactId: string) => void;
  /** The run currently streaming, if any (enables feedback once it ends). */
  activeRunId?: string | null;
  /** Models available for retrying a failed turn on another model. */
  models?: ChatModelInfo[];
  /** Run id currently being retried, used to disable its actions. */
  retryingRunId?: string | null;
  onRetry?: (message: ChatMessage, modelId?: string) => void;
}

function AssistantHeader() {
  return (
    <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
      <span className="flex h-5 w-5 items-center justify-center rounded bg-line text-muted">
        <Bot className="h-3.5 w-3.5" />
      </span>
      DataChat
    </div>
  );
}

const examples = [
  { title: "看看数据长什么样", body: "列出所有表，并说明每张表的用途" },
  { title: "做一次趋势分析", body: "orders 表最近 12 个月每月订单量和金额" },
  { title: "按维度拆分", body: "按渠道统计本月新客数，并画成柱状图" },
];

function EmptyChat() {
  return (
    <div className="flex flex-col items-center justify-center gap-8 py-20 text-center">
      <div className="relative">
        <span className="absolute inset-0 -z-10 rounded-full bg-brand/20 blur-2xl" />
        <BrandMark size={60} className="rounded-[14px] shadow-card" />
      </div>
      <div>
        <p className="text-lg font-semibold tracking-tight text-ink">开始新的对话</p>
        <p className="mt-1.5 text-sm text-muted">
          选择左侧会话，或直接描述你想了解的数据问题
        </p>
      </div>
      <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-3">
        {examples.map((example) => (
          <div
            key={example.title}
            className="rounded-xl border border-line bg-surface/70 p-3 text-left shadow-card"
          >
            <p className="text-[12px] font-medium text-inksoft">{example.title}</p>
            <p className="mt-1 text-[11px] leading-5 text-muted">{example.body}</p>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted/80">
        需要先在「管理 → 数据源」完成连接配置
      </p>
    </div>
  );
}

export function MessageList({
  messages,
  stream,
  showStream,
  optimisticText,
  optimisticSkill = null,
  loading = false,
  artifacts = [],
  onCreateReport,
  activeRunId = null,
  models = [],
  retryingRunId = null,
  onRetry,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const hasContent = messages.length > 0 || showStream;
  const streamSegments = parseReportMarkdown(stream.text);
  const referencedCharts = new Set(
    streamSegments
      .filter((segment) => segment.type === "chart")
      .map((segment) => segment.artifactId),
  );
  const standaloneCharts = stream.charts.filter(
    (chart) => !referencedCharts.has(chart.chartArtifactId),
  );
  // Charts only settle into their final place once the run finishes. Rendering
  // them mid-stream makes them jump from the fallback slot into an inline
  // placeholder as soon as the model writes it.
  const chartsReady = stream.status === "ok" || stream.status === "error";

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onScroll = () => {
      const nearBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      stickToBottom.current = nearBottom;
      setShowJump((visible) => (visible === !nearBottom ? visible : !nearBottom));
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    bottomRef.current?.scrollIntoView?.({ block: "end" });
    setShowJump(false);
  }, [
    messages.length,
    optimisticText,
    stream.text,
    stream.thinking,
    stream.status,
    stream.tools.length,
    stream.sqls.length,
    stream.results.length,
    stream.charts.length,
  ]);

  if (loading && !hasContent) {
    return (
      <div className="flex-1 overflow-y-auto">
        <PageSpinner label="加载会话…" />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(ellipse_60%_40%_at_50%_0%,rgb(var(--brand)/0.06),transparent_70%)]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        {!hasContent ? <EmptyChat /> : null}

        {messages.map((message) => (
          <div key={message.runId} id={`turn-${message.runId}`}>
            <MessageItem
              message={message}
              artifacts={artifacts}
              models={models}
              retrying={retryingRunId === message.runId}
              onCreateReport={onCreateReport}
              onRetry={onRetry}
            />
          </div>
        ))}

        {showStream ? (
          <div className="flex flex-col gap-3">
            {optimisticText ? (
              <UserBubble
                content={optimisticText}
                skill={optimisticSkill}
                pending={stream.status === "idle" || stream.status === "queued"}
              />
            ) : null}
            <div className="flex flex-col gap-2">
              <AssistantHeader />
              <ThinkingBlock
                thinking={stream.thinking}
                running={stream.status === "running"}
              />
              {streamSegments.map((segment, index) => {
                if (segment.type === "markdown") {
                  const content = chartsReady
                    ? segment.content
                    : segment.content.replace(/\[\[(?:chart|artifact):[^\]\s]*$/, "");
                  return content.trim() ? (
                    <MarkdownText key={`md-${index}`} content={content} />
                  ) : null;
                }
                if (segment.type === "artifact") {
                  const result = stream.results.find(
                    (item) => item.artifactId === segment.artifactId,
                  );
                  return result ? (
                    <ResultCard key={`result-${index}`} {...result} />
                  ) : null;
                }
                if (!chartsReady) return null;
                const chart = stream.charts.find(
                  (item) => item.chartArtifactId === segment.artifactId,
                );
                return chart ? (
                  <ChartCard
                    key={`chart-${index}`}
                    title={chart.title}
                    option={chartOptionFromSpec(chart.spec)}
                    points={chart.points}
                  />
                ) : null;
              })}
              {chartsReady && standaloneCharts.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {standaloneCharts.map((chart) => (
                    <ChartCard
                      key={chart.chartArtifactId}
                      title={chart.title}
                      option={chartOptionFromSpec(chart.spec)}
                      points={chart.points}
                    />
                  ))}
                </div>
              ) : null}
              {stream.notices.map((notice, index) => (
                <p key={`${notice.kind}-${index}`} className="text-[11px] text-warning">
                  {notice.message}
                </p>
              ))}
              {stream.connection === "reconnecting" ? (
                <p className="text-[11px] text-muted">连接中断，正在重连…</p>
              ) : null}
              <RunStatus state={stream} />
              <TurnFooter
                runId={activeRunId}
                status={stream.status}
                usage={stream.usage}
                durationMs={stream.durationMs}
                stepCount={stream.tools.length}
              >
                {stream.sqls.length > 0 || stream.results.length > 0 ? (
                  <QueryPairList
                    sqls={stream.sqls}
                    results={stream.results}
                    onCreateReport={onCreateReport}
                  />
                ) : null}
                {stream.tools.some(
                  (tool) => tool.name !== "db_query" && tool.name !== "db_explain",
                ) ? (
                  <div className="flex flex-col gap-1.5">
                    {stream.tools
                      .filter(
                        (tool) =>
                          tool.name !== "db_query" && tool.name !== "db_explain",
                      )
                      .map((tool) => (
                        <ToolCard key={tool.toolCallId} tool={tool} />
                      ))}
                  </div>
                ) : null}
              </TurnFooter>
            </div>
          </div>
        ) : null}

        <div ref={bottomRef} />
        </div>
      </div>
      <ConversationMinimap messages={messages} containerRef={containerRef} />
      {showJump ? (
        <button
          type="button"
          aria-label="回到底部"
          onClick={() => {
            const el = containerRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            stickToBottom.current = true;
            setShowJump(false);
          }}
          className="absolute bottom-4 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-inksoft shadow-pop transition-colors hover:bg-subtle"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
