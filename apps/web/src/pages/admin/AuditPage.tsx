import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { AppShell } from "../../components/AppShell";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_STATUS_LABELS,
  AuditDetailDrawer,
} from "../../components/admin/AuditDetailDrawer";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { PageSpinner } from "../../components/ui/spinner";
import {
  fetchMe,
  listAdminUsers,
  listAudit,
  listDatasources,
  type AuditActionValue,
  type AuditEntry,
  type AuditListFilters,
  type AuditStatusValue,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { cn, formatDateTime } from "../../lib/utils";

const PAGE_SIZE = 50;

const ACTION_VALUES = Object.keys(AUDIT_ACTION_LABELS) as AuditActionValue[];
const STATUS_VALUES = Object.keys(AUDIT_STATUS_LABELS) as AuditStatusValue[];

const STATUS_BADGE_CLASSES: Record<AuditStatusValue, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  rejected: "bg-amber-50 text-amber-700 ring-amber-200",
  error: "bg-red-50 text-red-700 ring-red-200",
  timeout: "bg-orange-50 text-orange-700 ring-orange-200",
};

interface FilterState {
  userId: string;
  datasourceId: string;
  action: string;
  status: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: FilterState = {
  userId: "",
  datasourceId: "",
  action: "",
  status: "",
  from: "",
  to: "",
};

const SELECT_CLASS =
  "h-9 rounded-md border border-neutral-200 bg-white px-2 text-sm text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400";

function startOfDay(value: string): number | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function endOfDay(value: string): number | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

export default function AuditPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const usersQuery = useQuery({ queryKey: queryKeys.adminUsers, queryFn: listAdminUsers });
  const datasourcesQuery = useQuery({
    queryKey: queryKeys.datasources,
    queryFn: listDatasources,
  });

  const request = useMemo<AuditListFilters>(() => {
    const next: AuditListFilters = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (filters.userId) next.userId = filters.userId;
    if (filters.datasourceId) next.datasourceId = filters.datasourceId;
    if (filters.action) next.action = filters.action as AuditActionValue;
    if (filters.status) next.status = filters.status as AuditStatusValue;
    const from = startOfDay(filters.from);
    if (from !== undefined) next.from = from;
    const to = endOfDay(filters.to);
    if (to !== undefined) next.to = to;
    return next;
  }, [filters, page]);

  const auditQuery = useQuery({
    queryKey: queryKeys.audit(request as Record<string, unknown>),
    queryFn: () => listAudit(request),
  });

  const users = usersQuery.data?.users ?? [];
  const datasources = datasourcesQuery.data?.datasources ?? [];
  const userNames = new Map(users.map((user) => [user.id, user.displayName ?? user.username]));
  const datasourceNames = new Map(datasources.map((datasource) => [datasource.id, datasource.name]));

  const items = auditQuery.data?.items ?? [];
  const total = auditQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const hasFilters = Object.values(filters).some((value) => value !== "");
  const errorMessage = auditQuery.isError
    ? describeApiError(auditQuery.error, "加载审计日志失败，请稍后重试。")
    : null;

  const updateFilter = (key: keyof FilterState, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  };

