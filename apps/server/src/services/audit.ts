import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { queryAudit } from "../db/schema.js";

export type AuditStatus = "ok" | "rejected" | "error" | "timeout";
export type AuditAction =
  | "query"
  | "explain"
  | "export"
  | "login"
  | "login_failed"
  | "user_create"
  | "user_update"
  | "datasource_create"
  | "datasource_update"
  | "datasource_delete"
  | "grant_update"
  | "skill_change"
  | "mcp_change"
  | "role_change"
  | "ops";

export interface AuditInput {
  runId: string | null;
  conversationId: string | null;
  userId: string | null;
  datasourceId: string | null;
  action: AuditAction;
  sqlText: string;
  status: AuditStatus;
  rowCount?: number;
  durationMs?: number;
  errorMessage?: string;
  detail?: Record<string, unknown> | null;
}

/** Keep audit rows bounded even when a caller submits a near-100k SQL string. */
export const MAX_AUDIT_SQL_LENGTH = 20_000;

/**
 * Store a single audit row. The SQL is truncated for storage (the hash always
 * covers the full statement); credentials in driver errors are redacted.
 */
export function recordAudit(db: Db, input: AuditInput): string {
  const id = randomUUID();
  const sqlText = input.sqlText.slice(0, MAX_AUDIT_SQL_LENGTH);
  db.insert(queryAudit)
    .values({
      id,
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasourceId,
      action: input.action,
      sqlText,
      sqlHash: createHash("sha256").update(input.sqlText).digest("hex"),
      status: input.status,
      rowCount: input.rowCount ?? null,
      durationMs: input.durationMs ?? null,
      errorMessage: input.errorMessage ? redactSecrets(input.errorMessage) : null,
      detailJson: input.detail ? JSON.stringify(input.detail) : null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export interface AuditEventInput {
  actorUserId: string | null;
  action: AuditAction;
  status?: AuditStatus;
  targetUserId?: string | null;
  datasourceId?: string | null;
  ip?: string | null;
  /** Audit trail label; role changes use `role:<name>` instead of SQL. */
  sqlText?: string;
  detail?: Record<string, unknown> | null;
}

/** Non-query security events (login, user/datasource changes, grants). */
export function recordAuditEvent(db: Db, input: AuditEventInput): string {
  return recordAudit(db, {
    runId: null,
    conversationId: null,
    userId: input.actorUserId,
    datasourceId: input.datasourceId ?? null,
    action: input.action,
    sqlText: input.sqlText ?? "",
    status: input.status ?? "ok",
    detail: {
      ...(input.targetUserId ? { targetUserId: input.targetUserId } : {}),
      ...(input.ip ? { ip: input.ip } : {}),
      ...input.detail,
    },
  });
}

/** Audit failures must never turn a successful request into an error response. */
export function safeRecordAuditEvent(db: Db, input: AuditEventInput): void {
  try {
    recordAuditEvent(db, input);
  } catch {
    // The action already happened; losing an audit row is preferable to a 500.
  }
}

export function redactSecrets(message: string): string {
  return message
    .replace(/(password\s*[=:]\s*)\S+/gi, "$1***")
    .replace(/(\b(?:mysql|postgres(?:ql)?):\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1***@");
}
