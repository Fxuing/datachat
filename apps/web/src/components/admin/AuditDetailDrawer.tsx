import { type ReactNode } from "react";
import { X } from "lucide-react";
import type { AuditEntry } from "../../lib/api";
import { formatDateTime } from "../../lib/utils";
import { Button } from "../ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";

export interface AuditDetailDrawerProps {
  entry: AuditEntry;
  userName: string | null;
  datasourceName: string | null;
  onClose: () => void;
}

export const AUDIT_ACTION_LABELS: Record<AuditEntry["action"], string> = {
  query: "查询",
  explain: "执行计划",
  export: "导出",
  login: "登录",
  login_failed: "登录失败",
  user_create: "新建用户",
  user_update: "更新用户",
  datasource_create: "新建数据源",
  datasource_update: "更新数据源",
  datasource_delete: "删除数据源",
  grant_update: "更新授权",
  skill_change: "技能变更",
  mcp_change: "MCP 变更",
  role_change: "角色变更",
  ops: "运维操作",
};

export const AUDIT_STATUS_LABELS: Record<AuditEntry["status"], string> = {
  ok: "成功",
  rejected: "拒绝",
  error: "失败",
  timeout: "超时",
};

function detailValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="truncate text-sm text-inksoft">{children}</dd>
    </div>
  );
}

export function AuditDetailDrawer({
  entry,
  userName,
  datasourceName,
  onClose,
}: AuditDetailDrawerProps) {
  const ip = typeof entry.detailJson?.ip === "string" ? entry.detailJson.ip : null;

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent hideClose className="max-w-2xl">
        <SheetHeader className="h-14 flex-row items-center justify-between gap-3 px-4 py-0">
          <div className="min-w-0">
            <SheetTitle className="truncate text-sm">审计详情</SheetTitle>
            <SheetDescription className="truncate text-[11px]">
              {formatDateTime(entry.createdAt)} · {entry.id}
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" aria-label="关闭">
              <X className="h-4 w-4" />
            </Button>
          </SheetClose>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <dl className="grid grid-cols-2 gap-4">
            <Field label="动作">{AUDIT_ACTION_LABELS[entry.action]}</Field>
            <Field label="状态">{AUDIT_STATUS_LABELS[entry.status]}</Field>
            <Field label="用户">{userName ?? entry.userId ?? "—"}</Field>
            <Field label="数据源">{datasourceName ?? entry.datasourceId ?? "—"}</Field>
            <Field label="耗时">{entry.durationMs === null ? "—" : `${entry.durationMs} ms`}</Field>
            <Field label="返回行数">{entry.rowCount === null ? "—" : entry.rowCount}</Field>
            <Field label="会话">{entry.conversationId ?? "—"}</Field>
            <Field label="运行">{entry.runId ?? "—"}</Field>
            <Field label="IP">{ip ?? "—"}</Field>
            <Field label="时间">{formatDateTime(entry.createdAt)}</Field>
          </dl>

          <section className="mt-6">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">SQL</h3>
            {entry.sqlText ? (
              <pre className="mt-2 overflow-x-auto rounded-md border border-line bg-subtle p-3 text-xs leading-relaxed text-inksoft">
                {entry.sqlText}
              </pre>
            ) : (
              <p className="mt-2 text-sm text-muted">无 SQL</p>
            )}
          </section>

          {entry.errorMessage ? (
            <section className="mt-6">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
                错误信息
              </h3>
              <p
                role="alert"
                className="mt-2 whitespace-pre-wrap rounded-md border border-danger/20 bg-dangersoft p-3 text-xs text-danger"
              >
                {entry.errorMessage}
              </p>
            </section>
          ) : null}

          <section className="mt-6">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
              附加信息
            </h3>
            {entry.detailJson ? (
              <dl className="mt-2 grid grid-cols-2 gap-3 rounded-md border border-line bg-subtle p-3">
                {Object.entries(entry.detailJson).map(([key, value]) => (
                  <div key={key} className="min-w-0">
                    <dt className="truncate text-[11px] text-muted">{key}</dt>
                    <dd className="break-words text-xs text-inksoft">{detailValue(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-2 text-sm text-muted">无附加信息</p>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
