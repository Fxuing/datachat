import { Children, isValidElement, lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Download,
  Eye,
  FileCode2,
  FileWarning,
  Pencil,
  Printer,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { REPORT_MAX_MARKDOWN_LENGTH, type Column } from "@datachat/shared";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { AppShell } from "../components/AppShell";
import { ConfirmDialog } from "../components/admin/ConfirmDialog";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { ShareDialog } from "../components/ShareDialog";
import { ReportToc, useReportTocActive } from "../components/report/ReportToc";
import { MermaidDiagram } from "../components/markdown/MermaidDiagram";
import { mermaidSourceOf } from "../components/markdown/mermaid-source";
import { PageSpinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  ApiError,
  deleteReport,
  fetchMe,
  getArtifact,
  getArtifactRows,
  getReport,
  updateReport,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { queryKeys } from "../lib/query";
import { useCan } from "../hooks/use-access";
import { parseReportMarkdown } from "../lib/report-markdown";
import { extractReportHeadings, headingId } from "../lib/report-toc";
import { buildReportExportHtml, buildReportExportMarkdown } from "../lib/report-export";
import { downloadTextFile, sanitizeFileName } from "../lib/conversation-export";
import { cn, formatCount } from "../lib/utils";

const LazyChartCard = lazy(() =>
  import("../components/chat/ChartCard").then((module) => ({
    default: function LazyReportChart({
      spec,
      rowCount,
    }: {
      spec: unknown;
      rowCount: number;
    }) {
      return (
        <module.ChartCard
          title={module.chartTitleFromSpec(spec)}
          option={module.chartOptionFromSpec(spec)}
          points={rowCount > 0 ? rowCount : undefined}
        />
      );
    },
  })),
);

export function formatReportTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
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

function headingProps(children: ReactNode) {
  return { id: headingId(textFromChildren(children)), className: "scroll-mt-10" };
}

function ReportMarkdown({ content }: { content: string }) {
  const components: Components = {
    pre: ({ children }: { children?: ReactNode }) => {
      const chart = mermaidSourceOf(children);
      return chart ? <MermaidDiagram source={chart} /> : <pre>{children}</pre>;
    },
    h1: ({ children }) => <h1 {...headingProps(children)}>{children}</h1>,
    h2: ({ children }) => <h2 {...headingProps(children)}>{children}</h2>,
    h3: ({ children }) => <h3 {...headingProps(children)}>{children}</h3>,
  };

  return (
    <div className="markdown text-sm">
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
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

function ReportTable({
  columns,
  rows,
  rowCount,
}: {
  columns: Column[];
  rows: unknown[][];
  rowCount: number;
}) {
  return (
    <div className="report-artifact overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <div className="report-table-scroll max-h-96 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-subtle">
            <tr>
              {columns.map((column, index) => (
                <th
                  key={`${column.name}-${index}`}
                  scope="col"
                  className={cn(
                    "border-b border-line px-3 py-2 font-medium text-muted",
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
      <div className="report-table-footer border-t border-line bg-subtle px-3 py-2 text-xs text-muted">
        显示 {rows.length} / {formatCount(rowCount)} 行
        {rowCount > rows.length ? "（仅展示前 100 行）" : ""}
      </div>
    </div>
  );
}

function ReportResultPreview({ artifactId, columns, rowCount }: {
  artifactId: string;
  columns: Column[];
  rowCount: number;
}) {
  const rowsQuery = useQuery({
    queryKey: queryKeys.artifactRows(artifactId),
    queryFn: () => getArtifactRows(artifactId, { limit: 100 }),
    retry: false,
  });

  if (rowsQuery.isPending) {
    return <ArtifactLoading label="加载结果…" />;
  }
  if (rowsQuery.isError) {
    return <MissingArtifact artifactId={artifactId} message="结果加载失败。" />;
  }
  const rows = rowsQuery.data.rows.slice(0, 100);
  return <ReportTable columns={columns} rows={rows} rowCount={rowCount} />;
}

function ReportChart({ spec, rowCount }: { spec: unknown; rowCount: number }) {
  return (
    <div className="report-artifact">
      <Suspense fallback={<ArtifactLoading label="图表加载中…" />}>
        <LazyChartCard spec={spec} rowCount={rowCount} />
      </Suspense>
    </div>
  );
}

function ArtifactLoading({ label }: { label: string }) {
  return (
    <div className="report-artifact flex min-h-24 items-center justify-center rounded-lg border border-dashed border-line bg-subtle text-xs text-muted">
      {label}
    </div>
  );
}

function MissingArtifact({ artifactId, message }: { artifactId: string; message?: string }) {
  return (
    <div className="report-artifact flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-linestrong bg-subtle px-3 py-4 text-center text-xs text-muted">
      <FileWarning className="h-5 w-5 text-muted" />
      <p>{message ?? "结果不可用，可能已被删除。"}</p>
      <p className="font-mono text-[11px] text-muted">artifact: {artifactId}</p>
    </div>
  );
}

function ReportArtifact({ artifactId, listed }: { artifactId: string; listed: boolean }) {
  const detailQuery = useQuery({
    queryKey: queryKeys.artifact(artifactId),
    queryFn: () => getArtifact(artifactId),
    enabled: listed,
    retry: false,
  });

  if (!listed) return <MissingArtifact artifactId={artifactId} />;
  if (detailQuery.isPending) return <ArtifactLoading label="加载结果…" />;
  if (detailQuery.isError) return <MissingArtifact artifactId={artifactId} message="结果加载失败。" />;

  const artifact = detailQuery.data;
  if (artifact.kind === "chart") {
    return <ReportChart spec={artifact.spec} rowCount={artifact.rowCount} />;
  }
  return (
    <ReportResultPreview
      artifactId={artifact.id}
      columns={artifact.columns}
      rowCount={artifact.rowCount}
    />
  );
}

export default function ReportPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [showPreview, setShowPreview] = useState(true);
  const [editError, setEditError] = useState<string | null>(null);
  const canShare = useCan("share.create");
  const canEdit = useCan("report.create");

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const reportQuery = useQuery({
    queryKey: queryKeys.report(id ?? ""),
    queryFn: () => getReport(id as string),
    enabled: Boolean(id),
    retry: false,
  });

  const report = reportQuery.data?.report;
  const reportMarkdown = report?.markdown ?? "";
  const headings = useMemo(() => extractReportHeadings(reportMarkdown), [reportMarkdown]);
  const reportScrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const activeHeadingId = useReportTocActive(headings, reportScrollRef);

  const goBack = () => {
    const conversationId = reportQuery.data?.report.conversationId;
    if (conversationId) {
      navigate(`/chat/${conversationId}`);
      return;
    }
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate("/chat");
  };

  const updateMutation = useMutation({
    mutationFn: (payload: { title: string; markdown: string }) =>
      updateReport(id as string, payload),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.report(id ?? ""), data);
      setEditing(false);
      setEditError(null);
    },
    onError: (err) => {
      setEditError(describeApiError(err, "保存失败，请稍后重试。"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteReport(id as string),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: queryKeys.report(id ?? "") });
      goBack();
    },
  });

  const user = meQuery.data?.user;
  if (!user) {
    return <PageSpinner />;
  }

  const notFound =
    reportQuery.isError &&
    reportQuery.error instanceof ApiError &&
    (reportQuery.error.status === 404 || reportQuery.error.status === 400);

  const startEdit = () => {
    if (!report) return;
    setDraftTitle(report.title);
    setDraftMarkdown(report.markdown);
    setEditError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditError(null);
    updateMutation.reset();
  };

  const saveEdit = () => {
    const title = draftTitle.trim();
    if (!title) {
      setEditError("请输入报告标题");
      return;
    }
    if (!draftMarkdown.trim()) {
      setEditError("报告正文不能为空");
      return;
    }
    if (draftMarkdown.length > REPORT_MAX_MARKDOWN_LENGTH) {
      setEditError(`报告正文不能超过 ${REPORT_MAX_MARKDOWN_LENGTH.toLocaleString()} 字`);
      return;
    }
    setEditError(null);
    updateMutation.mutate({ title, markdown: draftMarkdown });
  };

  const handleExportMarkdown = () => {
    if (!report) return;
    const content = buildReportExportMarkdown(report);
    downloadTextFile(
      sanitizeFileName(report.title, "datachat-report", "md"),
      content,
      "text/markdown;charset=utf-8",
    );
  };

  const handleExportHtml = () => {
    if (!report || !articleRef.current) return;
    const html = buildReportExportHtml(report.title, articleRef.current);
    downloadTextFile(
      sanitizeFileName(report.title, "datachat-report", "html"),
      html,
      "text/html;charset=utf-8",
    );
  };

  const handleDelete = () => {
    if (!report) return;
    setDeleteOpen(true);
  };

  const topbar = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="sm" onClick={goBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          返回
        </Button>
        <span className="truncate text-sm font-medium text-ink">
          {editing ? draftTitle || report?.title || "报告" : (report?.title ?? "报告")}
        </span>
      </div>
      <div className="report-toolbar flex shrink-0 items-center gap-1.5">
        {editing ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPreview((value) => !value)}
            >
              <Eye className="h-3.5 w-3.5" />
              {showPreview ? "隐藏预览" : "实时预览"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={cancelEdit}
              disabled={updateMutation.isPending}
            >
              <X className="h-3.5 w-3.5" />
              取消
            </Button>
            <Button
              size="sm"
              onClick={saveEdit}
              disabled={updateMutation.isPending}
            >
              <Check className="h-3.5 w-3.5" />
              {updateMutation.isPending ? "保存中…" : "保存"}
            </Button>
          </>
        ) : (
          <>
            {canEdit ? (
              <Button
                variant="outline"
                size="sm"
                onClick={startEdit}
                disabled={!report}
              >
                <Pencil className="h-3.5 w-3.5" />
                编辑
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportMarkdown}
              disabled={!report}
            >
              <Download className="h-3.5 w-3.5" />
              导出 MD
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportHtml}
              disabled={!report}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              导出 HTML
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.print()}
              disabled={!report}
            >
              <Printer className="h-3.5 w-3.5" />
              打印
            </Button>
            {canShare ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShareOpen(true)}
                disabled={!report}
              >
                <Share2 className="h-3.5 w-3.5" />
                分享
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="text-danger hover:bg-dangersoft hover:text-danger"
              onClick={handleDelete}
              disabled={!report || deleteMutation.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleteMutation.isPending ? "删除中…" : "删除"}
            </Button>
          </>
        )}
      </div>
    </>
  );

  let content: ReactNode;
  if (!id) {
    content = null;
  } else if (reportQuery.isPending) {
    content = <PageSpinner label="加载报告…" />;
  } else if (reportQuery.isError) {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted">
        <p>{notFound ? "报告不存在或已被删除。" : "报告加载失败，请稍后重试。"}</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={goBack}>
            返回对话
          </Button>
          {notFound ? null : (
            <Button size="sm" onClick={() => void reportQuery.refetch()}>
              重试
            </Button>
          )}
        </div>
      </div>
    );
  } else if (report && editing) {
    const previewSegments = parseReportMarkdown(draftMarkdown);
    content = (
      <div className="flex min-h-0 flex-1 flex-col bg-surface">
        {editError ? (
          <div className="border-b border-danger/20 bg-dangersoft px-4 py-2 text-xs text-danger" role="alert">
            {editError}
          </div>
        ) : null}
        <div className={cn("grid min-h-0 flex-1 grid-cols-1", showPreview && "lg:grid-cols-2")}>
          <div className="flex min-h-0 flex-col gap-3 border-line p-4 lg:border-r">
            <div className="space-y-1">
              <label htmlFor="report-title-input" className="text-xs font-medium text-inksoft">
                报告标题
              </label>
              <Input
                id="report-title-input"
                value={draftTitle}
                maxLength={200}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="输入报告标题"
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <label htmlFor="report-markdown-input" className="font-medium text-inksoft">
                  Markdown 正文
                </label>
                <span className="text-[11px] text-muted">
                  保留 <code>{"[[artifact:<id>]]"}</code> 即可内嵌原图表与数据表 · {draftMarkdown.length.toLocaleString()} / {REPORT_MAX_MARKDOWN_LENGTH.toLocaleString()}
                </span>
              </div>
              <textarea
                id="report-markdown-input"
                value={draftMarkdown}
                onChange={(event) => setDraftMarkdown(event.target.value)}
                className="min-h-64 flex-1 resize-none rounded-lg border border-line bg-canvas p-3 font-mono text-xs leading-relaxed text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                placeholder="编辑报告 Markdown 正文…"
              />
            </div>
          </div>
          {showPreview ? (
            <div className="min-h-0 overflow-y-auto bg-canvas/40 p-6">
              <article className="mx-auto w-full max-w-[44rem] rounded-xl border border-line bg-surface px-6 py-6">
                <header className="mb-5 border-b border-line pb-3">
                  <h1 className="text-xl font-semibold text-ink">{draftTitle.trim() || "未命名报告"}</h1>
                  <p className="mt-1 text-xs text-muted">实时预览</p>
                </header>
                <div className="flex flex-col gap-4">
                  {previewSegments.map((segment, index) =>
                    segment.type === "markdown" ? (
                      segment.content.trim() ? (
                        <ReportMarkdown key={index} content={segment.content} />
                      ) : null
                    ) : (
                      <ReportArtifact
                        key={`${segment.artifactId}-${index}`}
                        artifactId={segment.artifactId}
                        listed={report.artifactIds.includes(segment.artifactId)}
                      />
                    ),
                  )}
                </div>
              </article>
            </div>
          ) : null}
        </div>
      </div>
    );
  } else if (report) {
    const segments = parseReportMarkdown(report.markdown);
    content = (
      <div className="relative min-h-0 flex-1">
        <div ref={reportScrollRef} className="report-page h-full overflow-y-auto bg-surface">
          <article
            ref={articleRef}
            className="mx-auto w-full max-w-[44rem] px-6 py-8 print:max-w-none print:px-0 print:py-0"
          >
            <header className="mb-6 border-b border-line pb-4">
              <h1 className="text-xl font-semibold text-ink">{report.title}</h1>
              <p className="mt-1 text-xs text-muted">
                生成时间：{formatReportTime(report.createdAt)}
                {report.updatedAt > report.createdAt
                  ? ` · 更新于 ${formatReportTime(report.updatedAt)}`
                  : ""}
              </p>
            </header>
            <div className="flex flex-col gap-4">
              {segments.map((segment, index) =>
                segment.type === "markdown" ? (
                  segment.content.trim() ? (
                    <ReportMarkdown key={index} content={segment.content} />
                  ) : null
                ) : (
                  <ReportArtifact
                    key={`${segment.artifactId}-${index}`}
                    artifactId={segment.artifactId}
                    listed={report.artifactIds.includes(segment.artifactId)}
                  />
                ),
              )}
            </div>
          </article>
        </div>
        <ReportToc
          headings={headings}
          activeId={activeHeadingId}
          onSelect={(heading) =>
            document.getElementById(heading)?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
        />
      </div>
    );
  } else {
    content = <PageSpinner />;
  }

  return (
    <AppShell user={user} sidebar={<ConversationSidebar />} topbar={topbar}>
      {deleteMutation.isError ? (
        <div className="mx-auto w-full max-w-3xl px-4 pt-3">
          <p role="alert" className="rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
            {deleteMutation.error instanceof ApiError
              ? deleteMutation.error.message
              : "删除失败，请稍后重试。"}
          </p>
        </div>
      ) : null}
      {content}
      {deleteOpen && report ? (
        <ConfirmDialog
          title="删除报告"
          description={`确定删除报告“${report.title}”吗？删除后不可恢复。`}
          confirmLabel={deleteMutation.isPending ? "删除中…" : "删除"}
          variant="danger"
          pending={deleteMutation.isPending}
          error={
            deleteMutation.isError
              ? describeApiError(deleteMutation.error, "删除失败，请稍后重试。")
              : null
          }
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => setDeleteOpen(false)}
        />
      ) : null}
      {canShare && shareOpen && report ? (
        <ShareDialog
          target={{ reportId: report.id, label: report.title }}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
    </AppShell>
  );
}
