import { useEffect, useRef } from "react";
import { Bot, MessageSquare } from "lucide-react";
import type { ChatArtifact, ChatMessage } from "../../lib/api";
import type { RunStreamState } from "../../lib/run-events";
import { PageSpinner } from "../ui/spinner";
import { ChartCard, chartOptionFromSpec } from "./ChartCard";
import { MarkdownText, MessageItem, UserBubble } from "./MessageItem";
import { ResultTable } from "./ResultTable";
import { RunStatus } from "./RunStatus";
import { SqlCard } from "./SqlCard";
import { ToolCard } from "./ToolCard";
import { ProcessBlock } from "./ProcessBlock";

export interface MessageListProps {
  messages: ChatMessage[];
  stream: RunStreamState;
  showStream: boolean;
  optimisticText: string | null;
  loading?: boolean;
  /** Conversation artifacts, used to restore charts for persisted runs. */
  artifacts?: ChatArtifact[];
  /** Turns a result artifact into a report and opens it. */
  onCreateReport?: (artifactId: string) => void;
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
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface text-brandtext shadow-card">
          <MessageSquare className="h-6 w-6" />
        </span>
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
  loading = false,
  artifacts = [],
  onCreateReport,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasContent = messages.length > 0 || showStream;

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
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
    <div className="flex-1 overflow-y-auto bg-[radial-gradient(ellipse_60%_40%_at_50%_0%,rgb(var(--brand)/0.06),transparent_70%)]">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        {!hasContent ? <EmptyChat /> : null}

        {messages.map((message) => (
          <MessageItem
            key={message.runId}
            message={message}
            artifacts={artifacts}
            onCreateReport={onCreateReport}
          />
        ))}

        {showStream ? (
          <div className="flex flex-col gap-3">
            {optimisticText ? (
              <UserBubble
                content={optimisticText}
                pending={stream.status === "idle" || stream.status === "queued"}
              />
            ) : null}
            <div className="flex flex-col gap-2">
              <AssistantHeader />
              <ProcessBlock
                thinking={stream.thinking}
                toolCount={stream.tools.length}
                sqlCount={stream.sqls.length}
                running={stream.status === "running"}
                defaultOpen={stream.status === "running"}
                tools={
                  stream.tools.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {stream.tools.map((tool) => (
                        <ToolCard key={tool.toolCallId} tool={tool} />
                      ))}
                    </div>
                  ) : null
                }
                sqls={
                  stream.sqls.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {stream.sqls.map((sql) => (
                        <SqlCard key={sql.auditId} sql={sql} />
                      ))}
                    </div>
                  ) : null
                }
              />
              {stream.results.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {stream.results.map((result) => (
                    <ResultTable
                      key={result.artifactId}
                      {...result}
                      onCreateReport={onCreateReport}
                    />
                  ))}
                </div>
              ) : null}
              {stream.charts.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {stream.charts.map((chart) => (
                    <ChartCard
                      key={chart.chartArtifactId}
                      title={chart.title}
                      option={chartOptionFromSpec(chart.spec)}
                      points={chart.points}
                    />
                  ))}
                </div>
              ) : null}
              {stream.text ? <MarkdownText content={stream.text} /> : null}
              {stream.notices.map((notice, index) => (
                <p key={`${notice.kind}-${index}`} className="text-[11px] text-warning">
                  {notice.message}
                </p>
              ))}
              {stream.connection === "reconnecting" ? (
                <p className="text-[11px] text-muted">连接中断，正在重连…</p>
              ) : null}
              <RunStatus state={stream} />
            </div>
          </div>
        ) : null}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
