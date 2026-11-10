import { Link } from "react-router-dom";
import { Bot, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { getArtifact, type ChatArtifact, type ChatMessage, type ChatResult } from "../../lib/api";
import { parseReportMarkdown } from "../../lib/report-markdown";
import { ChartCard, chartOptionFromSpec, chartTitleFromSpec } from "./ChartCard";
import { ResultCard } from "./ResultCard";
import { QueryPairList } from "./QueryPairList";
import { ToolCard } from "./ToolCard";
import { ThinkingBlock } from "./ThinkingBlock";
import { TurnFooter } from "./TurnFooter";

export function MarkdownText({ content }: { content: string }) {
  return (
    <div className="markdown text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code({ className, children, node: _node, ...props }) {
            const text = String(children).trim();
            if (!className && /^\/reports\/[0-9a-fA-F-]{36}$/.test(text)) {
              return (
                <Link
                  to={text}
                  className="rounded bg-brandsoft px-1 py-0.5 font-mono text-[0.85em] text-brandtext hover:underline"
                >
                  {text}
                </Link>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
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

export function UserBubble({
  content,
  skill,
  pending = false,
}: {
  content: string;
  skill?: string | null;
  pending?: boolean;
}) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-sm text-canvas shadow-sm">
        {skill ? (
          <span className="mb-1 flex w-fit items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white/75">
            <Sparkles className="h-2.5 w-2.5" />
            技能 · {skill}
          </span>
        ) : null}
        <div className="whitespace-pre-wrap">{content}</div>
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

function InlineArtifact({
  artifactId,
  results,
  charts,
  onCreateReport,
}: {
  artifactId: string;
  results: ChatResult[];
  charts: ChatArtifact[];
  onCreateReport?: (artifactId: string) => void;
}) {
  const result = results.find((item) => item.artifactId === artifactId);
  if (result) {
    return <ResultCard {...result} onCreateReport={onCreateReport} />;
  }
  const chart = charts.find((item) => item.id === artifactId);
  if (chart) {
    return <HistoricalChart artifact={chart} />;
  }
  return (
    <p className="text-[11px] text-muted">
      结果引用不可用：<code className="rounded bg-subtle px-1 py-0.5">{artifactId}</code>
    </p>
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
  // Models sometimes paste report-style placeholders into a normal reply. Render
  // them in place instead of showing raw `[[artifact:<id>]]` text, and skip the
  // duplicate card below when the text already references that artifact.
  const segments = parseReportMarkdown(assistantText);
  const referenced = new Set(
    segments
      .filter((segment) => segment.type !== "markdown")
      .map((segment) => segment.artifactId),
  );
  const standaloneResults = message.results.filter(
    (result) => !referenced.has(result.artifactId),
  );
  const standaloneCharts = charts.filter((chart) => !referenced.has(chart.id));
  const detailTools = message.tools.filter(
    (tool) => tool.name !== "db_query" && tool.name !== "db_explain",
  );
  const stepCount =
    message.tools.length || message.sqls.length + standaloneResults.length;

  return (
    <div className="flex flex-col gap-3">
      <UserBubble content={message.user.content} skill={message.user.skill} />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-line text-muted">
            <Bot className="h-3.5 w-3.5" />
          </span>
          DataChat
        </div>
        <ThinkingBlock thinking={message.thinking ?? ""} />
        {assistantText ? (
          <div className="flex flex-col gap-2">
            {segments.map((segment, index) => {
              if (segment.type === "markdown") {
                return segment.content.trim() ? (
                  <MarkdownText key={`md-${index}`} content={segment.content} />
                ) : null;
              }
              if (segment.type === "chart") {
                const chart = charts.find((item) => item.id === segment.artifactId);
                return chart ? (
                  <HistoricalChart key={`chart-${index}`} artifact={chart} />
                ) : (
                  <p key={`chart-${index}`} className="text-[11px] text-muted">
                    图表引用不可用
                  </p>
                );
              }
              return (
                <InlineArtifact
                  key={`artifact-${index}`}
                  artifactId={segment.artifactId}
                  results={message.results}
                  charts={charts}
                  onCreateReport={onCreateReport}
                />
              );
            })}
          </div>
        ) : null}
        {standaloneCharts.length > 0 ? (
          <div className="flex flex-col gap-2">
            {standaloneCharts.map((chart) => (
              <HistoricalChart key={chart.id} artifact={chart} />
            ))}
          </div>
        ) : null}
        {message.status === "aborted" ? (
          <p className="text-xs text-muted">已停止生成</p>
        ) : null}
        {message.status === "error" && !assistantText ? (
          <p className="text-xs text-danger">
            {message.error ?? "本次回答失败，请重试。"}
          </p>
        ) : null}
        <TurnFooter
          runId={message.runId}
          status={message.status}
          usage={message.usage ?? null}
          durationMs={message.durationMs ?? null}
          feedback={message.feedback ?? null}
          stepCount={stepCount}
        >
          {standaloneResults.length > 0 || message.sqls.length > 0 ? (
            <QueryPairList
              sqls={message.sqls}
              results={standaloneResults}
              onCreateReport={onCreateReport}
            />
          ) : null}
          {detailTools.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {detailTools.map((tool) => (
                <ToolCard key={tool.toolCallId} tool={tool} />
              ))}
            </div>
          ) : null}
        </TurnFooter>
      </div>
    </div>
  );
}
