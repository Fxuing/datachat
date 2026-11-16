import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, RefreshCw, X } from "lucide-react";
import {
  getDatasourceSchema,
  refreshDatasourceSchema,
  type DatasourceSchemaTable,
  type DatasourceSummary,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { formatClock } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

export interface DatasourceSchemaDrawerProps {
  datasource: DatasourceSummary;
  onClose: () => void;
}

function tableKey(table: DatasourceSchemaTable): string {
  return `${table.schema}.${table.name}`;
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function DatasourceSchemaDrawer({ datasource, onClose }: DatasourceSchemaDrawerProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch]);

  const schemaQuery = useQuery({
    queryKey: queryKeys.datasourceSchema(datasource.id, debouncedSearch),
    queryFn: () => getDatasourceSchema(datasource.id, { search: debouncedSearch }),
    staleTime: 30_000,
  });

  const refresh = useMutation({
    mutationFn: () => refreshDatasourceSchema(datasource.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.datasourceSchemaAll(datasource.id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.datasources });
    },
  });

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const tables = schemaQuery.data?.tables ?? [];
  const total = schemaQuery.data?.total ?? tables.length;
  const pageCount = Math.max(1, Math.ceil(tables.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleTables = useMemo(
    () => tables.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE),
    [tables, currentPage],
  );
  const refreshError = refresh.isError
    ? describeApiError(refresh.error, "刷新 schema 失败，请稍后重试。")
    : null;

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent hideClose className="max-w-2xl">
        <SheetHeader className="h-14 flex-row items-center justify-between gap-3 px-4 py-0">
          <div className="min-w-0">
            <SheetTitle className="truncate text-sm">
              {datasource.name} 的表结构
            </SheetTitle>
            <p className="truncate text-[11px] text-muted">
              {schemaQuery.data
                ? `共 ${total} 张表 · 刷新于 ${formatClock(schemaQuery.data.refreshedAt)}`
                : `${datasource.host}:${datasource.port}/${datasource.database}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refresh.isPending ? "animate-spin" : ""}`} />
              {refresh.isPending ? "刷新中…" : "刷新"}
            </Button>
            <SheetClose asChild>
              <Button variant="ghost" size="icon" aria-label="关闭表结构">
                <X className="h-4 w-4" />
              </Button>
            </SheetClose>
          </div>
        </SheetHeader>

        <div className="shrink-0 border-b border-line p-3">
          <Input
            value={search}
            placeholder="搜索表名…"
            aria-label="搜索表"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {refreshError ? (
            <p role="alert" className="m-3 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
              {refreshError}
            </p>
          ) : null}
          {schemaQuery.isPending ? (
            <p className="p-4 text-xs text-muted">正在加载表结构…</p>
          ) : schemaQuery.isError ? (
            <p role="alert" className="m-3 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
              {describeApiError(schemaQuery.error, "加载表结构失败，请稍后重试。")}
            </p>
          ) : tables.length === 0 ? (
            <p className="p-4 text-xs text-muted">
              {debouncedSearch ? "没有匹配的表。" : "尚未缓存表结构，请先刷新 schema。"}
            </p>
          ) : (
            <>
              {schemaQuery.data?.error ? (
                <p className="m-3 rounded-md border border-warning/25 bg-warningsoft px-3 py-2 text-xs text-warning">
                  {schemaQuery.data.error}
                </p>
              ) : null}
              <table className="w-full border-collapse text-left text-xs">
                <thead className="bg-subtle text-muted">
                  <tr>
                    <th className="w-8 px-2 py-2" aria-label="展开" />
                    <th className="px-2 py-2 font-medium">表名</th>
                    <th className="px-2 py-2 font-medium">列数</th>
                    <th className="px-2 py-2 font-medium">行数估算</th>
                    <th className="px-2 py-2 font-medium">备注</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTables.map((table) => {
                    const key = tableKey(table);
                    const isOpen = expanded.has(key);
                    const primaryKey = new Set(table.primaryKey);
                    const foreignKeyColumns = new Set(
                      table.foreignKeys.flatMap((foreignKey) => foreignKey.columns),
                    );
                    return (
                      <Fragment key={key}>
                        <tr className="border-t border-line">
                          <td className="px-2 py-2 align-top">
                            <button
                              type="button"
                              aria-label={`${isOpen ? "收起" : "展开"}表 ${key}`}
                              aria-expanded={isOpen}
                              className="rounded p-0.5 text-muted hover:bg-subtle hover:text-inksoft"
                              onClick={() => toggle(key)}
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
                          <td className="px-2 py-2 text-muted">
                            {table.rowEstimate ?? "—"}
                          </td>
                          <td className="max-w-[12rem] truncate px-2 py-2 text-muted">
                            {table.comment ?? "—"}
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr key={`${key}:columns`} className="border-t border-line bg-subtle/60">
                            <td colSpan={5} className="px-3 py-3">
                              <table className="w-full border-collapse text-left text-[11px]">
                                <thead className="text-muted">
                                  <tr>
                                    <th className="px-2 py-1 font-medium">列名</th>
                                    <th className="px-2 py-1 font-medium">类型</th>
                                    <th className="px-2 py-1 font-medium">可空</th>
                                    <th className="px-2 py-1 font-medium">主键</th>
                                    <th className="px-2 py-1 font-medium">外键</th>
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
                                        {primaryKey.has(column.name) ? "是" : ""}
                                      </td>
                                      <td className="px-2 py-1 text-muted">
                                        {foreignKeyColumns.has(column.name) ? "是" : ""}
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
              {total > tables.length ? (
                <p className="px-3 py-2 text-[11px] text-muted">
                  服务端仅返回前 {tables.length} 张匹配表，请使用搜索缩小范围。
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
      </SheetContent>
    </Sheet>
  );
}
