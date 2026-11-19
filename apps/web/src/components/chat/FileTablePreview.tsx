import type { FileColumnType, FileTableColumn } from "../../lib/api";

const TYPE_LABELS: Record<FileColumnType, { text: string; className: string }> = {
  INTEGER: { text: "INT", className: "bg-brandsoft text-brandtext" },
  REAL: { text: "NUM", className: "bg-brandsoft text-brandtext" },
  DATE: { text: "DATE", className: "bg-subtle text-inksoft" },
  DATETIME: { text: "TIME", className: "bg-subtle text-inksoft" },
  TEXT: { text: "TEXT", className: "bg-subtle text-muted" },
};

export function formatFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FileTablePreviewProps {
  tableName: string;
  sheetName?: string | null;
  rowCount: number;
  columns: FileTableColumn[];
  sampleRows: Array<Array<string | number | null>>;
  warnings?: string[];
}

export function FileTablePreview({
  tableName,
  sheetName,
  rowCount,
  columns,
  sampleRows,
  warnings = [],
}: FileTablePreviewProps) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate font-mono font-medium text-ink">{tableName}</code>
          {sheetName ? (
            <span className="truncate rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
              Sheet: {sheetName}
            </span>
          ) : null}
        </div>
        <span className="shrink-0 text-[11px] text-muted">
          {rowCount.toLocaleString("zh-CN")} 行 · {columns.length} 列
        </span>
      </div>

      {warnings.length > 0 ? (
        <div className="border-b border-line bg-subtle/40 px-3 py-1.5 text-[11px] text-inksoft">
          {warnings.join("；")}
        </div>
      ) : null}

      <div className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse text-left text-[11px]">
          <thead>
            <tr className="border-b border-line bg-subtle/60">
              {columns.map((column) => {
                const badge = TYPE_LABELS[column.type];
                return (
                  <th
                    key={column.name}
                    className="whitespace-nowrap px-2.5 py-1.5 font-medium text-ink"
                  >
                    <div className="flex items-center gap-1.5">
                      <span>{column.name}</span>
                      <span
                        className={`rounded px-1 py-0.5 font-mono text-[9px] font-normal ${badge.className}`}
                      >
                        {badge.text}
                      </span>
                    </div>
                    {column.originalName !== column.name ? (
                      <div className="text-[10px] font-normal text-muted">
                        原：{column.originalName}
                      </div>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sampleRows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(columns.length, 1)}
                  className="px-2.5 py-2 text-center text-muted"
                >
                  空表（0 行数据）
                </td>
              </tr>
            ) : (
              sampleRows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-line/60 last:border-b-0">
                  {columns.map((column, colIndex) => {
                    const value = row[colIndex];
                    return (
                      <td
                        key={`${rowIndex}-${column.name}`}
                        className="max-w-[14rem] truncate whitespace-nowrap px-2.5 py-1.5 text-inksoft"
                      >
                        {value === null || value === undefined ? (
                          <span className="text-muted/60">NULL</span>
                        ) : (
                          String(value)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
