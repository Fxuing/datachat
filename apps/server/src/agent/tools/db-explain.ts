import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decryptSecret, deriveSecretKey } from "../datasource/crypto.js";
import { findDatasource } from "../../db/repositories/datasources.js";
import { executeReadOnly, SqlAbortedError, SqlTimeoutError } from "../sql/executor.js";
import { guardSql } from "../sql/guard.js";
import { recordAudit } from "../../services/audit.js";
import {
  authorizeDatasourceAccess,
  authorizeFileConversationAccess,
} from "../../services/query-service.js";
import { resolveConversationSqlitePath, sqliteFileExists } from "../../services/file-store.js";
import { ScopeRewriteError } from "../sql/scope.js";
import {
  ScopeResolveError,
  applyScopeToSql,
} from "../../services/data-scope.js";
import { resolveDatasourceOptions } from "../../drivers/options.js";
import { defaultDriverRegistry } from "../../drivers/registry.js";
import {
  errorMessage,
  errorResult,
  isFileToolContext,
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
        options: { rowCount?: number; errorMessage?: string; scopeReason?: string } = {},
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
            scopeReason: options.scopeReason,
          });
        } catch {
          // Losing an audit row must not fail the tool result.
        }
      };

      const started = Date.now();

      try {
        if (isFileToolContext(ctx)) {
          const denied = authorizeFileConversationAccess(ctx.db, ctx.userId, ctx.conversationId);
          if (denied) {
            audit("rejected", Date.now() - started, { errorMessage: denied });
            return failed("CONVERSATION_FORBIDDEN", denied);
          }
          const guarded = guardSql({
            sql,
            dialect: "sqlite",
            maxRows: ctx.config.queryMaxRows,
          });
          if (!guarded.ok) {
            audit("rejected", Date.now() - started, { errorMessage: guarded.reason });
            return failed(guarded.code, guarded.reason);
          }
          const sqlitePath = resolveConversationSqlitePath(ctx.config.dataDir, ctx.conversationId);
          if (!(await sqliteFileExists(sqlitePath))) {
            const reason = "当前会话的数据文件不存在或已被清理";
            audit("error", Date.now() - started, { errorMessage: reason });
            return failed("SQL_ERROR", reason);
          }
          const explainSql = /^explain\b/i.test(guarded.sql.trimStart())
            ? guarded.sql
            : `EXPLAIN QUERY PLAN ${guarded.sql}`;
          const result = await executeReadOnly(
            {
              dialect: "sqlite",
              sqlitePath,
              sql: explainSql,
              maxRows: ctx.config.queryMaxRows,
              previewRows: ctx.config.queryPreviewRows,
              timeoutMs: ctx.config.queryTimeoutMs,
              signal,
            },
            async () => undefined,
          );
          const durationMs = Date.now() - started;
          audit("ok", durationMs, { rowCount: result.rowCount });
          return textResult(
            renderExplain(result.columns.map((column) => column.name), result.previewRows),
            { rowCount: result.rowCount, truncated: result.truncated },
          );
        }

        const datasourceId = ctx.datasourceId!;
        const datasource = findDatasource(ctx.db, datasourceId);
        if (!datasource) return failed("DATASOURCE_NOT_FOUND", "会话绑定的数据源不存在");

        const denied = authorizeDatasourceAccess(ctx.db, ctx.userId, datasourceId);
        if (denied) {
          audit("rejected", Date.now() - started, { errorMessage: denied });
          return failed("DATASOURCE_FORBIDDEN", denied);
        }

        if (datasource.readOnlyVerified !== 1 && datasource.allowWriteAccount !== 1) {
          audit("rejected", Date.now() - started, {
            errorMessage: "数据源尚未通过只读校验，已拒绝执行",
          });
          return failed("FORBIDDEN", "数据源尚未通过只读校验，已拒绝执行");
        }

        const driver = (ctx.drivers ?? defaultDriverRegistry).get(datasource.type);
        if (!driver) {
          const reason = `未安装「${datasource.type}」数据源驱动插件`;
          audit("rejected", Date.now() - started, { errorMessage: reason });
          return failed("DRIVER_NOT_INSTALLED", reason);
        }
        if (!driver.manifest.capabilities.explain) {
          const reason = `数据源驱动「${driver.manifest.label}」不支持 EXPLAIN 执行计划`;
          audit("rejected", Date.now() - started, { errorMessage: reason });
          return failed("EXPLAIN_UNSUPPORTED", reason);
        }

        const guarded = guardSql({
          sql,
          dialect: driver.dialect,
          maxRows: ctx.config.queryMaxRows,
        });
        if (!guarded.ok) {
          audit("rejected", Date.now() - started, { errorMessage: guarded.reason });
          return failed(guarded.code, guarded.reason);
        }

        if (datasource.dataScopeMode === "enabled" && !driver.manifest.capabilities.rowScope) {
          const reason = `数据源驱动「${driver.manifest.label}」暂不支持行级数据权限`;
          audit("rejected", Date.now() - started, { errorMessage: reason });
          return failed("SCOPE_UNSUPPORTED_BY_DRIVER", reason);
        }

        // EXPLAIN must resolve department scope before opening a connection pool.
        let scoped;
        try {
          scoped = applyScopeToSql({
            db: ctx.db,
            datasourceId: datasource.id,
            mode: datasource.dataScopeMode,
            userId: ctx.userId,
            sql: guarded.sql,
            dialect: driver.dialect,
          });
        } catch (error) {
          if (error instanceof ScopeResolveError || error instanceof ScopeRewriteError) {
            audit("rejected", Date.now() - started, {
              errorMessage: error.message,
              scopeReason: error.code,
            });
            return failed(error.code, error.message);
          }
          throw error;
        }

        const key = deriveSecretKey(ctx.config.appSecret);
        const resolvedOpts = resolveDatasourceOptions(
          driver.manifest.optionsSchema,
          datasource.optionsJson,
          key,
        );
        const handle = ctx.pools.get({
          id: datasource.id,
          type: datasource.type,
          host: datasource.host,
          port: datasource.port,
          database: datasource.database,
          username: datasource.username,
          password: decryptSecret(datasource.passwordCipher, key),
          sslMode: datasource.sslMode,
          options: resolvedOpts.options,
        });

        const isBuiltinSql = datasource.type === "mysql" || datasource.type === "postgres";
        const result = await executeReadOnly(
          {
            dialect: isBuiltinSql ? (datasource.type as "mysql" | "postgres") : "driver",
            dialectProfile: driver.dialect,
            ...(isBuiltinSql
              ? { pool: datasource.type === "mysql" ? handle.mysql! : handle.pg! }
              : { driverPool: handle.custom, classifyError: driver.classifyError }),
            sql: scoped.sql,
            params: scoped.params.length > 0 ? scoped.params : undefined,
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
