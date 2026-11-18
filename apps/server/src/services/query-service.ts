import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { findDatasource, type DatasourceRow } from "../db/repositories/datasources.js";
import { findUserById } from "../db/repositories/users.js";
import { canAccessDatasource, resolveUserAccess } from "../auth/access.js";
import { decryptSecret, deriveSecretKey } from "../agent/datasource/crypto.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import { guardSql, type GuardErrorCode } from "../agent/sql/guard.js";
import { ScopeRewriteError } from "../agent/sql/scope.js";
import { ScopeResolveError, applyScopeToSql, type ScopeResolveCode } from "./data-scope.js";
import { saveRunScopeSnapshot } from "../db/repositories/runs.js";
import { SqlAbortedError, SqlTimeoutError, executeReadOnly } from "../agent/sql/executor.js";
import type { ArtifactStore, ColumnInfo } from "./artifacts.js";
import { resolveQueryLimits } from "./app-settings.js";
import { recordAudit } from "./audit.js";

export interface RunQueryInput {
  datasource: DatasourceRow;
  userId: string;
  conversationId: string | null;
  runId: string | null;
  sql: string;
  action?: "query" | "explain";
  signal?: AbortSignal;
}

export type QueryFailureCode =
  | GuardErrorCode
  | ScopeResolveCode
  | "SCOPE_REWRITE_FAILED"
  | "FORBIDDEN"
  | "SQL_ERROR"
  | "SQL_TIMEOUT"
  | "SQL_ABORTED";

export type RunQueryResult =
  | {
      ok: true;
      artifactId: string;
      columns: ColumnInfo[];
      previewRows: unknown[][];
      rowCount: number;
      truncated: boolean;
      durationMs: number;
      /** SQL actually sent to the database (guard-injected LIMIT included). */
      guardedSql: string;
      auditId: string;
    }
  | { ok: false; code: QueryFailureCode; reason: string; auditId: string };

export interface QueryServiceDeps {
  db: Db;
  config: AppConfig;
  pools: PoolRegistry;
  artifacts: ArtifactStore;
}

/**
 * Check datasource access before anything touches the network. Permissions and
 * grants are re-resolved from the database rather than trusted from the caller, so
 * a missing/disabled user or an un-granted datasource always fails closed.
 */
export function authorizeDatasourceAccess(
  db: Db,
  userId: string,
  datasourceId: string,
): string | null {
  const user = findUserById(db, userId);
  if (!user) return "用户不存在";
  if (user.status !== "active") return "用户已被禁用";
  const allowed = canAccessDatasource(resolveUserAccess(db, user), datasourceId);
  return allowed ? null : "无权访问该数据源";
}

