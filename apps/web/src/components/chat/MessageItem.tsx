import { Link } from "react-router-dom";
import { Bot, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  getArtifact,
  type ChatArtifact,
  type ChatMessage,
  type ChatModelInfo,
  type ChatResult,
} from "../../lib/api";
import { parseChatMarkdown } from "../../lib/report-markdown";
import { pairQueries } from "../../lib/pair-queries";
import { ChartCard, chartOptionFromSpec, chartTitleFromSpec } from "./ChartCard";
import { ResultCard } from "./ResultCard";
import { ResultLink } from "./ResultLink";
import { TurnTrace } from "./TurnTrace";
import { TurnFooter } from "./TurnFooter";
import { RetryActions } from "./RetryActions";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MermaidDiagram } from "../markdown/MermaidDiagram";
import { mermaidSourceOf } from "../markdown/mermaid-source";

export function MarkdownText({ content }: { content: string }) {
  return (
    <div className="markdown text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
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
          pre({ children }) {
            const chart = mermaidSourceOf(children);
            if (chart) return <MermaidDiagram source={chart} />;
            return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
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
  canExport,
}: {
  artifactId: string;
  results: ChatResult[];
  charts: ChatArtifact[];
  onCreateReport?: (artifactId: string) => void;
  canExport?: boolean;
}) {
  const result = results.find((item) => item.artifactId === artifactId);
  if (result) {
    return <ResultCard {...result} onCreateReport={onCreateReport} canExport={canExport} />;
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

/** Scope rejections carry a structured code; show one actionable hint under the error. */
function scopeHint(error: string | null): string | null {
  if (!error) return null;
  if (error.includes("DATA_SCOPE_NO_DEPARTMENT")) {
    return "你还没有加入任何部门，请联系管理员在「部门管理」中分配。";
  }
  if (error.includes("DATA_SCOPE_MAPPING_MISSING")) {
    return "当前数据源缺少你所属部门的组织映射，请联系管理员补齐后再试。";
  }
  if (error.includes("DATA_SCOPE_TABLE_NOT_CONFIGURED") || error.includes("DATA_SCOPE_DENIED_TABLE")) {
    return "查询涉及未开放给你的表，换一个问法或联系管理员。";
  }
  if (error.includes("DATA_SCOPE_POLICY_STALE")) {
    return "数据权限配置已过期，请联系管理员刷新表结构后重试。";
  }
  if (error.includes("DATA_SCOPE_NOT_VISIBLE") || error.includes("SHARE_DISABLED_BY_SCOPE")) {
    return "该内容超出你当前的部门范围，或对应数据源已启用行级权限。";
  }
  return null;
}

export function MessageItem({
  message,
  artifacts = [],
  models = [],
  retrying = false,
  onCreateReport,
  canExport = true,
  onRetry,
}: {
  message: ChatMessage;
  artifacts?: ChatArtifact[];
  models?: ChatModelInfo[];
  retrying?: boolean;
  onCreateReport?: (artifactId: string) => void;
  canExport?: boolean;
  onRetry?: (message: ChatMessage, modelId?: string) => void;
}) {
  const assistantText = message.assistant?.content ?? "";
  const charts = artifacts.filter(
    (artifact) => artifact.kind === "chart" && artifact.runId === message.runId,
  );
  // Models sometimes paste report-style placeholders into a normal reply. Render
  // them in place instead of showing raw `[[artifact:<id>]]` text, and skip the
  // duplicate card below when the text already references that artifact.
  const segments = parseChatMarkdown(assistantText);
  const referenced = new Set(
    segments
      .filter((segment) => segment.type !== "markdown")
      .map((segment) => segment.artifactId),
  );
  const standaloneResults = message.results.filter(
    (result) => !referenced.has(result.artifactId),
  );
  const standaloneCharts = charts.filter((chart) => !referenced.has(chart.id));
  // SQL and the rows it produced belong inside the trace; results without a
  // recorded statement stay plain cards next to the answer.
  const { pairs, unmatched } = pairQueries(message.sqls, standaloneResults);
  const hasTrace =
    Boolean(message.thinkingSegments?.some((segment) => segment.trim())) ||
    Boolean(message.thinking?.trim()) ||
    Boolean(message.memories?.length) ||
    message.tools.length > 0 ||
    message.sqls.length > 0;

  return (
    <div className="group/turn flex flex-col gap-3">
      <UserBubble content={message.user.content} skill={message.user.skill} />
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
          <span className="flex h-5 w-5 items-center justify-center rounded bg-line text-muted">
            <Bot className="h-3.5 w-3.5" />
          </span>
          DataChat
        </div>
        <TurnTrace
          status={message.status}
          thinkingSegments={message.thinkingSegments}
          thinking={message.thinking}
          tools={message.tools}
          queries={pairs}
          durationMs={message.durationMs}
          usage={message.usage ?? null}
          memories={message.memories}
          onCreateReport={onCreateReport}
          canExport={canExport}
        />
        {message.scope && message.scope.departments.length > 0 ? (
          <div className="flex items-start gap-1.5 rounded-md border border-line bg-subtle px-2.5 py-1.5 text-[11px] text-inksoft">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brandtext" aria-hidden="true" />
            <span>
              数据范围：
              <span className="font-medium text-ink">
                {message.scope.departments.length > 3
                  ? `${message.scope.departments.slice(0, 3).join("、")} 等 ${message.scope.departments.length} 个部门`
                  : message.scope.departments.join("、")}
              </span>
              （含下级部门）。本次结果已按当前数据权限过滤，范围外的数据不会显示。
            </span>
          </div>
        ) : null}
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
              if (segment.type === "result") {
                const result = message.results.find(
                  (item) => item.artifactId === segment.artifactId,
                );
                return result ? (
                  <ResultLink
                    key={`result-${index}`}
                    result={result}
                    canExport={canExport}
                  />
                ) : (
                  <p key={`result-${index}`} className="text-[11px] text-muted">
                    结果引用不可用：
                    <code className="rounded bg-subtle px-1 py-0.5">{segment.artifactId}</code>
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
                  canExport={canExport}
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-xs text-muted">已停止生成</p>
            {onRetry ? (
              <RetryActions
                message={message}
                models={models}
                retrying={retrying}
                onRetry={onRetry}
              />
            ) : null}
          </div>
        ) : null}
        {message.status === "error" ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-xs text-danger">
              {message.error ?? "本次回答失败，请重试。"}
            </p>
            {scopeHint(message.error) ? (
              <p className="w-full text-[11px] text-muted">{scopeHint(message.error)}</p>
            ) : null}
            {onRetry ? (
              <RetryActions
                message={message}
                models={models}
                retrying={retrying}
                onRetry={onRetry}
              />
            ) : null}
          </div>
        ) : null}
        {unmatched.length > 0 ? (
          <div className="flex flex-col gap-2">
            {unmatched.map((item, index) => (
              <ResultCard
                key={item.artifactId}
                {...item}
                index={unmatched.length > 1 ? index + 1 : undefined}
                onCreateReport={onCreateReport}
                canExport={canExport}
              />
            ))}
          </div>
        ) : null}
        <TurnFooter
          runId={message.runId}
          status={message.status}
          usage={hasTrace ? null : (message.usage ?? null)}
          durationMs={hasTrace ? null : (message.durationMs ?? null)}
          feedback={message.feedback ?? null}
        />
      </div>
    </div>
  );
}
