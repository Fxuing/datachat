import { useState } from "react";
import type { SqlExample, SqlExampleInput, SqlExampleSource } from "../../lib/api";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export interface SqlExamplePrefill {
  question: string;
  sqlText: string;
  notes?: string;
  source?: SqlExampleSource;
  sourceRunId?: string;
}

export interface SqlExampleDialogProps {
  example: SqlExample | null;
  prefill?: SqlExamplePrefill | null;
  saving: boolean;
  error: string | null;
  onSave: (input: SqlExampleInput) => void;
  onClose: () => void;
}

export function SqlExampleDialog({
  example,
  prefill,
  saving,
  error,
  onSave,
  onClose,
}: SqlExampleDialogProps) {
  const [question, setQuestion] = useState(example?.question ?? prefill?.question ?? "");
  const [sqlText, setSqlText] = useState(example?.sqlText ?? prefill?.sqlText ?? "");
  const [notes, setNotes] = useState(example?.notes ?? prefill?.notes ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const isPromoting = !example && Boolean(prefill?.sourceRunId);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!question.trim()) {
      setLocalError("请输入对应的业务提问。");
      return;
    }
    if (!sqlText.trim()) {
      setLocalError("请输入经过验证的只读 SQL。");
      return;
    }
    setLocalError(null);
    onSave({
      question: question.trim(),
      sqlText: sqlText.trim(),
      notes: notes.trim() || null,
      ...(!example && prefill?.source ? { source: prefill.source } : {}),
      ...(!example && prefill?.sourceRunId ? { sourceRunId: prefill.sourceRunId } : {}),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader className="px-5 py-3.5">
          <DialogTitle>
            {example ? "编辑 SQL 示例" : isPromoting ? "沉淀为验证 SQL 示例" : "新建 SQL 示例"}
          </DialogTitle>
          <DialogDescription>
            系统会在保存前校验 SQL 是否为安全的只读查询；后续遇到相似提问时会自动召回作为 Few-Shot 参考。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          <div className="max-h-[70vh] space-y-3.5 overflow-y-auto px-5 py-4">
            {localError || error ? (
              <p role="alert" className="rounded-md border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger">
                {localError ?? error}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="ex-question" className="text-xs font-medium text-inksoft">
                典型业务提问 *
              </label>
              <Input
                id="ex-question"
                value={question}
                maxLength={500}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="例如：按城市统计最近 30 天已支付订单的复购客户数"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="ex-sql" className="text-xs font-medium text-inksoft">
                标准只读 SQL *
              </label>
              <Textarea
                id="ex-sql"
                rows={7}
                value={sqlText}
                onChange={(e) => setSqlText(e.target.value)}
                className="font-mono text-xs"
                placeholder="SELECT c.city, COUNT(*) AS buyers FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.status = 'paid' GROUP BY c.city LIMIT 50"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="ex-notes" className="text-xs font-medium text-inksoft">
                口径 / 避坑说明（可选）
              </label>
              <Textarea
                id="ex-notes"
                rows={2}
                value={notes}
                maxLength={500}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="例如：复购客户需按 HAVING COUNT(*) >= 2 过滤，且排除取消单。"
              />
            </div>
          </div>

          <DialogFooter className="px-5 py-3">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "校验并保存中…" : "校验并保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
