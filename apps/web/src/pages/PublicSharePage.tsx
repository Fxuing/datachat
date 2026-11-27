import { Children, isValidElement, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, FileWarning } from "lucide-react";
import type { Column } from "@datachat/shared";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import {
  ChartCard,
  chartOptionFromSpec,
  chartTitleFromSpec,
} from "../components/chat/ChartCard";
import { ConversationMinimap, type MinimapTurn } from "../components/chat/ConversationMinimap";
import { ReportToc, useReportTocActive } from "../components/report/ReportToc";
import { PageSpinner } from "../components/ui/spinner";
import { MermaidDiagram } from "../components/markdown/MermaidDiagram";
import { mermaidSourceOf } from "../components/markdown/mermaid-source";
import {
  ApiError,
  getPublicShare,
  getPublicShareReport,
  type PublicReportArtifact,
  type PublicShare,
  type PublicShareMessage,
} from "../lib/api";
import { parseReportMarkdown } from "../lib/report-markdown";
import { extractReportHeadings, headingId } from "../lib/report-toc";
import { useBranding } from "../lib/branding";
import { cn } from "../lib/utils";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return (
      <span className="text-muted" aria-label="空值">
        ∅
      </span>
    );
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function PublicTable({ columns, rows }: { columns: Column[]; rows: unknown[][] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <div className="max-h-96 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-subtle">
            <tr>
              {columns.map((column, index) => (
                <th
                  key={`${column.name}-${index}`}
                  scope="col"
                  className={cn(
                    "whitespace-nowrap border-b border-line px-3 py-2 font-medium text-muted",
                    column.type === "number" ? "text-right" : "text-left",
                  )}
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-surface even:bg-subtle/50">
                {columns.map((column, columnIndex) => (
                  <td
                    key={`${column.name}-${columnIndex}`}
                    className={cn(
                      "border-b border-line px-3 py-1.5 text-inksoft",
                      column.type === "number" ? "text-right tabular-nums" : "text-left",
                    )}
                  >
                    {renderValue(row[columnIndex])}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(columns.length, 1)}
                  className="px-3 py-4 text-center text-muted"
                >
                  查询结果为空
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line bg-subtle px-3 py-2 text-xs text-muted">
        显示 {rows.length} 行
      </div>
    </div>
  );
}

function PublicPre({ children }: { children?: ReactNode }) {
  const chart = mermaidSourceOf(children);
  return chart ? <MermaidDiagram source={chart} /> : <pre>{children}</pre>;
}

const PUBLIC_REPORT_LINK_RE = /^\/reports\/([0-9a-fA-F-]{36})$/;

function publicReportPath(shareToken: string, reportId: string): string {
  return `/s/${encodeURIComponent(shareToken)}/reports/${reportId}`;
}

function textFromChildren(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return textFromChildren(child.props.children);
      return "";
    })
    .join("");
}

function headingAnchorProps(children: ReactNode) {
  return { id: headingId(textFromChildren(children)), className: "scroll-mt-10" };
}

function PublicMarkdown({
  content,
  shareToken,
  headingAnchors = false,
}: {
  content: string;
  shareToken?: string;
  headingAnchors?: boolean;
}) {
  return (
    <div className="markdown text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={{
          pre: PublicPre,
          ...(headingAnchors
            ? {
                h1: ({ children }) => <h1 {...headingAnchorProps(children)}>{children}</h1>,
                h2: ({ children }) => <h2 {...headingAnchorProps(children)}>{children}</h2>,
                h3: ({ children }) => <h3 {...headingAnchorProps(children)}>{children}</h3>,
              }
            : {}),
          table({ children }) {
            return (
              <div className="overflow-x-auto">
                <table>{children}</table>
              </div>
            );
          },
          code({ className, children, node: _node, ...props }) {
            const text = String(children).trim();
            const reportMatch = !className && shareToken ? PUBLIC_REPORT_LINK_RE.exec(text) : null;
            if (reportMatch?.[1] && shareToken) {
              return (
                <Link
                  to={publicReportPath(shareToken, reportMatch[1])}
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
            const reportMatch = shareToken && href ? PUBLIC_REPORT_LINK_RE.exec(href.trim()) : null;
            if (reportMatch?.[1] && shareToken) {
              return (
                <Link to={publicReportPath(shareToken, reportMatch[1])} {...props}>
                  {children}
                </Link>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
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

function PublicSql({ sql }: { sql: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-subtle">
      <div className="border-b border-line px-3 py-2 text-xs font-medium text-muted">
        SQL
      </div>
      <pre className="overflow-x-auto p-3 text-xs text-inksoft">
        <code>{sql}</code>
      </pre>
    </div>
  );
}

function PublicChart({ spec }: { spec: unknown }) {
  return (
    <ChartCard
      title={chartTitleFromSpec(spec)}
      option={chartOptionFromSpec(spec)}
    />
  );
}

function PublicMessage({
  message,
  shareToken,
}: {
  message: PublicShareMessage;
  shareToken?: string;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-ink px-4 py-2.5 text-sm text-canvas shadow-sm">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {message.text ? <PublicMarkdown content={message.text} shareToken={shareToken} /> : null}
      {message.sql ? <PublicSql sql={message.sql} /> : null}
      {message.columns && message.rows ? (
        <PublicTable columns={message.columns} rows={message.rows} />
      ) : null}
      {message.chart !== undefined ? <PublicChart spec={message.chart} /> : null}
    </div>
  );
}

function PublicArtifact({ artifact }: { artifact: PublicReportArtifact }) {
  if (artifact.kind === "chart") {
    return <PublicChart spec={artifact.spec} />;
  }
  return <PublicTable columns={artifact.columns ?? []} rows={artifact.rows ?? []} />;
}

interface PublicConversationTurn {
  id: string;
  user: PublicShareMessage;
  assistantMessages: PublicShareMessage[];
}

function groupPublicConversationTurns(messages: PublicShareMessage[]): {
  preamble: PublicShareMessage[];
  turns: PublicConversationTurn[];
} {
  const preamble: PublicShareMessage[] = [];
  const turns: PublicConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({
        id: `share-turn-${turns.length + 1}`,
        user: message,
        assistantMessages: [],
      });
    } else if (turns.length > 0) {
      turns[turns.length - 1]!.assistantMessages.push(message);
    } else {
      preamble.push(message);
    }
  }
  return { preamble, turns };
}

function ConversationView({
  share,
  shareToken,
  grouped,
}: {
  share: Extract<PublicShare, { type: "conversation" }>;
  shareToken: string;
  grouped: { preamble: PublicShareMessage[]; turns: PublicConversationTurn[] };
}) {
  return (
    <>
      <header className="mb-5 border-b border-line pb-4">
        <h1 className="text-xl font-semibold text-ink">{share.title}</h1>
        <p className="mt-1 text-xs text-muted">公开分享 · {formatTime(share.createdAt)}</p>
      </header>
      <div className="flex flex-col gap-5">
        {grouped.preamble.map((message, index) => (
          <PublicMessage key={`pre-${index}`} message={message} shareToken={shareToken} />
        ))}
        {grouped.turns.map((turn) => (
          <div key={turn.id} id={`turn-${turn.id}`} className="flex flex-col gap-3">
            <PublicMessage message={turn.user} shareToken={shareToken} />
            {turn.assistantMessages.map((message, index) => (
              <PublicMessage
                key={`${turn.id}-assistant-${index}`}
                message={message}
                shareToken={shareToken}
              />
            ))}
          </div>
        ))}
        {share.messages.length === 0 ? (
          <p className="text-sm text-muted">这个对话还没有内容。</p>
        ) : null}
      </div>
    </>
  );
}

function ReportView({
  share,
  backTo,
}: {
  share: Extract<PublicShare, { type: "report" }>;
  backTo?: string;
}) {
  const artifacts = new Map(share.artifacts.map((artifact) => [artifact.id, artifact]));
  const segments = parseReportMarkdown(share.markdown);
  return (
    <>
      <header className="mb-6 border-b border-line pb-4">
        {backTo ? (
          <Link
            to={backTo}
            className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回对话
          </Link>
        ) : null}
        <h1 className="text-xl font-semibold text-ink">{share.title}</h1>
        <p className="mt-1 text-xs text-muted">公开分享 · {formatTime(share.createdAt)}</p>
      </header>
      <article className="flex flex-col gap-4">
        {segments.map((segment, index) => {
          if (segment.type === "markdown") {
            return segment.content.trim() ? (
              <PublicMarkdown key={index} content={segment.content} headingAnchors />
            ) : null;
          }
          const artifact = artifacts.get(segment.artifactId);
          return artifact ? (
            <PublicArtifact key={`${segment.artifactId}-${index}`} artifact={artifact} />
          ) : (
            <p key={`${segment.artifactId}-${index}`} className="text-xs text-muted">
              该内容已不可用。
            </p>
          );
        })}
      </article>
    </>
  );
}

function DashboardView({ share }: { share: Extract<PublicShare, { type: "dashboard" }> }) {
  return (
    <>
      <header className="mb-6 border-b border-line pb-4">
        <h1 className="text-xl font-semibold text-ink">{share.title}</h1>
        {share.description ? (
          <p className="mt-1.5 text-sm text-inksoft">{share.description}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted">
          公开看板 · 更新于 {formatTime(share.updatedAt)}
        </p>
      </header>
      {share.cards.length === 0 ? (
        <p className="text-sm text-muted">这个看板还没有图表卡片。</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {share.cards.map((card, index) => (
            <div
              key={`${card.title}-${index}`}
              className={cn("flex flex-col gap-1", card.width === 2 && "lg:col-span-2")}
            >
              <ChartCard
                title={card.title}
                option={chartOptionFromSpec(card.spec)}
                points={card.points}
              />
              {card.lastRefreshedAt ? (
                <p className="px-1 text-[11px] text-muted">
                  数据更新于 {formatTime(card.lastRefreshedAt)}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function PublicSharePage() {
  const { token, reportId } = useParams<{ token: string; reportId?: string }>();
  const branding = useBranding();
  const scrollRef = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: reportId
      ? ["public-share-report", token ?? "", reportId]
      : ["public-share", token ?? ""],
    queryFn: () =>
      reportId
        ? getPublicShareReport(token as string, reportId)
        : getPublicShare(token as string),
    enabled: Boolean(token),
    retry: false,
    gcTime: 0,
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [token, reportId]);

  const share = query.data;
  const groupedConversation = useMemo(
    () => (share?.type === "conversation" ? groupPublicConversationTurns(share.messages) : null),
    [share],
  );
  const minimapTurns = useMemo<MinimapTurn[]>(
    () =>
      groupedConversation
        ? groupedConversation.turns.map((turn) => ({
            runId: turn.id,
            user: { content: turn.user.text },
          }))
        : [],
    [groupedConversation],
  );
  const reportHeadings = useMemo(
    () => (share?.type === "report" ? extractReportHeadings(share.markdown) : []),
    [share],
  );
  const activeHeadingId = useReportTocActive(reportHeadings, scrollRef);

  const gone =
    query.isError && query.error instanceof ApiError && query.error.status === 410;
  const isDashboard = share?.type === "dashboard";
  const backTo = reportId && token ? `/s/${encodeURIComponent(token)}` : undefined;

  let content: ReactNode;
  if (!token || query.isPending) {
    content = <PageSpinner label="加载分享内容…" />;
  } else if (query.isError || !share) {
    content = (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface px-6 py-16 text-center">
        <FileWarning className="h-8 w-8 text-linestrong" />
        <p role="alert" className="text-sm text-muted">
          {gone ? "链接已过期或已撤销" : "分享内容加载失败，请稍后重试。"}
        </p>
        {backTo ? (
          <Link
            to={backTo}
            className="inline-flex items-center gap-1 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-subtle"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回对话
          </Link>
        ) : null}
      </div>
    );
  } else if (share.type === "conversation" && groupedConversation) {
    content = (
      <ConversationView
        share={share}
        shareToken={token}
        grouped={groupedConversation}
      />
    );
  } else if (share.type === "dashboard") {
    content = <DashboardView share={share} />;
  } else if (share.type === "report") {
    content = <ReportView share={share} backTo={backTo} />;
  }

  const maxWidth = isDashboard ? "max-w-5xl" : "max-w-3xl";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas print:h-auto print:overflow-visible">
      <header className="shrink-0 border-b border-line bg-surface print:hidden">
        <div className={cn("mx-auto flex h-14 w-full items-center justify-between px-4", maxWidth)}>
          <span className="text-sm font-semibold text-ink">{branding.title}</span>
          <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-muted">
            只读分享
          </span>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 print:overflow-visible">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto print:h-auto print:overflow-visible"
        >
          <main className={cn("mx-auto w-full px-4 py-6", maxWidth)}>{content}</main>
        </div>
        {share?.type === "conversation" ? (
          <ConversationMinimap messages={minimapTurns} containerRef={scrollRef} />
        ) : null}
        {share?.type === "report" ? (
          <ReportToc
            headings={reportHeadings}
            activeId={activeHeadingId}
            onSelect={(heading) =>
              document.getElementById(heading)?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          />
        ) : null}
      </div>
    </div>
  );
}
