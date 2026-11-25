import type { Column } from "@datachat/shared";
import { useEffect, useState } from "react";
import { ChevronRight, Table2 } from "lucide-react";
import { ApiError, getArtifactRows, type ChatResult } from "../../lib/api";
import type { ResultSegment } from "../../lib/report-markdown";
import { formatCount } from "../../lib/utils";
import { ResultDetailDialog } from "./ResultDetailDialog";
import { MAX_PREVIEW_ROWS, ResultTable } from "./ResultTable";

function defaultResultTitle(result: ChatResult): string {
  return result.truncated ? "查看查询结果" : "查看完整结果";
}

function summarizeColumns(columns: ChatResult["columns"]): string | null {
  const names = columns.map((col) => col.name.trim()).filter(Boolean);
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(" · ");
  return `${names.slice(0, 2).join(" · ")} 等`;
}

export function ResultLink({
  result,
  title,
  canExport = true,
}: {
  result: ChatResult;
  title?: string;
  canExport?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{
    artifactId: string;
    columns: Column[];
    rows: unknown[][];
    total: number;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(null);
    setLoadError(null);
  }, [result.artifactId]);

  useEffect(() => {
    if (!open) return;
    if (result.rows.length > 0 || result.rowCount === 0) return;
    if (loaded?.artifactId === result.artifactId) return;

    let cancelled = false;
    setLoadError(null);
    getArtifactRows(result.artifactId, { offset: 0, limit: MAX_PREVIEW_ROWS })
      .then((page) => {
        if (cancelled) return;
        setLoaded({
          artifactId: result.artifactId,
          columns: page.columns,
          rows: page.rows,
          total: page.total,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(
          error instanceof ApiError ? error.message : "加载查询结果失败，请稍后重试",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [open, result.artifactId, result.rows.length, result.rowCount, loaded?.artifactId]);

  const resolvedColumns =
    result.rows.length > 0 || result.rowCount === 0
      ? result.columns
      : loaded?.columns.length
        ? loaded.columns
        : result.columns;
  const resolvedRows =
    result.rows.length > 0 || result.rowCount === 0
      ? result.rows
      : loaded?.rows ?? [];
  const resolvedRowCount = loaded?.total ?? result.rowCount;
  const needsRows = result.rows.length === 0 && result.rowCount > 0 && !loaded;

  const customTitle = title?.trim();
  const displayTitle = customTitle || defaultResultTitle(result);
  const countLabel = result.truncated
    ? `已截断 · ${formatCount(result.rowCount)} 行`
    : `${formatCount(result.rowCount)} 行`;
  const dialogTitle =
    customTitle &&
    customTitle !== "查看完整结果" &&
    customTitle !== "查看查询结果"
      ? customTitle
      : "查询结果";

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setLoadError(null);
          setOpen(true);
        }}
        className="group inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-card transition-colors hover:border-brand/40 hover:bg-brandsoft/40"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-brandsoft text-brandtext">
          <Table2 className="h-3 w-3" aria-hidden />
        </span>
        <span className="truncate font-medium text-ink">{displayTitle}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
            result.truncated
              ? "bg-warningsoft text-warning"
              : "bg-subtle text-muted"
          }`}
        >
          {countLabel}
        </span>
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-brandtext"
          aria-hidden
        />
      </button>
      {open ? (
        <ResultDetailDialog
          title={dialogTitle}
          sql={result.sql}
          onClose={() => {
            setOpen(false);
            setLoadError(null);
          }}
        >
          {loadError ? (
            <p role="alert" className="py-6 text-center text-xs text-danger">
              {loadError}
            </p>
          ) : needsRows ? (
            <p className="py-6 text-center text-xs text-muted">加载查询结果…</p>
          ) : (
            <ResultTable
              artifactId={result.artifactId}
              columns={resolvedColumns}
              rows={resolvedRows}
              rowCount={resolvedRowCount}
              truncated={result.truncated}
              embedded
              maxBodyHeightClass="max-h-[60vh]"
              canExport={canExport}
            />
          )}
        </ResultDetailDialog>
      ) : null}
    </>
  );
}

export function ResultLinkGroup({
  items,
  results,
  disambiguate,
  canExport = true,
  hideMissing = false,
}: {
  items: ResultSegment[];
  results: ChatResult[];
  disambiguate: boolean;
  canExport?: boolean;
  hideMissing?: boolean;
}) {
  const entries = items.map((item) => {
    const result = results.find((entry) => entry.artifactId === item.artifactId);
    const explicit = item.label?.trim();
    const baseTitle = !result
      ? undefined
      : explicit ||
        (disambiguate
          ? summarizeColumns(result.columns) ?? defaultResultTitle(result)
          : undefined);
    return { item, result, baseTitle };
  });

  const titleCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.baseTitle) {
      titleCounts.set(entry.baseTitle, (titleCounts.get(entry.baseTitle) ?? 0) + 1);
    }
  }
  const seenCounts = new Map<string, number>();

  const rendered = entries
    .map((entry, index) => {
      if (!entry.result) {
        if (hideMissing) return null;
        return (
          <span
            key={`missing-${entry.item.artifactId}-${index}`}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-dashed border-line bg-surface px-2.5 py-1.5 text-[11px] text-muted"
          >
            结果引用不可用：
            <code className="rounded bg-subtle px-1 py-0.5">{entry.item.artifactId}</code>
          </span>
        );
      }

      let resolvedTitle = entry.baseTitle;
      if (resolvedTitle && (titleCounts.get(resolvedTitle) ?? 0) > 1) {
        const nth = (seenCounts.get(resolvedTitle) ?? 0) + 1;
        seenCounts.set(resolvedTitle, nth);
        resolvedTitle = `${resolvedTitle} #${nth}`;
      }

      return (
        <ResultLink
          key={`result-${entry.item.artifactId}-${index}`}
          result={entry.result}
          title={resolvedTitle}
          canExport={canExport}
        />
      );
    })
    .filter(Boolean);

  if (rendered.length === 0) return null;

  return <div className="flex flex-wrap items-center gap-2">{rendered}</div>;
}
