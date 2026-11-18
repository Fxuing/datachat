import type { Db } from "../db/client.js";
import { findConversation } from "../db/repositories/conversations.js";
import { findDatasource } from "../db/repositories/datasources.js";
import { findRun, type RunRow } from "../db/repositories/runs.js";
import { isSnapshotVisible, parseScopeSnapshot, userDepartmentScope } from "./data-scope.js";

export type ScopeAccessErrorCode = "DATA_SCOPE_NOT_VISIBLE";

export class ScopeAccessError extends Error {
  constructor(
    readonly code: ScopeAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScopeAccessError";
  }
}

export interface ScopeAccessInput {
  runId: string;
  userId: string;
  isAdmin: boolean;
}

/**
 * A run is visible when its scope snapshot still fits the viewer's departments.
 * Runs recorded before the datasource was enabled carry no snapshot and are
 * treated as legacy: invisible to everyone but admins.
 */
export function runScopeVisible(db: Db, run: RunRow, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  const conversation = findConversation(db, run.conversationId);
  if (!conversation) return false;
  const datasource = findDatasource(db, conversation.datasourceId);
  if (datasource?.dataScopeMode !== "enabled") return true;
  const snapshot = parseScopeSnapshot(run.scopeSnapshot);
  if (!snapshot) return false;
  return isSnapshotVisible(snapshot, userDepartmentScope(db, run.userId));
}

/** Throws when the run belongs to a datasource that now excludes the viewer. */
export function assertRunScopeVisible(db: Db, input: ScopeAccessInput): RunRow {
  const run = findRun(db, input.runId);
  if (!run) {
    throw new ScopeAccessError("DATA_SCOPE_NOT_VISIBLE", "结果不存在");
  }
  if (!runScopeVisible(db, run, input.isAdmin)) {
    throw new ScopeAccessError(
      "DATA_SCOPE_NOT_VISIBLE",
      "该结果超出了你当前部门的数据范围，无法查看",
    );
  }
  return run;
}

/** Used by artifact/report routes where the owner is already verified. */
export function artifactRunVisible(db: Db, runId: string | null, isAdmin: boolean): boolean {
  if (isAdmin || runId === null) return true;
  const run = findRun(db, runId);
  // A missing run means there is no snapshot to enforce (legacy/orphaned artifact);
  // ownership has already been checked by the caller.
  return run ? runScopeVisible(db, run, isAdmin) : true;
}
