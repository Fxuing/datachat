import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType,
  Link2,
  Loader2,
  Search,
  Share2,
  Trash2,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { ShareDialog } from "../components/ShareDialog";
import { ConfirmDialog } from "../components/admin/ConfirmDialog";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { PageSpinner } from "../components/ui/spinner";
import { useToast } from "../components/ui/toast";
import { useCan } from "../hooks/use-access";
import {
  deleteReport,
  fetchMe,
  listDatasources,
  listReports,
  listShares,
  revokeShare,
  type ReportListItem,
  type ShareListItem,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { queryKeys } from "../lib/query";
import { exportReportById, type ReportExportFormat } from "../lib/report-offscreen-export";
import { cn, formatDateTime } from "../lib/utils";

const PAGE_SIZE = 20;

const TARGET_TYPE_LABELS: Record<ShareListItem["targetType"], string> = {
  conversation: "会话",
  report: "报告",
  dashboard: "看板",
};

const SHARE_STATUS_META: Record<
  ShareListItem["status"],
  { label: string; className: string }
> = {
  active: { label: "生效中", className: "bg-successsoft text-success" },
  expired: { label: "已过期", className: "bg-subtle text-muted" },
  revoked: { label: "已撤销", className: "bg-dangersoft text-danger" },
};

function shareTargetHref(item: ShareListItem): string | null {
  if (item.targetTitle.startsWith("已删除的")) return null;
  if (item.targetType === "conversation") return `/chat/${item.targetId}`;
  if (item.targetType === "report") return `/reports/${item.targetId}`;
  return `/dashboards/${item.targetId}`;
}

export default function ReportsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { toast } = useToast();
  const canShare = useCan("share.create");
  const canReport = useCan("report.create");

  const activeTab: "reports" | "shares" =
    searchParams.get("tab") === "shares" ? "shares" : "reports";

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "chat" | "scheduled">("all");
  const [datasourceFilter, setDatasourceFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [shareStatusFilter, setShareStatusFilter] = useState<"active" | "all">("active");

  const [shareTarget, setShareTarget] = useState<ReportListItem | null>(null);
  const [deletingReport, setDeletingReport] = useState<ReportListItem | null>(null);
  const [revokingShare, setRevokingShare] = useState<ShareListItem | null>(null);
  const [exportMenuId, setExportMenuId] = useState<string | null>(null);
  const [exportingKey, setExportingKey] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const datasourcesQuery = useQuery({
    queryKey: queryKeys.datasources,
    queryFn: listDatasources,
  });

  const reportFilters = {
    q: debouncedQuery || undefined,
    source: sourceFilter,
    datasourceId: datasourceFilter === "all" ? undefined : datasourceFilter,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const reportsQuery = useQuery({
    queryKey: queryKeys.reports(reportFilters),
    queryFn: () => listReports(reportFilters),
    enabled: activeTab === "reports",
  });

  const sharesQuery = useQuery({
    queryKey: queryKeys.shares({ scope: "mine", status: shareStatusFilter }),
    queryFn: () => listShares({ scope: "mine", status: shareStatusFilter }),
    enabled: activeTab === "shares",
  });

  const deleteReportMutation = useMutation({
    mutationFn: (id: string) => deleteReport(id),
    onSuccess: (_data, id) => {
      setDeletingReport(null);
      queryClient.removeQueries({ queryKey: queryKeys.report(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.reportsAll });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharesAll });
      toast.success("报告已删除");
    },
    onError: (err) => {
      toast.error(describeApiError(err, "删除报告失败，请稍后重试"));
    },
  });

  const revokeShareMutation = useMutation({
    mutationFn: (id: string) => revokeShare(id),
    onSuccess: () => {
      setRevokingShare(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharesAll });
      toast.success("已撤销分享链接");
    },
    onError: (err) => {
      toast.error(describeApiError(err, "撤销分享链接失败，请稍后重试"));
    },
  });

  const handleExport = async (report: ReportListItem, format: ReportExportFormat) => {
    const key = `${report.id}:${format}`;
    if (exportingKey) return;
    setExportMenuId(null);
    setExportingKey(key);
    try {
      await exportReportById(report.id, format);
      toast.success(
        format === "docx"
          ? "Word 报告已导出"
          : format === "html"
            ? "HTML 报告已导出"
            : "Markdown 报告已导出",
      );
    } catch (err) {
      toast.error(describeApiError(err, "导出报告失败，请稍后重试"));
    } finally {
      setExportingKey(null);
    }
  };

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const datasources = datasourcesQuery.data?.datasources ?? [];
  const reports = reportsQuery.data?.reports ?? [];
  const totalReports = reportsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalReports / PAGE_SIZE));
  const shares = sharesQuery.data?.shares ?? [];
  const hasReportFilters = Boolean(
    debouncedQuery || sourceFilter !== "all" || datasourceFilter !== "all",
  );

  const setTab = (tab: "reports" | "shares") => {
    if (tab === "shares") {
      setSearchParams({ tab: "shares" }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  };

  const topbar = (
    <div className="flex min-w-0 items-center gap-2">
      <FileText className="h-4 w-4 shrink-0 text-brand" />
      <h1 className="truncate text-sm font-semibold text-ink">报告中心</h1>
    </div>
  );

  return (
    <AppShell
      user={user}
      sidebar={<ConversationSidebar datasources={datasources} />}
      topbar={topbar}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-5xl space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[13px] text-muted">
                统一管理对话与定时任务沉淀的分析报告，并随时查看或撤销公开分享链接。
              </p>
            </div>
            <div
              role="tablist"
              aria-label="报告中心视图"
              className="inline-flex rounded-lg border border-line bg-subtle/60 p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "reports"}
                onClick={() => setTab("reports")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  activeTab === "reports"
                    ? "bg-surface text-ink shadow-card"
                    : "text-muted hover:text-ink",
                )}
              >
                <FileText className="h-3.5 w-3.5" />
                我的报告
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "shares"}
                onClick={() => setTab("shares")}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  activeTab === "shares"
                    ? "bg-surface text-ink shadow-card"
                    : "text-muted hover:text-ink",
                )}
              >
                <Link2 className="h-3.5 w-3.5" />
                我的分享
              </button>
            </div>
          </div>

          {activeTab === "reports" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                  <Input
                    aria-label="搜索报告标题"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索报告标题…"
                    className="h-9 bg-surface pl-8 text-xs"
                  />
                </div>
                <Select
                  value={sourceFilter}
                  onValueChange={(value) => {
                    setSourceFilter(value as "all" | "chat" | "scheduled");
                    setPage(0);
                  }}
                >
                  <SelectTrigger aria-label="按来源筛选" className="h-9 w-36 bg-surface text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部来源</SelectItem>
                    <SelectItem value="chat">对话生成</SelectItem>
                    <SelectItem value="scheduled">定时任务</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={datasourceFilter}
                  onValueChange={(value) => {
                    setDatasourceFilter(value);
                    setPage(0);
                  }}
                >
                  <SelectTrigger aria-label="按数据源筛选" className="h-9 w-44 bg-surface text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部数据源</SelectItem>
                    {datasources.map((ds) => (
                      <SelectItem key={ds.id} value={ds.id}>
                        {ds.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {reportsQuery.isPending ? (
                <PageSpinner label="加载报告列表…" />
              ) : reportsQuery.isError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-2 rounded-lg border border-danger/25 bg-dangersoft px-4 py-3 text-xs text-danger"
                >
                  <span>{describeApiError(reportsQuery.error, "加载报告列表失败")}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void reportsQuery.refetch()}
                  >
                    重试
                  </Button>
                </div>
              ) : reports.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface px-6 py-14 text-center">
                  <FileText className="h-9 w-9 text-muted/60" />
                  <p className="text-sm font-medium text-ink">
                    {hasReportFilters ? "没有符合条件的报告" : "还没有保存的分析报告"}
                  </p>
                  <p className="max-w-md text-xs text-muted">
                    {hasReportFilters
                      ? "试试调整搜索关键词或来源筛选条件。"
                      : "在对话中让助手生成报告，或在查询结果卡片点击「生成报告」，即可沉淀到这里集中查看和导出。"}
                  </p>
                  {hasReportFilters ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setQuery("");
                        setDebouncedQuery("");
                        setSourceFilter("all");
                        setDatasourceFilter("all");
                        setPage(0);
                      }}
                    >
                      重置筛选
                    </Button>
                  ) : (
                    <Link
                      to="/chat"
                      className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-xs font-medium text-inksoft transition-colors hover:border-linestrong hover:bg-subtle"
                    >
                      去对话分析
                    </Link>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
                    <div className="divide-y divide-line">
                      {reports.map((report) => {
                        const isExporting = exportingKey?.startsWith(`${report.id}:`) ?? false;
                        return (
                          <div
                            key={report.id}
                            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 transition-colors hover:bg-subtle/40"
                          >
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Link
                                  to={`/reports/${report.id}`}
                                  className="truncate text-sm font-medium text-ink hover:text-brandtext hover:underline"
                                >
                                  {report.title}
                                </Link>
                                <span
                                  className={cn(
                                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                                    report.source === "scheduled"
                                      ? "bg-brandsoft text-brandtext"
                                      : "bg-subtle text-inksoft",
                                  )}
                                >
                                  {report.source === "scheduled" ? "定时任务" : "对话生成"}
                                </span>
                                {report.sourceKind === "file" ? (
                                  <span className="inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                                    <FileSpreadsheet className="h-3 w-3" />
                                    Excel / CSV
                                  </span>
                                ) : report.datasourceName ? (
                                  <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                                    {report.datasourceName}
                                  </span>
                                ) : null}
                              </div>
                              <p className="text-[11px] text-muted">
                                {report.artifactCount} 个结果/图表 · 更新于{" "}
                                {formatDateTime(report.updatedAt)}
                                {report.conversationTitle && report.source === "chat"
                                  ? ` · 来源：${report.conversationTitle}`
                                  : ""}
                              </p>
                            </div>

                            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                              <Link
                                to={`/reports/${report.id}`}
                                className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line bg-surface px-3 text-xs font-medium text-inksoft transition-colors hover:border-linestrong hover:bg-subtle"
                              >
                                查看
                              </Link>

                              <div className="inline-flex items-center">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={Boolean(exportingKey)}
                                  onClick={() => void handleExport(report, "docx")}
                                  className="rounded-r-none"
                                >
                                  {isExporting ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Download className="h-3.5 w-3.5" />
                                  )}
                                  {isExporting ? "导出中…" : "导出 Word"}
                                </Button>
                                <Popover
                                  open={exportMenuId === report.id}
                                  onOpenChange={(open) =>
                                    setExportMenuId(open ? report.id : null)
                                  }
                                >
                                  <PopoverTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      aria-label={`更多导出格式 ${report.title}`}
                                      disabled={Boolean(exportingKey)}
                                      className="-ml-px rounded-l-none px-1.5"
                                    >
                                      <ChevronDown className="h-3.5 w-3.5" />
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent align="end" className="w-44 p-1">
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-inksoft hover:bg-subtle hover:text-ink"
                                      onClick={() => void handleExport(report, "docx")}
                                    >
                                      <FileType className="h-3.5 w-3.5 text-brand" />
                                      导出 Word（.docx）
                                    </button>
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-inksoft hover:bg-subtle hover:text-ink"
                                      onClick={() => void handleExport(report, "html")}
                                    >
                                      <FileCode2 className="h-3.5 w-3.5 text-muted" />
                                      导出 HTML（.html）
                                    </button>
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-inksoft hover:bg-subtle hover:text-ink"
                                      onClick={() => void handleExport(report, "md")}
                                    >
                                      <FileText className="h-3.5 w-3.5 text-muted" />
                                      导出 Markdown（.md）
                                    </button>
                                  </PopoverContent>
                                </Popover>
                              </div>

                              {canShare ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setShareTarget(report)}
                                >
                                  <Share2 className="h-3.5 w-3.5" />
                                  分享
                                </Button>
                              ) : null}

                              {report.source === "chat" ? (
                                <Link
                                  to={`/chat/${report.conversationId}`}
                                  className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-medium text-muted transition-colors hover:bg-subtle hover:text-ink"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  来源对话
                                </Link>
                              ) : null}

                              {canReport ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`删除报告 ${report.title}`}
                                  className="text-danger hover:bg-dangersoft hover:text-danger"
                                  onClick={() => {
                                    deleteReportMutation.reset();
                                    setDeletingReport(report);
                                  }}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  删除
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {totalReports > PAGE_SIZE ? (
                    <div className="flex items-center justify-between text-xs text-muted">
                      <span>
                        共 {totalReports} 份报告 · 第 {page + 1} / {pageCount} 页
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={page === 0}
                          onClick={() => setPage((p) => Math.max(0, p - 1))}
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                          上一页
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={page >= pageCount - 1}
                          onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                        >
                          下一页
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted">
                  出于安全原因，公开链接仅在创建时显示一次；这里可随时核查状态或撤销已发出的链接。
                </p>
                <Select
                  value={shareStatusFilter}
                  onValueChange={(value) => setShareStatusFilter(value as "active" | "all")}
                >
                  <SelectTrigger aria-label="分享状态筛选" className="h-8 w-32 bg-surface text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">仅生效中</SelectItem>
                    <SelectItem value="all">全部记录</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {sharesQuery.isPending ? (
                <PageSpinner label="加载分享记录…" />
              ) : sharesQuery.isError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-2 rounded-lg border border-danger/25 bg-dangersoft px-4 py-3 text-xs text-danger"
                >
                  <span>{describeApiError(sharesQuery.error, "加载分享记录失败")}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void sharesQuery.refetch()}
                  >
                    重试
                  </Button>
                </div>
              ) : shares.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface px-6 py-14 text-center">
                  <Link2 className="h-9 w-9 text-muted/60" />
                  <p className="text-sm font-medium text-ink">
                    {shareStatusFilter === "active" ? "当前没有生效中的公开分享" : "还没有创建过分享"}
                  </p>
                  <p className="max-w-md text-xs text-muted">
                    在会话、报告或数据看板点击「分享」即可生成只读链接。
                  </p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-line bg-subtle/60 text-[11px] text-muted">
                        <tr>
                          <th className="px-4 py-2.5 font-medium">目标</th>
                          <th className="px-4 py-2.5 font-medium">状态</th>
                          <th className="px-4 py-2.5 font-medium">创建时间</th>
                          <th className="px-4 py-2.5 font-medium">过期时间</th>
                          <th className="px-4 py-2.5 text-right font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {shares.map((item) => {
                          const href = shareTargetHref(item);
                          const statusMeta = SHARE_STATUS_META[item.status];
                          return (
                            <tr key={item.id} className="hover:bg-subtle/40">
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-inksoft">
                                    {TARGET_TYPE_LABELS[item.targetType]}
                                  </span>
                                  {href ? (
                                    <Link
                                      to={href}
                                      className="font-medium text-ink hover:text-brandtext hover:underline"
                                    >
                                      {item.targetTitle}
                                    </Link>
                                  ) : (
                                    <span className="text-muted">{item.targetTitle}</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={cn(
                                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                                    statusMeta.className,
                                  )}
                                >
                                  {statusMeta.label}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-muted">
                                {formatDateTime(item.createdAt)}
                              </td>
                              <td className="px-4 py-3 text-muted">
                                {formatDateTime(item.expiresAt)}
                              </td>
                              <td className="px-4 py-3 text-right">
                                {item.status === "active" ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="text-danger hover:bg-dangersoft hover:text-danger"
                                    onClick={() => {
                                      revokeShareMutation.reset();
                                      setRevokingShare(item);
                                    }}
                                  >
                                    撤销
                                  </Button>
                                ) : (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {shareTarget ? (
        <ShareDialog
          target={{ reportId: shareTarget.id, label: shareTarget.title }}
          onClose={() => setShareTarget(null)}
        />
      ) : null}

      {deletingReport ? (
        <ConfirmDialog
          title="删除报告"
          description={`确定删除报告「${deletingReport.title}」吗？相关公开分享链接也将同步失效。`}
          confirmLabel={deleteReportMutation.isPending ? "删除中…" : "删除"}
          variant="danger"
          pending={deleteReportMutation.isPending}
          error={
            deleteReportMutation.isError
              ? describeApiError(deleteReportMutation.error, "删除报告失败")
              : null
          }
          onConfirm={() => deleteReportMutation.mutate(deletingReport.id)}
          onCancel={() => {
            deleteReportMutation.reset();
            setDeletingReport(null);
          }}
        />
      ) : null}

      {revokingShare ? (
        <ConfirmDialog
          title="撤销分享链接"
          description={`确定撤销「${revokingShare.targetTitle}」的公开分享链接吗？撤销后任何持有该链接的人将立即无法访问。`}
          confirmLabel={revokeShareMutation.isPending ? "撤销中…" : "撤销"}
          variant="danger"
          pending={revokeShareMutation.isPending}
          error={
            revokeShareMutation.isError
              ? describeApiError(revokeShareMutation.error, "撤销分享链接失败")
              : null
          }
          onConfirm={() => revokeShareMutation.mutate(revokingShare.id)}
          onCancel={() => {
            revokeShareMutation.reset();
            setRevokingShare(null);
          }}
        />
      ) : null}
    </AppShell>
  );
}
