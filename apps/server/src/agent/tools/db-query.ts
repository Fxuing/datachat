import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findDatasource } from "../../db/repositories/datasources.js";
import { runGuardedQuery } from "../../services/query-service.js";
import type { ColumnInfo } from "../../services/artifacts.js";
import { guardSql } from "../sql/guard.js";
import {
  errorMessage,
  errorResult,
  safeJsonStringify,
  textResult,
  type AgentToolContext,
} from "./context.js";

const queryParameters = Type.Object({
  sql: Type.String({ description: "要执行的只读 SQL（SELECT/SHOW/DESC/EXPLAIN），必须带 LIMIT" }),
});

export type DbQueryParams = Static<typeof queryParameters>;

export interface DbQueryDetails {
  artifactId: string;
  columns: ColumnInfo[];
  rowCount: number;
  truncated: boolean;
  auditId: string;
  sql: string;
  /** Whether the SQL passed the guard. Rejections never touch a datasource. */
  guard: "ok" | "rejected";
  durationMs?: number;
  code?: string;
  message?: string;
}

function failureDetails(
  sql: string,
  code: string,
  message: string,
  auditId = "",
): DbQueryDetails {
  return {
    artifactId: "",
    columns: [],
    rowCount: 0,
    truncated: false,
    auditId,
    sql,
    guard: "rejected",
    code,
    message,
  };
}

export function createDbQueryTool(
  ctx: AgentToolContext,
): ToolDefinition<typeof queryParameters, DbQueryDetails> {
  return {
    name: "db_query",
    label: "执行查询",
    description:
      "在当前数据源执行一条只读 SQL。成功时返回 artifactId、列信息、总行数与最多 20 行预览；完整结果由前端从 artifact 读取。",
    parameters: queryParameters,
    async execute(_toolCallId, params, signal) {
      const sql = params.sql;
      try {
        const datasource = findDatasource(ctx.db, ctx.datasourceId);
        if (!datasource) {
          return errorResult(
            "DATASOURCE_NOT_FOUND",
            "会话绑定的数据源不存在",
            failureDetails(sql, "DATASOURCE_NOT_FOUND", "会话绑定的数据源不存在"),
          );
        }

        const result = await runGuardedQuery(
          { db: ctx.db, config: ctx.config, pools: ctx.pools, artifacts: ctx.artifacts },
          {
            datasource,
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            runId: ctx.runId,
            sql,
            signal,
          },
        );

        if (!result.ok) {
          return errorResult(
            result.code,
            result.reason,
            failureDetails(sql, result.code, result.reason, result.auditId),
          );
        }

        // The executor ran the guarded SQL; re-derive it so the SQL card shows
        // exactly what reached the database (including the injected LIMIT).
        const guarded = guardSql({
          sql,
          dialect: datasource.type,
          maxRows: ctx.config.queryMaxRows,
        });
        const details: DbQueryDetails = {
          artifactId: result.artifactId,
          columns: result.columns,
          rowCount: result.rowCount,
          truncated: result.truncated,
          auditId: result.auditId,
          sql: guarded.ok ? guarded.sql : sql,
          guard: "ok",
          durationMs: result.durationMs,
        };
        return textResult(
          safeJsonStringify({
            artifactId: result.artifactId,
            columns: result.columns,
            rowCount: result.rowCount,
            truncated: result.truncated,
            previewRows: result.previewRows.slice(0, 20),
          }),
          details,
        );
      } catch (error) {
        const message = errorMessage(error);
        return errorResult("TOOL_ERROR", message, failureDetails(sql, "TOOL_ERROR", message));
      }
    },
  };
}