  const resetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPage(0);
  };

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const sidebar = (
    <div className="p-2">
      <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => navigate("/chat")}>
        <ArrowLeft className="mr-2 h-4 w-4" />
        返回对话
      </Button>
    </div>
  );

  return (
    <AppShell user={user} sidebar={sidebar}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-6">
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-neutral-900">审计日志</h1>
              <p className="mt-1 text-sm text-neutral-500">
                查询、导出与账号变更的操作记录，错误信息已脱敏。
              </p>
            </div>
            <div className="flex items-center gap-2">
              {hasFilters ? (
                <Button variant="ghost" size="sm" onClick={resetFilters}>
                  <X className="mr-1 h-3.5 w-3.5" />
                  重置筛选
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={auditQuery.isFetching}
                onClick={() => void auditQuery.refetch()}
              >
                <RefreshCw
                  className={cn("mr-1 h-3.5 w-3.5", auditQuery.isFetching && "animate-spin")}
                />
                刷新
              </Button>
            </div>
          </header>

          <div className="mt-5 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
              用户
              <select
                aria-label="用户"
                className={SELECT_CLASS}
                value={filters.userId}
                onChange={(event) => updateFilter("userId", event.target.value)}
              >
                <option value="">全部用户</option>
                {users.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName ?? item.username}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
              数据源
              <select
                aria-label="数据源"
                className={SELECT_CLASS}
                value={filters.datasourceId}
                onChange={(event) => updateFilter("datasourceId", event.target.value)}
              >
                <option value="">全部数据源</option>
                {datasources.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
              动作
              <select
                aria-label="动作"
                className={SELECT_CLASS}
                value={filters.action}
                onChange={(event) => updateFilter("action", event.target.value)}
              >
                <option value="">全部动作</option>
                {ACTION_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {AUDIT_ACTION_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
              状态
              <select
                aria-label="状态"
                className={SELECT_CLASS}
                value={filters.status}
                onChange={(event) => updateFilter("status", event.target.value)}
              >
                <option value="">全部状态</option>
                {STATUS_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {AUDIT_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
              开始日期
              <Input
                type="date"
                aria-label="开始日期"
                value={filters.from}
                onChange={(event) => updateFilter("from", event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-neutral-500">
              结束日期
              <Input
                type="date"
                aria-label="结束日期"
                value={filters.to}
                onChange={(event) => updateFilter("to", event.target.value)}
              />
            </label>
          </div>

          {errorMessage ? (
            <div
              role="alert"
              className="mt-4 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              <span>{errorMessage}</span>
              <Button variant="outline" size="sm" onClick={() => void auditQuery.refetch()}>
                重试
              </Button>
            </div>
          ) : null}

          <div className="mt-4 overflow-hidden rounded-lg border border-neutral-200 bg-white">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-neutral-50 text-xs text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">时间</th>
                  <th className="px-3 py-2 text-left font-medium">用户</th>
                  <th className="px-3 py-2 text-left font-medium">动作</th>
                  <th className="px-3 py-2 text-left font-medium">数据源</th>
                  <th className="px-3 py-2 text-left font-medium">状态</th>
                  <th className="px-3 py-2 text-right font-medium">耗时</th>
                  <th className="px-3 py-2 text-right font-medium">行数</th>
                  <th className="px-3 py-2 text-left font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {auditQuery.isPending ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-sm text-neutral-400" colSpan={8}>
                      加载中…
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-sm text-neutral-400" colSpan={8}>
                      {hasFilters ? "没有符合筛选条件的审计记录。" : "暂无审计记录。"}
                    </td>
                  </tr>
                ) : (
                  items.map((entry) => {
                    const ip =
                      typeof entry.detailJson?.ip === "string" ? entry.detailJson.ip : null;
                    return (
                      <tr
                        key={entry.id}
                        tabIndex={0}
                        aria-label={`查看审计记录 ${entry.id}`}
                        className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 focus:bg-neutral-50 focus:outline-none"
                        onClick={() => setSelected(entry)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelected(entry);
                          }
                        }}
                      >
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-600">
                          {formatDateTime(entry.createdAt)}
                        </td>
                        <td className="px-3 py-2 text-neutral-800">
                          {entry.userId
                            ? (userNames.get(entry.userId) ?? entry.userId)
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-neutral-700">
                          {AUDIT_ACTION_LABELS[entry.action]}
                        </td>
                        <td className="px-3 py-2 text-neutral-700">
                          {entry.datasourceId
                            ? (datasourceNames.get(entry.datasourceId) ?? entry.datasourceId)
                            : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                              STATUS_BADGE_CLASSES[entry.status],
                            )}
                          >
                            {AUDIT_STATUS_LABELS[entry.status]}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-neutral-600">
                          {entry.durationMs === null ? "—" : `${entry.durationMs} ms`}
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-neutral-600">
                          {entry.rowCount === null ? "—" : entry.rowCount}
                        </td>
                        <td className="px-3 py-2 text-xs text-neutral-500">{ip ?? "—"}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between text-xs text-neutral-500">
            <span>
              共 {total} 条 · 第 {currentPage + 1} / {pageCount} 页
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                aria-label="上一页"
                disabled={currentPage === 0 || auditQuery.isFetching}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label="下一页"
                disabled={currentPage >= pageCount - 1 || auditQuery.isFetching}
                onClick={() => setPage(currentPage + 1)}
              >
                下一页
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {selected ? (
        <AuditDetailDrawer
          entry={selected}
          userName={selected.userId ? (userNames.get(selected.userId) ?? null) : null}
          datasourceName={
            selected.datasourceId ? (datasourceNames.get(selected.datasourceId) ?? null) : null
          }
          onClose={() => setSelected(null)}
        />
      ) : null}
    </AppShell>
  );
}
