import type { Column, ExcelSheetSpec, ExcelWorkbookSpec } from "@datachat/shared";
import { useEffect, useRef, useState } from "react";
import { Download, FileSpreadsheet, Table2 } from "lucide-react";
import {
  ApiError,
  getArtifact,
  getArtifactRows,
  type ChatArtifact,
  type ChatResult,
} from "../../lib/api";
import { formatCount } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { artifactDownloadUrl } from "./ArtifactActions";
import { ResultDetailDialog } from "./ResultDetailDialog";
import { MAX_PREVIEW_ROWS, ResultTable } from "./ResultTable";

export function parseExcelSpec(spec: unknown): ExcelWorkbookSpec | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const candidate = spec as {
    filename?: unknown;
    sheets?: unknown;
    totalRows?: unknown;
  };
  if (typeof candidate.filename !== "string" || !candidate.filename.trim()) {
    return null;
  }
  if (!Array.isArray(candidate.sheets) || candidate.sheets.length === 0) {
    return null;
  }
  const sheets: ExcelSheetSpec[] = [];
  for (const item of candidate.sheets) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const sheet = item as { name?: unknown; artifactId?: unknown; rowCount?: unknown };
    if (
      typeof sheet.name !== "string" ||
      typeof sheet.artifactId !== "string" ||
      typeof sheet.rowCount !== "number" ||
      !Number.isFinite(sheet.rowCount)
    ) {
      return null;
    }
    sheets.push({
      name: sheet.name,
      artifactId: sheet.artifactId,
      rowCount: sheet.rowCount,
    });
  }
  const totalRows =
    typeof candidate.totalRows === "number" && Number.isFinite(candidate.totalRows)
      ? candidate.totalRows
      : sheets.reduce((sum, sheet) => sum + sheet.rowCount, 0);
  return {
    filename: candidate.filename,
    sheets,
    totalRows,
  };
}

export interface ExcelCardProps {
  artifactId: string;
  filename: string;
  sheets: ExcelSheetSpec[];
  totalRows: number;
  /** Known query results from the conversation, reused so cached previews open immediately. */
  allResults?: ChatResult[];
  /** Downloads are disabled when the user lacks `export.data`. */
  canExport?: boolean;
}

interface LoadedSheetRows {
  columns: Column[];
  rows: unknown[][];
  total: number;
}

