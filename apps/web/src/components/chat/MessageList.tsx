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

export interface MessageListProps {
  messages: ChatMessage[];
  stream: RunStreamState;
  showStream: boolean;
  optimisticText: string | null;
  loading?: boolean;
  /** Conversation artifacts, used to restore charts for persisted runs. */
  artifacts?: ChatArtifact[];
}

function AssistantHeader() {
  return (
    <div className="flex items-center gap-2 text-[11px] font-medium text-neutral-400">
      <span className="flex h-5 w-5 items-center justify-center rounded bg-neutral-200 text-neutral-600">
        <Bot className="h-3.5 w-3.5" />
      </span>
      DataChat
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="rounded-lg border border-neutral-200 bg-white">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs text-neutral-500 hover:text-neutral-700">
        思考过程
      </summary>
      <div className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-neutral-100 px-3 py-2 text-xs leading-relaxed text-neutral-500">
        {text}
      </div>
    </details>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-200 text-neutral-500">
        <MessageSquare className="h-5 w-5" />
      </span>
      <div>
        <p className="text-sm font-medium text-neutral-800">开始新的对话</p>
        <p className="mt-1 text-xs text-neutral-500">向你的数据库提问，例如「orders 表本月有多少订单？」</p>
      </div>
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
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        {!hasContent ? <EmptyChat /> : null}

        {messages.map((message) => (
          <MessageItem key={message.runId} message={message} artifacts={artifacts} />
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
              {stream.thinking ? <ThinkingBlock text={stream.thinking} /> : null}
              {stream.tools.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {stream.tools.map((tool) => (
                    <ToolCard key={tool.toolCallId} tool={tool} />
                  ))}
                </div>
              ) : null}
              {stream.sqls.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {stream.sqls.map((sql) => (
                    <SqlCard key={sql.auditId} sql={sql} />
                  ))}
                </div>
              ) : null}
              {stream.results.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {stream.results.map((result) => (
                    <ResultTable key={result.artifactId} {...result} />
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
                <p key={`${notice.kind}-${index}`} className="text-[11px] text-amber-600">
                  {notice.message}
                </p>
              ))}
              {stream.connection === "reconnecting" ? (
                <p className="text-[11px] text-neutral-400">连接中断，正在重连…</p>
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
