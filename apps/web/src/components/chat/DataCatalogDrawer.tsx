import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Database,
  GitFork,
  MessageSquarePlus,
  Search,
  Table2,
  X,
} from "lucide-react";
import {
  ApiError,
  datasourceTypeLabel,
  getDatasourceSchema,
  type DatasourceCatalogResponse,
  type DatasourceSchemaTable,
  type DatasourceSummary,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { cn, formatClock } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 250;

export interface DataCatalogDrawerProps {
  datasource: DatasourceSummary;
  catalog?: DatasourceCatalogResponse | null;
  catalogLoading?: boolean;
  catalogError?: string | null;
  onRetryCatalog?: () => void;
  onInsertPrompt?: (text: string) => void;
  onClose: () => void;
}

type CatalogTab = "tables" | "metrics" | "relations";

function tableKey(table: DatasourceSchemaTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function DataCatalogDrawer({
  datasource,
  catalog = null,
  catalogLoading = false,
  catalogError = null,
  onRetryCatalog,
  onInsertPrompt,
  onClose,
}: DataCatalogDrawerProps) {
  const [tab, setTab] = useState<CatalogTab>("tables");
  const [tableSearch, setTableSearch] = useState("");
  const debouncedTableSearch = useDebouncedValue(tableSearch.trim(), SEARCH_DEBOUNCE_MS);
  const [metricSearch, setMetricSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setPage(0);
  }, [debouncedTableSearch]);

  useEffect(() => {
    setPage(0);
    setTableSearch("");
    setMetricSearch("");
    setExpanded(new Set());
  }, [datasource.id]);

  const schemaQuery = useQuery({
    queryKey: queryKeys.datasourceSchema(datasource.id, debouncedTableSearch),
    queryFn: () => getDatasourceSchema(datasource.id, { search: debouncedTableSearch }),
    staleTime: 30_000,
    retry: false,
  });

  const tables = useMemo(() => schemaQuery.data?.tables ?? [], [schemaQuery.data?.tables]);
  const totalTables = schemaQuery.data?.total ?? tables.length;
  const pageCount = Math.max(1, Math.ceil(tables.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleTables = useMemo(
    () => tables.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE),
    [tables, currentPage],
  );

  const metrics = useMemo(() => catalog?.metrics ?? [], [catalog?.metrics]);
  const relations = useMemo(() => catalog?.relations ?? [], [catalog?.relations]);

  const filteredMetrics = useMemo(() => {
    const q = metricSearch.trim().toLowerCase();
    if (!q) return metrics;
    return metrics.filter((metric) =>
      [
        metric.name,
        ...metric.synonyms,
        metric.description ?? "",
        metric.tableName ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [metrics, metricSearch]);

  const toggleTable = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const insertAndClose = (prompt: string) => {
    onInsertPrompt?.(prompt);
    onClose();
  };

  const schemaMissingCache =
    schemaQuery.isError &&
    schemaQuery.error instanceof ApiError &&
    schemaQuery.error.status === 404;
  const schemaNoDepartment =
    schemaQuery.isError &&
    schemaQuery.error instanceof ApiError &&
    schemaQuery.error.code === "DATA_SCOPE_NO_DEPARTMENT";

  const refreshedAt = schemaQuery.data?.refreshedAt ?? catalog?.refreshedAt ?? null;
  const tableSummaryCount = schemaQuery.data?.total ?? catalog?.tableCount ?? null;

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent hideClose className="max-w-2xl">
        <SheetHeader className="h-14 flex-row items-center justify-between gap-3 px-4 py-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brandsoft text-brandtext">
              <Database className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <SheetTitle className="truncate text-sm">
                {datasource.name} · {datasourceTypeLabel(datasource)}
              </SheetTitle>
              <p className="truncate text-[11px] text-muted">
                {refreshedAt
                  ? `共 ${tableSummaryCount ?? 0} 张可用表 · 缓存于 ${formatClock(refreshedAt)}`
                  : "尚未缓存表结构"}
              </p>
            </div>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" aria-label="关闭数据目录">
              <X className="h-4 w-4" />
            </Button>
          </SheetClose>
        </SheetHeader>

        <div className="flex shrink-0 items-center gap-1 border-b border-line px-4">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "tables"}
            onClick={() => setTab("tables")}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              tab === "tables"
                ? "border-brand text-brandtext"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            <Table2 className="h-3.5 w-3.5" />
            数据表{tableSummaryCount !== null ? ` (${tableSummaryCount})` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "metrics"}
            onClick={() => setTab("metrics")}
            className={cn(
              "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              tab === "metrics"
                ? "border-brand text-brandtext"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            <BookOpen className="h-3.5 w-3.5" />
            业务指标 ({metrics.length})
          </button>
          {relations.length > 0 ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "relations"}
              onClick={() => setTab("relations")}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === "relations"
                  ? "border-brand text-brandtext"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              <GitFork className="h-3.5 w-3.5" />
              表关联 ({relations.length})
            </button>
          ) : null}
        </div>

        {tab === "tables" ? (
          <>
            <div className="shrink-0 border-b border-line p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <Input
                  value={tableSearch}
                  placeholder="搜索表名、列名或注释…"
                  aria-label="搜索数据表"
                  className="pl-8 text-xs"
                  onChange={(event) => setTableSearch(event.target.value)}
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {schemaQuery.isPending ? (
                <p className="p-4 text-xs text-muted">正在加载表结构…</p>
              ) : schemaNoDepartment ? (
                <div className="m-3 rounded-lg border border-warning/25 bg-warningsoft px-3.5 py-3 text-xs text-warning">
                  当前数据源已启用部门数据权限，但你还没有加入任何部门，请联系管理员在「部门管理」中分配后再查看表结构。
                </div>
              ) : schemaMissingCache ? (
                <div className="m-3 rounded-lg border border-dashed border-line bg-subtle/40 px-4 py-6 text-center text-xs text-muted">
                  当前数据源尚未缓存表结构，发送首条问题时会自动加载，或联系管理员在数据源管理中手动刷新。
                </div>
              ) : schemaQuery.isError ? (
                <div
                  role="alert"
                  className="m-3 flex items-center justify-between gap-2 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
                >
                  <span>{describeApiError(schemaQuery.error, "加载表结构失败，请稍后重试。")}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void schemaQuery.refetch()}
                  >
                    重试
                  </Button>
                </div>
              ) : tables.length === 0 ? (
                <p className="p-4 text-xs text-muted">
                  {debouncedTableSearch ? "没有匹配的数据表。" : "当前权限范围内没有可查看的数据表。"}
                </p>
              ) : (
                <>
                  {schemaQuery.data?.stale ? (
                    <p className="m-3 rounded-md border border-warning/25 bg-warningsoft px-3 py-2 text-xs text-warning">
                      当前展示的是缓存表结构，可能略滞后于数据库最新变更。
                    </p>
                  ) : null}
                  <table className="w-full border-collapse text-left text-xs">
                    <thead className="bg-subtle text-muted">
                      <tr>
                        <th className="w-8 px-2 py-2" aria-label="展开" />
                        <th className="px-2 py-2 font-medium">表名</th>
                        <th className="px-2 py-2 font-medium">列数</th>
                        <th className="px-2 py-2 font-medium">备注</th>
                        {onInsertPrompt ? (
                          <th className="px-2 py-2 text-right font-medium">操作</th>
                        ) : null}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTables.map((table) => {
                        const key = tableKey(table);
                        const isOpen = expanded.has(key);
                        const primaryKey = new Set(table.primaryKey);
                        const foreignKeyColumns = new Set(
                          table.foreignKeys.flatMap((fk) => fk.columns),
                        );
                        return (
                          <Fragment key={key}>
                            <tr className="border-t border-line hover:bg-subtle/30">
                              <td className="px-2 py-2 align-top">
                                <button
                                  type="button"
                                  aria-label={`${isOpen ? "收起" : "展开"}表 ${key}`}
                                  aria-expanded={isOpen}
                                  className="rounded p-0.5 text-muted hover:bg-subtle hover:text-inksoft"
                                  onClick={() => toggleTable(key)}
                                >
                                  {isOpen ? (
                                    <ChevronUp className="h-3.5 w-3.5" />
                                  ) : (
                                    <ChevronDown className="h-3.5 w-3.5" />
                                  )}
                                </button>
                              </td>
                              <td className="px-2 py-2 font-mono text-inksoft">{key}</td>
                              <td className="px-2 py-2 text-muted">{table.columns.length}</td>
                              <td className="max-w-[12rem] truncate px-2 py-2 text-muted">
                                {table.comment ?? "—"}
                              </td>
                              {onInsertPrompt ? (
                                <td className="px-2 py-1.5 text-right">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 gap-1 px-2 text-[11px] text-brandtext"
                                    onClick={() =>
                                      insertAndClose(`请分析 ${table.name} 表的数据情况：`)
                                    }
                                  >
                                    <MessageSquarePlus className="h-3 w-3" />
                                    插入提问
                                  </Button>
                                </td>
                              ) : null}
                            </tr>
                            {isOpen ? (
                              <tr key={`${key}:columns`} className="border-t border-line bg-subtle/60">
                                <td colSpan={onInsertPrompt ? 5 : 4} className="px-3 py-3">
                                  <table className="w-full border-collapse text-left text-[11px]">
                                    <thead className="text-muted">
                                      <tr>
                                        <th className="px-2 py-1 font-medium">列名</th>
                                        <th className="px-2 py-1 font-medium">类型</th>
                                        <th className="px-2 py-1 font-medium">可空</th>
                                        <th className="px-2 py-1 font-medium">键</th>
                                        <th className="px-2 py-1 font-medium">注释</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {table.columns.map((column) => (
                                        <tr key={column.name} className="border-t border-line/70">
                                          <td className="px-2 py-1 font-mono text-inksoft">
                                            {column.name}
                                          </td>
                                          <td className="px-2 py-1 text-muted">{column.type}</td>
                                          <td className="px-2 py-1 text-muted">
                                            {column.nullable ? "是" : "否"}
                                          </td>
                                          <td className="px-2 py-1 text-muted">
                                            {primaryKey.has(column.name)
                                              ? "PK"
                                              : foreignKeyColumns.has(column.name)
                                                ? "FK"
                                                : ""}
                                          </td>
                                          <td className="px-2 py-1 text-muted">
                                            {column.comment ?? "—"}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  {totalTables > tables.length ? (
                    <p className="px-3 py-2 text-[11px] text-muted">
                      仅展示前 {tables.length} 张匹配表，请输入更具体的关键词缩小范围。
                    </p>
                  ) : null}
                </>
              )}
            </div>

            {tables.length > PAGE_SIZE ? (
              <div className="flex shrink-0 items-center justify-between border-t border-line px-3 py-2 text-xs text-muted">
                <span>
                  第 {currentPage + 1} / {pageCount} 页
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="上一页"
                    disabled={currentPage === 0}
                    onClick={() => setPage((value) => Math.max(0, value - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="下一页"
                    disabled={currentPage >= pageCount - 1}
                    onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : tab === "metrics" ? (
          <>
            <div className="shrink-0 border-b border-line p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <Input
                  value={metricSearch}
                  placeholder="搜索指标名称、同义词或口径说明…"
                  aria-label="搜索业务指标"
                  className="pl-8 text-xs"
                  onChange={(event) => setMetricSearch(event.target.value)}
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {catalogLoading ? (
                <p className="p-2 text-xs text-muted">正在加载业务指标…</p>
              ) : catalogError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-2 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
                >
                  <span>{catalogError}</span>
                  {onRetryCatalog ? (
                    <Button type="button" variant="outline" size="sm" onClick={onRetryCatalog}>
                      重试
                    </Button>
                  ) : null}
                </div>
              ) : catalog?.scopeNotice ? (
                <div className="rounded-lg border border-warning/25 bg-warningsoft px-3.5 py-3 text-xs text-warning">
                  {catalog.scopeNotice}
                </div>
              ) : filteredMetrics.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line bg-subtle/40 px-4 py-8 text-center text-xs text-muted">
                  {metricSearch.trim()
                    ? "没有匹配的业务指标。"
                    : "管理员暂未为该数据源配置业务指标口径。"}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredMetrics.map((metric) => (
                    <div
                      key={metric.id}
                      className="rounded-xl border border-line bg-surface p-3.5 shadow-card"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-ink">{metric.name}</span>
                            {metric.unit ? (
                              <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                                单位：{metric.unit}
                              </span>
                            ) : null}
                          </div>
                          {metric.synonyms.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {metric.synonyms.map((syn) => (
                                <span
                                  key={syn}
                                  className="rounded bg-brandsoft/70 px-1.5 py-0.5 text-[10px] text-brandtext"
                                >
                                  {syn}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        {onInsertPrompt ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 px-2.5 text-[11px]"
                            onClick={() =>
                              insertAndClose(
                                `请分析「${metric.name}」的近期趋势和核心构成`,
                              )
                            }
                          >
                            <MessageSquarePlus className="h-3 w-3" />
                            去提问
                          </Button>
                        ) : null}
                      </div>
                      {metric.description ? (
                        <p className="mt-2 text-xs leading-relaxed text-inksoft">
                          {metric.description}
                        </p>
                      ) : null}
                      {(metric.tableName || metric.timeColumn) ? (
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted">
                          {metric.tableName ? (
                            <span>
                              主表：<code className="font-mono text-inksoft">{metric.tableName}</code>
                            </span>
                          ) : null}
                          {metric.timeColumn ? (
                            <span>
                              时间字段：
                              <code className="font-mono text-inksoft">{metric.timeColumn}</code>
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="space-y-2">
              {relations.map((rel) => (
                <div
                  key={rel.id}
                  className="rounded-xl border border-line bg-surface px-3.5 py-3 text-xs shadow-card"
                >
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-ink">
                    <span>
                      {rel.leftTable}.{rel.leftColumn}
                    </span>
                    <span className="rounded bg-brandsoft px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brandtext">
                      {rel.joinType} join
                    </span>
                    <span>
                      {rel.rightTable}.{rel.rightColumn}
                    </span>
                  </div>
                  {rel.description ? (
                    <p className="mt-1.5 text-xs text-muted">{rel.description}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