export function ExcelCard({
  artifactId,
  filename,
  sheets,
  totalRows,
  allResults,
  canExport = true,
}: ExcelCardProps) {
  const [previewSheet, setPreviewSheet] = useState<ExcelSheetSpec | null>(null);
  const [loadedSheets, setLoadedSheets] = useState<Record<string, LoadedSheetRows>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const allResultsRef = useRef(allResults);
  allResultsRef.current = allResults;
  const loadedSheetsRef = useRef(loadedSheets);
  loadedSheetsRef.current = loadedSheets;

  useEffect(() => {
    setPreviewSheet(null);
    setLoadedSheets({});
    setLoadError(null);
  }, [artifactId]);

  useEffect(() => {
    if (!previewSheet) return;
    const sheetId = previewSheet.artifactId;
    const cached = allResultsRef.current?.find((item) => item.artifactId === sheetId);
    const hasCachedRows =
      Boolean(cached) && (cached!.rows.length > 0 || cached!.rowCount === 0);
    if (hasCachedRows || loadedSheetsRef.current[sheetId]) return;

    let cancelled = false;
    setLoadError(null);
    getArtifactRows(sheetId, { offset: 0, limit: MAX_PREVIEW_ROWS })
      .then((page) => {
        if (cancelled) return;
        setLoadedSheets((previous) => ({
          ...previous,
          [sheetId]: {
            columns: page.columns,
            rows: page.rows,
            total: page.total,
          },
        }));
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(
          error instanceof ApiError ? error.message : "加载工作表数据失败，请稍后重试",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [previewSheet]);

  const cachedPreview = previewSheet
    ? allResults?.find((item) => item.artifactId === previewSheet.artifactId)
    : undefined;
  const fetchedPreview = previewSheet
    ? loadedSheets[previewSheet.artifactId]
    : undefined;
  const previewTable =
    cachedPreview && (cachedPreview.rows.length > 0 || cachedPreview.rowCount === 0)
      ? {
          columns: cachedPreview.columns,
          rows: cachedPreview.rows,
          rowCount: cachedPreview.rowCount,
          truncated: cachedPreview.truncated,
          sql: cachedPreview.sql,
        }
      : fetchedPreview
        ? {
            columns:
              fetchedPreview.columns.length > 0
                ? fetchedPreview.columns
                : (cachedPreview?.columns ?? []),
            rows: fetchedPreview.rows,
            rowCount: fetchedPreview.total,
            truncated:
              cachedPreview?.truncated ?? fetchedPreview.total > fetchedPreview.rows.length,
            sql: cachedPreview?.sql,
          }
        : null;

  const displayName = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-line bg-surface p-3 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brandsoft text-brandtext">
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{displayName}</p>
              <p className="text-[11px] text-muted">
                {sheets.length} 个工作表 · 共 {formatCount(totalRows)} 行
              </p>
            </div>
          </div>

          {canExport ? (
            <a
              href={artifactDownloadUrl(artifactId, "xlsx")}
              download
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink px-3 text-xs font-medium text-canvas shadow-sm transition-opacity hover:opacity-90"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              下载 Excel
            </a>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex">
                  <Button variant="outline" size="sm" disabled>
                    <Download className="h-3.5 w-3.5" aria-hidden />
                    下载 Excel
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">没有导出权限</TooltipContent>
            </Tooltip>
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
          {sheets.map((sheet, index) => (
            <button
              key={`${sheet.artifactId}-${sheet.name}-${index}`}
              type="button"
              aria-haspopup="dialog"
              onClick={() => {
                setLoadError(null);
                setPreviewSheet(sheet);
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-subtle px-2 py-1 text-[11px] text-inksoft transition-colors hover:border-brand/40 hover:bg-brandsoft/40 hover:text-ink"
            >
              <Table2 className="h-3 w-3 shrink-0 text-muted" aria-hidden />
              <span className="max-w-44 truncate font-medium">{sheet.name}</span>
              <span className="text-muted">{formatCount(sheet.rowCount)} 行</span>
            </button>
          ))}
        </div>
      </div>

      {previewSheet ? (
        <ResultDetailDialog
          title={`${previewSheet.name} · ${displayName}`}
          sql={previewTable?.sql ?? cachedPreview?.sql}
          onClose={() => {
            setPreviewSheet(null);
            setLoadError(null);
          }}
        >
          {loadError ? (
            <p role="alert" className="py-6 text-center text-xs text-danger">
              {loadError}
            </p>
          ) : previewTable ? (
            <ResultTable
              artifactId={previewSheet.artifactId}
              columns={previewTable.columns}
              rows={previewTable.rows}
              rowCount={previewTable.rowCount}
              truncated={previewTable.truncated}
              embedded
              maxBodyHeightClass="max-h-[60vh]"
              canExport={canExport}
            />
          ) : (
            <p className="py-6 text-center text-xs text-muted">加载工作表数据…</p>
          )}
        </ResultDetailDialog>
      ) : null}
    </>
  );
}

/**
 * Historical Excel workbooks come from conversation artifacts; fall back to
 * fetching `/api/artifacts/:id` when `spec` was omitted.
 */
export function HistoricalExcel({
  artifact,
  allResults,
  canExport = true,
}: {
  artifact: ChatArtifact;
  allResults?: ChatResult[];
  canExport?: boolean;
}) {
  const initialSpec = parseExcelSpec(artifact.spec);
  const [spec, setSpec] = useState<ExcelWorkbookSpec | null>(initialSpec);
  const [status, setStatus] = useState<"ready" | "loading" | "failed">(
    initialSpec ? "ready" : artifact.spec ? "failed" : "loading",
  );

  useEffect(() => {
    const parsed = parseExcelSpec(artifact.spec);
    if (parsed) {
      setSpec(parsed);
      setStatus("ready");
      return;
    }
    if (artifact.spec !== null && artifact.spec !== undefined) {
      setSpec(null);
      setStatus("failed");
      return;
    }

    let cancelled = false;
    setSpec(null);
    setStatus("loading");
    getArtifact(artifact.id)
      .then((detail) => {
        if (cancelled) return;
        const resolved = parseExcelSpec(detail.spec);
        if (resolved) {
          setSpec(resolved);
          setStatus("ready");
        } else {
          setStatus("failed");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.spec]);

  if (status === "failed" || (!spec && status === "ready")) {
    return <p className="text-[11px] text-muted">Excel 文件加载失败</p>;
  }
  if (status === "loading" || !spec) {
    return <p className="text-[11px] text-muted">Excel 文件加载中…</p>;
  }
  return (
    <ExcelCard
      artifactId={artifact.id}
      filename={spec.filename}
      sheets={spec.sheets}
      totalRows={spec.totalRows}
      allResults={allResults}
      canExport={canExport}
    />
  );
}
