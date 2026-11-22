import { useEffect, useRef, useState } from "react";
import { BookmarkPlus, Check, FileSpreadsheet, Loader2, Plus } from "lucide-react";
import type { ConversationFileSummary, ConversationFileTableSummary } from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
  defaultDatasetName?: string;
  busy?: boolean;
  appending?: boolean;
  appendError?: string | null;
  savingDataset?: boolean;
  saveDatasetError?: string | null;
  savedDatasetName?: string | null;
  onClose: () => void;
  onAppendFiles?: (files: File[]) => void;
  onSaveDataset?: (input: { name: string; description?: string }) => void;
}

export function FileTablesDialog({
  open,
  files,
  tables,
  defaultDatasetName = "",
  busy = false,
  appending = false,
  appendError = null,
  savingDataset = false,
  saveDatasetError = null,
  savedDatasetName = null,
  onClose,
  onAppendFiles,
  onSaveDataset,
}: FileTablesDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localHint, setLocalHint] = useState<string | null>(null);
  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [datasetName, setDatasetName] = useState("");
  const [datasetDesc, setDatasetDesc] = useState("");

  useEffect(() => {
    if (!open) {
      setSaveFormOpen(false);
      setLocalHint(null);
    }
  }, [open]);

  useEffect(() => {
    if (savedDatasetName) {
      setSaveFormOpen(false);
    }
  }, [savedDatasetName]);

  const fileById = new Map(files.map((item) => [item.id, item]));
  const canAppend = Boolean(onAppendFiles) && !busy && !appending && tables.length < 10;
  const canSave = Boolean(onSaveDataset) && !busy && !savingDataset && tables.length > 0;

  const openSaveForm = () => {
    const fallbackName =
      defaultDatasetName.trim() ||
      files[0]?.fileName.replace(/\.(xlsx|csv)$/i, "") ||
      "文件数据集";
    setDatasetName(fallbackName.slice(0, 100));
    setDatasetDesc("");
    setSaveFormOpen(true);
  };

  const handleSaveSubmit = () => {
    const trimmed = datasetName.trim();
    if (!trimmed || !onSaveDataset) return;
    onSaveDataset({
      name: trimmed,
      ...(datasetDesc.trim() ? { description: datasetDesc.trim() } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-brand" />
            已导入文件与数据表
          </DialogTitle>
          <DialogDescription>
            共 {files.length} 个文件、{tables.length} 张数据表。可追加上传更多 Excel 或 CSV 文件用于多表 JOIN 分析，或保存为可跨会话复用的轻量数据集。
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
          {saveDatasetError ? (
            <div
              role="alert"
              className="rounded-lg border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger"
            >
              {saveDatasetError}
            </div>
          ) : null}
          {savedDatasetName ? (
            <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs text-ink">
              <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              <span>
                已保存为数据集「{savedDatasetName}」，可在新对话的「Excel / CSV 文件」模式直接复用。
              </span>
            </div>
          ) : null}
          {localHint ? (
            <div className="rounded-lg border border-line bg-subtle/40 px-3 py-2 text-xs text-inksoft">
              {localHint}
            </div>
          ) : null}

          {saveFormOpen ? (
            <div className="space-y-2.5 rounded-lg border border-brand/30 bg-brandsoft/20 p-3">
              <p className="text-xs font-medium text-ink">保存当前数据表为可复用数据集</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor="dataset-name-input" className="text-[11px] text-muted">
                    数据集名称
                  </label>
                  <Input
                    id="dataset-name-input"
                    value={datasetName}
                    maxLength={100}
                    disabled={savingDataset}
                    onChange={(event) => setDatasetName(event.target.value)}
                    placeholder="例如：2026 Q3 销售明细"
                    className="h-8 bg-surface text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="dataset-desc-input" className="text-[11px] text-muted">
                    备注说明（可选）
                  </label>
                  <Input
                    id="dataset-desc-input"
                    value={datasetDesc}
                    maxLength={500}
                    disabled={savingDataset}
                    onChange={(event) => setDatasetDesc(event.target.value)}
                    placeholder="说明数据来源或口径"
                    className="h-8 bg-surface text-xs"
                  />
                </div>
              </div>
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={savingDataset}
                  onClick={() => setSaveFormOpen(false)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={savingDataset || !datasetName.trim()}
                  onClick={handleSaveSubmit}
                >
                  {savingDataset ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <BookmarkPlus className="h-3.5 w-3.5" />
                  )}
                  {savingDataset ? "保存中…" : "确认保存"}
                </Button>
              </div>
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
              ? "当前正在生成回答，完成后可操作"
              : tables.length >= 10
                ? "当前会话已达最多 10 张表上限"
                : "单会话最多支持 10 张表、20 万行数据"}
          </div>
          <div className="flex items-center gap-2">
            {onSaveDataset && !saveFormOpen ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={!canSave}
                onClick={openSaveForm}
              >
                <BookmarkPlus className="h-3.5 w-3.5" />
                保存为数据集
              </Button>
            ) : null}
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
