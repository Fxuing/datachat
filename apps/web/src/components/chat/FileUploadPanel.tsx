import { useRef, useState, type DragEvent } from "react";
import { Database, FileSpreadsheet, Loader2, Plus, Trash2, Upload } from "lucide-react";
import type { FileDatasetSummary, FilePreviewResponse } from "../../lib/api";
import { cn } from "../../lib/utils";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { FileTablePreview, formatFileBytes } from "./FileTablePreview";

export interface FileUploadPanelProps {
  files: File[];
  headerRows: Array<number | undefined>;
  preview: FilePreviewResponse | null;
  previewLoading: boolean;
  previewError: string | null;
  disabled?: boolean;
  savedDatasets?: FileDatasetSummary[];
  selectedDatasetId?: string | null;
  deletingDatasetId?: string | null;
  onAddFiles: (incoming: File[]) => void;
  onRemoveFile: (index: number) => void;
  onHeaderRowChange: (index: number, headerRow: number | undefined) => void;
  onClearAll: () => void;
  onSelectDataset?: (datasetId: string | null) => void;
  onDeleteDataset?: (datasetId: string) => void;
}

const ACCEPTED_TYPES = ".xlsx,.csv";
const HEADER_ROW_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function FileUploadPanel({
  files,
  headerRows,
  preview,
  previewLoading,
  previewError,
  disabled = false,
  savedDatasets = [],
  selectedDatasetId = null,
  deletingDatasetId = null,
  onAddFiles,
  onRemoveFile,
  onHeaderRowChange,
  onClearAll,
  onSelectDataset,
  onDeleteDataset,
}: FileUploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [deletingDataset, setDeletingDataset] = useState<FileDatasetSummary | null>(null);

  const selectedDataset = selectedDatasetId
    ? (savedDatasets.find((item) => item.id === selectedDatasetId) ?? null)
    : null;

  const openPicker = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) onAddFiles(dropped);
  };

  return (
    <div className="w-full max-w-2xl space-y-3 text-left">
      <input
        ref={inputRef}
        type="file"
        aria-label="选择 Excel 或 CSV 文件"
        accept={ACCEPTED_TYPES}
        multiple
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length > 0) onAddFiles(picked);
        }}
      />

      {selectedDataset ? (
        <div className="space-y-3 rounded-xl border border-brand/40 bg-surface/90 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-xs text-inksoft">
              <Database className="h-4 w-4 shrink-0 text-brand" />
              <span className="truncate font-medium text-ink">
                已选用数据集：{selectedDataset.name}
              </span>
              <span className="shrink-0 text-muted">
                · {selectedDataset.tableCount} 张表 ·{" "}
                {selectedDataset.rowCount.toLocaleString("zh-CN")} 行 ·{" "}
                {formatFileBytes(selectedDataset.sizeBytes)}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted hover:text-ink"
              disabled={disabled}
              onClick={() => onSelectDataset?.(null)}
            >
              更换
            </Button>
          </div>
          {selectedDataset.description ? (
            <p className="text-xs text-muted">{selectedDataset.description}</p>
          ) : null}
          <div className="space-y-2">
            {selectedDataset.tables.map((table) => (
              <FileTablePreview
                key={table.id}
                tableName={table.tableName}
                sheetName={table.sheetName}
                rowCount={table.rowCount}
                columns={table.columns}
                sampleRows={table.sampleRows}
                warnings={table.warnings}
              />
            ))}
          </div>
        </div>
      ) : files.length === 0 ? (
        <>
          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (!disabled) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cn(
              "flex flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed px-4 py-6 text-center transition-colors",
              dragging
                ? "border-brand bg-brandsoft/40"
                : "border-line bg-surface/70 hover:border-brand/50",
              disabled && "opacity-60",
            )}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brandsoft text-brandtext">
              <Upload className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-medium text-ink">拖拽 Excel 或 CSV 文件到这里，或点击选择</p>
              <p className="mt-1 text-[11px] text-muted">
                支持 .xlsx / .csv，单次最多 5 个文件、单文件不超过 20 MB，数据仅在当前会话隔离分析
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={openPicker}
            >
              选择文件
            </Button>
          </div>

          {savedDatasets.length > 0 && onSelectDataset ? (
            <div className="space-y-2 rounded-xl border border-line bg-surface/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-inksoft">或直接复用已保存的数据集</p>
                <span className="text-[11px] text-muted">{savedDatasets.length} 个</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {savedDatasets.map((dataset) => (
                  <div
                    key={dataset.id}
                    className="group flex items-start justify-between gap-2 rounded-lg border border-line bg-canvas/70 p-2.5 transition-colors hover:border-brand/50 hover:bg-brandsoft/15"
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onSelectDataset(dataset.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <Database className="h-3.5 w-3.5 shrink-0 text-brand" />
                        <span className="truncate text-xs font-medium text-ink">
                          {dataset.name}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted">
                        {dataset.tableCount} 张表 · {dataset.rowCount.toLocaleString("zh-CN")} 行 ·{" "}
                        {formatFileBytes(dataset.sizeBytes)}
                      </p>
                      {dataset.tables.length > 0 ? (
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
                          {dataset.tables.map((t) => t.tableName).join(", ")}
                        </p>
                      ) : null}
                    </button>
                    {onDeleteDataset ? (
                      <button
                        type="button"
                        aria-label={`删除数据集 ${dataset.name}`}
                        disabled={disabled || deletingDatasetId === dataset.id}
                        onClick={() => setDeletingDataset(dataset)}
                        className="rounded p-1 text-muted opacity-60 transition-opacity hover:bg-line hover:text-danger group-hover:opacity-100 disabled:opacity-30"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={cn(
            "space-y-3 rounded-xl border p-3 transition-colors",
            dragging ? "border-brand bg-brandsoft/30" : "border-line bg-surface/80",
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-inksoft">
              <FileSpreadsheet className="h-4 w-4 text-brand" />
              <span className="font-medium">已选择 {files.length} 个文件</span>
              {preview ? (
                <span className="text-muted">
                  · {preview.totalTables} 张表 · {preview.totalRows.toLocaleString("zh-CN")} 行
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              {files.length < 5 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  disabled={disabled}
                  onClick={openPicker}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加文件
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted hover:text-danger"
                disabled={disabled}
                onClick={onClearAll}
              >
                清空
              </Button>
            </div>
          </div>

          {previewLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle/40 px-3 py-2 text-xs text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在解析文件并推断列类型…
            </div>
          ) : null}

          {previewError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger"
            >
              {previewError}
            </div>
          ) : null}

          <div className="space-y-2.5">
            {files.map((file, index) => {
              const filePreview = preview?.files[index];
              const selectedHeaderRow = headerRows[index];
              const selectValue = selectedHeaderRow ? String(selectedHeaderRow) : "auto";
              return (
                <div
                  key={`${file.name}-${file.size}-${index}`}
                  className="min-w-0 space-y-2 rounded-lg border border-line bg-subtle/30 p-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-medium text-ink">{file.name}</span>
                      <span className="shrink-0 text-[11px] text-muted">
                        {formatFileBytes(file.size)}
                      </span>
                      {filePreview ? (
                        <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted">
                          表头：第 {filePreview.headerRow} 行
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-[11px] text-muted">表头行</span>
                      <Select
                        value={selectValue}
                        disabled={disabled}
                        onValueChange={(val) =>
                          onHeaderRowChange(index, val === "auto" ? undefined : Number(val))
                        }
                      >
                        <SelectTrigger
                          aria-label={`${file.name} 表头行`}
                          className="h-7 w-24 bg-surface px-2 text-xs"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">自动识别</SelectItem>
                          {HEADER_ROW_OPTIONS.map((rowNum) => (
                            <SelectItem key={rowNum} value={String(rowNum)}>
                              第 {rowNum} 行
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <button
                        type="button"
                        aria-label={`移除文件 ${file.name}`}
                        disabled={disabled}
                        onClick={() => onRemoveFile(index)}
                        className="rounded p-1 text-muted transition-colors hover:bg-line hover:text-danger disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {filePreview ? (
                    <div className="space-y-2">
                      {filePreview.tables.map((table) => (
                        <FileTablePreview
                          key={table.tableName}
                          tableName={table.tableName}
                          sheetName={table.sheetName}
                          rowCount={table.rowCount}
                          columns={table.columns}
                          sampleRows={table.sampleRows}
                          warnings={table.warnings}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {deletingDataset ? (
        <ConfirmDialog
          title="删除数据集"
          description={`确定删除已保存的数据集「${deletingDataset.name}」吗？不影响已创建的分析会话。`}
          confirmLabel="删除"
          variant="danger"
          pending={deletingDatasetId === deletingDataset.id}
          onConfirm={() => {
            onDeleteDataset?.(deletingDataset.id);
            setDeletingDataset(null);
          }}
          onCancel={() => setDeletingDataset(null)}
        />
      ) : null}
    </div>
  );
}
