import { Link } from "react-router-dom";
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { getArtifact, type ChatArtifact, type ChatMessage } from "../../lib/api";
import { ChartCard, chartOptionFromSpec, chartTitleFromSpec } from "./ChartCard";
import { ResultTable } from "./ResultTable";
import { SqlCard } from "./SqlCard";
import { ToolCard } from "./ToolCard";

export function MarkdownText({ content }: { content: string }) {
  return (
    <div className="markdown text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a({ href, children, node: _node, ...props }) {
            if (href?.startsWith("/") && !href.startsWith("//")) {
              return (
                <Link to={href} {...props}>
                  {children}
                </Link>
              );
            }
            return (
              <a href={href} {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function UserBubble({ content, pending = false }: { content: string; pending?: boolean }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm text-canvas shadow-sm">
        {content}
        {pending ? <span className="ml-2 text-[10px] text-muted">发送中…</span> : null}
      </div>
    </div>
  );
}

/**
 * Historical charts come from the conversation detail's artifacts. When the
 * detail omitted the spec (legacy row or malformed JSON), fetch the artifact.
 */
function HistoricalChart({ artifact }: { artifact: ChatArtifact }) {
  const hasSpec = artifact.spec !== null && artifact.spec !== undefined;
  const [spec, setSpec] = useState<unknown>(artifact.spec);
  const [status, setStatus] = useState<"ready" | "loading" | "failed">(
    hasSpec ? "ready" : "loading",
  );

  useEffect(() => {
    setSpec(artifact.spec);
    setStatus(artifact.spec !== null && artifact.spec !== undefined ? "ready" : "loading");
    if (artifact.spec !== null && artifact.spec !== undefined) return;

    let cancelled = false;
    getArtifact(artifact.id)
      .then((detail) => {
        if (cancelled) return;
        setSpec(detail.spec);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.spec]);

  if (status === "failed") {
    return <p className="text-[11px] text-muted">图表加载失败</p>;
  }
  if (status === "loading") {
    return <p className="text-[11px] text-muted">图表加载中…</p>;
  }
  return (
    <ChartCard
      title={chartTitleFromSpec(spec)}
      option={chartOptionFromSpec(spec)}
      points={artifact.rowCount}
    />
  );
}

export function MessageItem({
  message,
  artifacts = [],
  onCreateReport,
}: {
  message: ChatMessage;
  artifacts?: ChatArtifact[];
  onCreateReport?: (artifactId: string) => void;
}) {
  const assistantText = message.assistant?.content ?? "";
  const charts = artifacts.filter(
    (artifact) => artifact.kind === "chart" && artifact.runId === message.runId,
  );

  return (
    <div className="flex flex-col gap-3">
      <UserBubble content={message.user.content} />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-line text-muted">
            <Bot className="h-3.5 w-3.5" />
          </span>
          DataChat
        </div>
        {message.tools.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {message.tools.map((tool) => (
              <ToolCard key={tool.toolCallId} tool={tool} />
            ))}
          </div>
        ) : null}
        {message.sqls.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {message.sqls.map((sql) => (
              <SqlCard key={sql.auditId} sql={sql} />
            ))}
          </div>
        ) : null}
        {message.results.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {message.results.map((result) => (
              <ResultTable
                key={result.artifactId}
                {...result}
                onCreateReport={onCreateReport}
              />
            ))}
          </div>
        ) : null}
        {charts.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {charts.map((chart) => (
              <HistoricalChart key={chart.id} artifact={chart} />
            ))}
          </div>
        ) : null}
        {assistantText ? <MarkdownText content={assistantText} /> : null}
        {message.status === "aborted" ? (
          <p className="text-xs text-muted">已停止生成</p>
        ) : null}
        {message.status === "error" && !assistantText ? (
          <p className="text-xs text-danger">
            {message.error ?? "本次回答失败，请重试。"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
