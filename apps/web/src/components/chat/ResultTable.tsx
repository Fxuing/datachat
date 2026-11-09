import type { Column } from "@datachat/shared";
import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { cn, formatCount } from "../../lib/utils";
import { Button } from "../ui/button";
import { ArtifactActions } from "./ArtifactActions";

export const MAX_PREVIEW_ROWS = 100;

export interface ResultTableProps {
  artifactId: string;
  columns: Column[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  /** When provided, offers to turn this result into a report. */
  onCreateReport?: (artifactId: string) => void;
}

function isNumeric(column: Column): boolean {
  return column.type === "number";
}

function renderValue(value: unknown) {
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

export function ResultTable({
  artifactId,
  columns,
  rows,
  rowCount,
  truncated,
  onCreateReport,
}: ResultTableProps) {
  const [extraRows, setExtraRows] = useState<unknown[][]>([]);

  // A new artifact replaces the appended pages from the previous one.
  useEffect(() => {
    setExtraRows([]);
  }, [artifactId]);

  const previewRows = rows.slice(0, MAX_PREVIEW_ROWS);
  const displayRows = [...previewRows, ...extraRows];
  const hiddenRows = Math.max(rowCount - displayRows.length, 0);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="max-h-80 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-subtle/80">
            <tr>
              {columns.map((column, index) => (
                <th
                  key={`${column.name}-${index}`}
                  scope="col"
                  className={cn(
                    "border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted",
                    isNumeric(column) ? "text-right" : "text-left",
                  )}
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-surface even:bg-subtle/50">
                {columns.map((column, columnIndex) => (
                  <td
                    key={`${column.name}-${columnIndex}`}
                    data-type={column.type}
                    className={cn(
                      "border-b border-line px-3 py-1.5 text-inksoft",
                      isNumeric(column) ? "text-right tabular-nums" : "text-left",
                    )}
                  >
                    {renderValue(row[columnIndex])}
                  </td>
                ))}
              </tr>
            ))}
            {displayRows.length === 0 ? (
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-subtle px-3 py-2 text-xs text-muted">
        <div className="flex flex-wrap items-center gap-2">
          <span>
            显示 {displayRows.length} / {formatCount(rowCount)} 行
          </span>
          {hiddenRows > 0 || truncated ? (
            <span>
              仅展示前 {displayRows.length} 行（共 {formatCount(rowCount)} 行），完整结果在导出中提供
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onCreateReport ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onCreateReport(artifactId)}
            >
              <FileText className="h-3.5 w-3.5" />
              生成报告
            </Button>
          ) : null}
          <ArtifactActions
            artifactId={artifactId}
            rowCount={rowCount}
            shownRows={displayRows.length}
            onRowsAppended={(rows) => setExtraRows((previous) => [...previous, ...rows])}
          />
        </div>
      </div>
    </div>
  );
}
