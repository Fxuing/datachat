import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { queryAudit } from "../db/schema.js";

export type AuditStatus = "ok" | "rejected" | "error" | "timeout";
export type AuditAction = "query" | "explain" | "export";

export interface AuditInput {
  runId: string | null;
  conversationId: string | null;
  userId: string;
  datasourceId: string;
  action: AuditAction;
  sqlText: string;
  status: AuditStatus;
  rowCount?: number;
  durationMs?: number;
  errorMessage?: string;
}

/**
 * Store a single audit row. The SQL is kept verbatim for debugging; credentials
 * embedded in driver error messages are redacted before they reach the log.
 */
export function recordAudit(db: Db, input: AuditInput): string {
  const id = randomUUID();
  db.insert(queryAudit)
    .values({
      id,
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasourceId,
      action: input.action,
      sqlText: input.sqlText,
      sqlHash: createHash("sha256").update(input.sqlText).digest("hex"),
      status: input.status,
      rowCount: input.rowCount ?? null,
      durationMs: input.durationMs ?? null,
      errorMessage: input.errorMessage ? redactSecrets(input.errorMessage) : null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export function redactSecrets(message: string): string {
  return message
    .replace(/(password\s*[=:]\s*)\S+/gi, "$1***")
    .replace(/(\b(?:mysql|postgres(?:ql)?):\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1***@");
}
