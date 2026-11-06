import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decryptSecret, deriveSecretKey } from "../datasource/crypto.js";
import { findDatasource } from "../../db/repositories/datasources.js";
import { executeReadOnly, SqlAbortedError, SqlTimeoutError } from "../sql/executor.js";
import { guardSql } from "../sql/guard.js";
import { recordAudit } from "../../services/audit.js";
import { authorizeDatasourceAccess } from "../../services/query-service.js";
import {
  errorMessage,
  errorResult,
  safeJsonStringify,
  textResult,
  type AgentToolContext,
} from "./context.js";

export const MAX_EXPLAIN_BYTES = 4 * 1024;

const explainParameters = Type.Object({
  sql: Type.String({ description: "要查看执行计划的只读 SQL" }),
});

export type DbExplainParams = Static<typeof explainParameters>;

export interface DbExplainDetails {
  rowCount: number;
  truncated: boolean;
  code?: string;
  message?: string;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  // Decoding a byte prefix may drop a split multi-byte character at the end.
  const prefix = new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, maxBytes));
  return `${prefix}\n…（执行计划已截断）`;
}

function renderExplain(columns: string[], rows: unknown[][]): string {
  const header = columns.join(" | ");
  const lines = rows.map((row) =>
    row
      .map((cell) => {
        if (cell === null || cell === undefined) return "NULL";
        if (typeof cell === "object") return safeJsonStringify(cell);
        return String(cell);
      })
      .join(" | "),
  );
  return truncateUtf8([header, ...lines].join("\n"), MAX_EXPLAIN_BYTES);
}

export function createDbExplainTool(
  ctx: AgentToolContext,
): ToolDefinition<typeof explainParameters, DbExplainDetails> {
  return {
    name: "db_explain",
    label: "查看执行计划",
    description:
      "在当前数据源对一条只读 SQL 执行 EXPLAIN，返回执行计划文本（最多 4KB），用于排查慢查询。",
    parameters: explainParameters,
    async execute(_toolCallId, params, signal) {
      const sql = params.sql;
      const failed = (code: string, message: string) =>
        errorResult<DbExplainDetails>(code, message, { rowCount: 0, truncated: false, code, message });

      const audit = (
        status: "ok" | "error" | "timeout" | "rejected",
        durationMs: number,
        options: { rowCount?: number; errorMessage?: string } = {},
      ): void => {
        try {
          recordAudit(ctx.db, {
            runId: ctx.runId || null,
            conversationId: ctx.conversationId,
            userId: ctx.userId,
            datasourceId: ctx.datasourceId,
            action: "explain",
            sqlText: sql,
            status,
            durationMs,
            rowCount: options.rowCount,
            errorMessage: options.errorMessage,
          });
        } catch {
          // Losing an audit row must not fail the tool result.
        }
      };

      const started = Date.now();

      try {
        const datasource = findDatasource(ctx.db, ctx.datasourceId);
        if (!datasource) return failed("DATASOURCE_NOT_FOUND", "会话绑定的数据源不存在");

        const denied = authorizeDatasourceAccess(ctx.db, ctx.userId, ctx.datasourceId);
        if (denied) {
          audit("rejected", Date.now() - started, { errorMessage: denied });
          return failed("DATASOURCE_FORBIDDEN", denied);
        }

        if (datasource.readOnlyVerified !== 1) {
          audit("rejected", Date.now() - started, {
            errorMessage: "数据源尚未通过只读校验，已拒绝执行",
          });
          return failed("FORBIDDEN", "数据源尚未通过只读校验，已拒绝执行");
        }

        const guarded = guardSql({
          sql,
          dialect: datasource.type,
          maxRows: ctx.config.queryMaxRows,
        });
        if (!guarded.ok) {
          audit("rejected", Date.now() - started, { errorMessage: guarded.reason });
          return failed(guarded.code, guarded.reason);
        }

        const handle = ctx.pools.get({
          id: datasource.id,
          type: datasource.type,
          host: datasource.host,
          port: datasource.port,
          database: datasource.database,
          username: datasource.username,
          password: decryptSecret(
            datasource.passwordCipher,
            deriveSecretKey(ctx.config.appSecret),
          ),
          sslMode: datasource.sslMode,
        });

        const result = await executeReadOnly(
          {
            dialect: datasource.type,
            pool: datasource.type === "mysql" ? handle.mysql! : handle.pg!,
            sql: guarded.sql,
            maxRows: ctx.config.queryMaxRows,
            previewRows: ctx.config.queryPreviewRows,
            timeoutMs: ctx.config.queryTimeoutMs,
            signal,
          },
          async () => undefined,
        );

        const durationMs = Date.now() - started;
        audit("ok", durationMs, { rowCount: result.rowCount });
        return textResult(renderExplain(result.columns.map((column) => column.name), result.previewRows), {
          rowCount: result.rowCount,
          truncated: result.truncated,
        });
      } catch (error) {
        const message = errorMessage(error);
        const timedOut =
          error instanceof SqlTimeoutError || /timeout|MAX_EXECUTION_TIME/i.test(message);
        const code = timedOut
          ? "SQL_TIMEOUT"
          : error instanceof SqlAbortedError
            ? "SQL_ABORTED"
            : "SQL_ERROR";
        audit(timedOut ? "timeout" : "error", Date.now() - started, { errorMessage: message });
        return failed(code, message);
      }
    },
  };
}