export async function runGuardedQuery(
  deps: QueryServiceDeps,
  input: RunQueryInput,
): Promise<RunQueryResult> {
  const { db, config, pools, artifacts } = deps;
  const action = input.action ?? "query";
  // Read once so the guard, the executor and the returned SQL all agree, and
  // admin changes take effect on the next run without a restart.
  const limits = resolveQueryLimits(db, config);

  const denied = authorizeDatasourceAccess(db, input.userId, input.datasource.id);
  if (denied) {
    const auditId = recordAudit(db, {
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasource.id,
      action,
      sqlText: input.sql,
      status: "rejected",
      errorMessage: denied,
    });
    return { ok: false, code: "FORBIDDEN", reason: denied, auditId };
  }

  if (input.datasource.readOnlyVerified !== 1 && input.datasource.allowWriteAccount !== 1) {
    const reason = "数据源尚未通过只读校验，已拒绝执行";
    const auditId = recordAudit(db, {
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasource.id,
      action,
      sqlText: input.sql,
      status: "rejected",
      errorMessage: reason,
    });
    return { ok: false, code: "FORBIDDEN", reason, auditId };
  }

  const guard = guardSql({
    sql: input.sql,
    dialect: input.datasource.type,
    maxRows: limits.maxRows,
  });

  // Rejections must never reach a datasource: no pool is created, no connection
  // is acquired, and no artifact file is opened.
  if (!guard.ok) {
    const auditId = recordAudit(db, {
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      datasourceId: input.datasource.id,
      action,
      sqlText: input.sql,
      status: "rejected",
      errorMessage: guard.reason,
    });
    return { ok: false, code: guard.code, reason: guard.reason, auditId };
  }

  // Department scope is resolved after the guard (so only safe statements reach the
  // AST rewrite) but before any connection or artifact is opened.
  let executableSql = guard.sql;
  let params: string[] | undefined;
  let appliedTables: string[] = [];
  let scopeSnapshotJson: string | null = null;
  try {
    const scoped = applyScopeToSql({
      db,
      datasourceId: input.datasource.id,
      mode: input.datasource.dataScopeMode,
      userId: input.userId,
      sql: guard.sql,
      dialect: input.datasource.type,
    });
    executableSql = scoped.sql;
    params = scoped.params.length > 0 ? scoped.params : undefined;
    appliedTables = scoped.appliedTables;
    scopeSnapshotJson = JSON.stringify({
      ...scoped.snapshot,
      scopedTables: appliedTables,
    });
  } catch (error) {
    if (error instanceof ScopeResolveError || error instanceof ScopeRewriteError) {
      const auditId = recordAudit(db, {
        runId: input.runId,
        conversationId: input.conversationId,
        userId: input.userId,
        datasourceId: input.datasource.id,
        action,
        sqlText: guard.sql,
        status: "rejected",
        errorMessage: error.message,
        scopeReason: error.code,
      });
      return { ok: false, code: error.code, reason: error.message, auditId };
    }
    throw error;
  }

  if (input.runId && scopeSnapshotJson) {
    try {
      saveRunScopeSnapshot(db, input.runId, scopeSnapshotJson);
    } catch {
      // A missing snapshot degrades to legacy visibility; it must not fail the run.
    }
  }

  const started = Date.now();
  const writer = artifacts.openResult({
    userId: input.userId,
    conversationId: input.conversationId,
    runId: input.runId,
  });
  let finished = false;

  try {
    const connection = {
      id: input.datasource.id,
      type: input.datasource.type,
      host: input.datasource.host,
      port: input.datasource.port,
      database: input.datasource.database,
      username: input.datasource.username,
      password: decryptSecret(
        input.datasource.passwordCipher,
        deriveSecretKey(config.appSecret),
      ),
      sslMode: input.datasource.sslMode,
    };
    const handle = pools.get(connection);
    const result = await executeReadOnly(
      {
        dialect: input.datasource.type,
        pool: input.datasource.type === "mysql" ? handle.mysql! : handle.pg!,
        sql: executableSql,
        params,
        maxRows: limits.maxRows,
        previewRows: limits.previewRows,
        timeoutMs: limits.timeoutMs,
        signal: input.signal,
      },
      (row) => writer.write(row),
    );
    const meta = await writer.finish({
      columns: result.columns,
      rowCount: result.rowCount,
      truncated: result.truncated,
    });
    finished = true;
    // The artifact is already durable; an audit hiccup must not turn success into
    // failure (or cause the catch block to delete a finalized file).
    let auditId = "";
    try {
      auditId = recordAudit(db, {
        runId: input.runId,
        conversationId: input.conversationId,
        userId: input.userId,
        datasourceId: input.datasource.id,
        action,
        sqlText: executableSql,
        status: "ok",
        rowCount: result.rowCount,
        durationMs: Date.now() - started,
        ...(appliedTables.length > 0
          ? {
              scopeReason: "SCOPED",
              detail: { scopeTables: appliedTables },
            }
          : {}),
      });
    } catch {
      // Keep the successful result; only the audit row is lost.
    }
    return {
      ok: true,
      artifactId: meta.id,
      columns: result.columns,
      previewRows: result.previewRows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      durationMs: Date.now() - started,
      guardedSql: executableSql,
      auditId,
    };
  } catch (error) {
    if (!finished) await writer.abort().catch(() => undefined);
    const timeout = error instanceof SqlTimeoutError || /timeout|MAX_EXECUTION_TIME/i.test(String(error));
    const aborted = error instanceof SqlAbortedError;
    let auditId = "";
    try {
      auditId = recordAudit(db, {
        runId: input.runId,
        conversationId: input.conversationId,
        userId: input.userId,
        datasourceId: input.datasource.id,
        action,
        sqlText: executableSql,
        status: timeout ? "timeout" : "error",
        durationMs: Date.now() - started,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Audit storage failure must not mask the original query error.
    }
    return {
      ok: false,
      code: timeout ? "SQL_TIMEOUT" : aborted ? "SQL_ABORTED" : "SQL_ERROR",
      reason: error instanceof Error ? error.message : String(error),
      auditId,
    };
  }
}

export function loadDatasourceOrThrow(db: Db, id: string): DatasourceRow {
  const ds = findDatasource(db, id);
  if (!ds) throw new Error(`数据源不存在: ${id}`);
  return ds;
}
