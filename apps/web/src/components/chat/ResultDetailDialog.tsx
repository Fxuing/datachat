import type { ReactNode } from "react";
import { Table2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

export function ResultDetailDialog({
  title,
  sql,
  onClose,
  children,
}: {
  title: string;
  sql?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="flex max-h-[90vh] max-w-5xl flex-col gap-0 p-0">
        <DialogHeader className="flex-row items-center gap-2 pr-10">
          <Table2 className="h-4 w-4 text-muted" aria-hidden />
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
        {sql ? (
          <details className="border-t border-line px-3 py-2 text-[11px] text-muted">
            <summary className="cursor-pointer select-none py-1 hover:text-ink">查看 SQL</summary>
            <pre className="mt-1 max-h-32 overflow-auto rounded bg-[#0b0e14] px-3 py-2 text-[11px] leading-relaxed text-[#d6deeb]">
              <code>{sql}</code>
            </pre>
          </details>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
