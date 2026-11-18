import { useState } from "react";
import { Table2 } from "lucide-react";
import type { ChatResult } from "../../lib/api";
import { formatCount } from "../../lib/utils";
import { ResultDetailDialog } from "./ResultDetailDialog";
import { ResultTable } from "./ResultTable";

export function ResultLink({
  result,
  canExport = true,
}: {
  result: ChatResult;
  canExport?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = result.truncated
    ? `查看查询结果（已截断，${formatCount(result.rowCount)} 行）`
    : `查看完整结果（${formatCount(result.rowCount)} 行）`;

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="inline-flex w-fit items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-brand transition-colors hover:bg-brandsoft hover:text-brandtext"
      >
        <Table2 className="h-3.5 w-3.5" aria-hidden />
        {label}
      </button>
      {open ? (
        <ResultDetailDialog title="查询结果" sql={result.sql} onClose={() => setOpen(false)}>
          <ResultTable
            artifactId={result.artifactId}
            columns={result.columns}
            rows={result.rows}
            rowCount={result.rowCount}
            truncated={result.truncated}
            embedded
            maxBodyHeightClass="max-h-[60vh]"
            canExport={canExport}
          />
        </ResultDetailDialog>
      ) : null}
    </>
  );
}
