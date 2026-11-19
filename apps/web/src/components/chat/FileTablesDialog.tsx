import { useRef, useState } from "react";
import { FileSpreadsheet, Loader2, Plus } from "lucide-react";
import type { ConversationFileSummary, ConversationFileTableSummary } from "../../lib/api";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { FileTablePreview, formatFileBytes } from "./FileTablePreview";

export interface FileTablesDialogProps {
  open: boolean;
  files: ConversationFileSummary[];
  tables: ConversationFileTableSummary[];
  busy?: boolean;
  appending?: boolean;
  appendError?: string | null;
  onClose: () => void;
  onAppendFiles?: (files: File[]) => void;
}

export function FileTablesDialog({
  open,
  files,
  tables,
  busy = false,
  appending = false,
  appendError = null,
  onClose,
  onAppendFiles,
}: FileTablesDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localHint, setLocalHint] = useState<string | null>(null);
  const fileById = new Map(files.map((item) => [item.id, item]));
  const canAppend = Boolean(onAppendFiles) && !busy && !appending && tables.length < 10;

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-brand" />
            已导入文件与数据表
          </DialogTitle>
          <DialogDescription>
            共 {files.length} 个文件、{tables.length} 张数据表。可追加上传更多 Excel 或 CSV 文件用于多表 JOIN 分析。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {appendError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger"
            >
              {appendError}
            </div>
          ) : null}
          {localHint ? (
            <div className="rounded-lg border border-line bg-subtle/40 px-3 py-2 text-xs text-inksoft">
              {localHint}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-muted">源文件清单</p>
            <div className="flex flex-wrap gap-1.5">
              {files.map((file) => (
                <span
                  key={file.id}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-subtle/50 px-2.5 py-1 text-xs text-inksoft"
                >
                  <span className="font-medium text-ink">{file.fileName}</span>
                  <span className="text-[11px] text-muted">
                    {formatFileBytes(file.sizeBytes)} · {file.rowCount.toLocaleString("zh-CN")} 行
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-[11px] font-medium text-muted">表结构与前 3 行样例</p>
            {tables.map((table) => {
              const sourceFile = fileById.get(table.fileId);
              return (
                <div key={table.id} className="space-y-1">
                  {sourceFile ? (
                    <p className="text-[11px] text-muted">来自文件：{sourceFile.fileName}</p>
                  ) : null}
                  <FileTablePreview
                    tableName={table.tableName}
                    sheetName={table.sheetName}
                    rowCount={table.rowCount}
                    columns={table.columns}
                    sampleRows={table.sampleRows}
                    warnings={table.warnings}
                  />
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <div className="text-[11px] text-muted">
            {busy
              ? "当前正在生成回答，完成后可追加文件"
              : tables.length >= 10
                ? "当前会话已达最多 10 张表上限"
                : "单会话最多支持 10 张表、20 万行数据"}
          </div>
          <div className="flex items-center gap-2">
            {onAppendFiles ? (
              <>
                <input
                  ref={inputRef}
                  type="file"
                  aria-label="追加上传 Excel 或 CSV 文件"
                  accept=".xlsx,.csv"
                  multiple
                  disabled={!canAppend}
                  className="sr-only"
                  onChange={(event) => {
                    const picked = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    if (picked.length > 0) {
                      setLocalHint(null);
                      onAppendFiles(picked);
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={!canAppend}
                  onClick={() => inputRef.current?.click()}
                >
                  {appending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  {appending ? "正在导入…" : "追加文件"}
                </Button>
              </>
            ) : null}
            <Button type="button" size="sm" onClick={onClose}>
              关闭
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
