import path from "node:path";
import { rm, stat } from "node:fs/promises";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import type { RuntimeManager } from "../agent/runtime.js";
import type { ConversationRow } from "../db/repositories/conversations.js";
import { deleteConversation } from "../db/repositories/conversations.js";
import {
  artifacts as artifactsTable,
  conversations,
  queryAudit,
  reports,
  runEvents,
  runs,
  shares,
} from "../db/schema.js";
import { effectiveSettings } from "./app-settings.js";
import type { ArtifactStore } from "./artifacts.js";
import { deleteConversationFiles } from "./conversation-service.js";
import { conversationFileBytes } from "./file-store.js";
import { recordAudit } from "./audit.js";

const DAY_MS = 86_400_000;

export class OpsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "OpsError";
  }
}

export interface RetentionPreview {
  conversationDays: number;
  auditDays: number;
  conversationCutoff: number | null;
  auditCutoff: number | null;
  conversations: {
    eligible: number;
    willDelete: number;
    skippedActiveShares: number;
    skippedBusy: number;
    runs: number;
    events: number;
    artifacts: number;
    artifactBytes: number;
    reports: number;
    shares: number;
  };
  auditRows: number;
  oldestEligibleAt: number | null;
  newestEligibleAt: number | null;
}

export interface RetentionRunResult {
  deletedConversations: number;
  deletedRuns: number;
  deletedEvents: number;
  deletedArtifacts: number;
  deletedReports: number;
  deletedShares: number;
  deletedAuditRows: number;
  skippedActiveShares: number;
  skippedBusy: number;
  errors: Array<{ conversationId: string; message: string }>;
  durationMs: number;
}

export interface RetentionService {
  preview(): Promise<RetentionPreview>;
  run(actorUserId: string | null): Promise<RetentionRunResult>;
  isRunning(): boolean;
}

export interface RetentionServiceOptions {
  db: Db;
  config: AppConfig;
  runtime: Pick<RuntimeManager, "isBusy" | "remove">;
  artifacts: ArtifactStore;
  now?: () => number;
}

interface RetentionPlan {
  conversationDays: number;
  auditDays: number;
  conversationCutoff: number | null;
  auditCutoff: number | null;
  eligible: ConversationRow[];
  deletable: ConversationRow[];
  skippedActiveShares: number;
  skippedBusy: number;
}

function cutoffFor(days: number, now: number): number | null {
  return days > 0 ? now - days * DAY_MS : null;
}

function reportIdsFor(db: Db, conversationId: string): string[] {
  return db
    .select({ id: reports.id })
    .from(reports)
    .where(eq(reports.conversationId, conversationId))
    .all()
    .map((row) => row.id);
}

function hasActiveShare(
  db: Db,
  conversationId: string,
  reportIds: string[],
  now: number,
): boolean {
  const targets = reportIds.length
    ? or(eq(shares.conversationId, conversationId), inArray(shares.reportId, reportIds))
    : eq(shares.conversationId, conversationId);
  return (
    db
      .select({ id: shares.id })
      .from(shares)
      .where(and(targets, isNull(shares.revokedAt), gt(shares.expiresAt, now)))
      .get() !== undefined
  );
}

function runCountFor(db: Db, conversationId: string): number {
  return db.select({ id: runs.id }).from(runs).where(eq(runs.conversationId, conversationId)).all().length;
}

function eventCountFor(db: Db, conversationId: string): number {
  return db
    .select({ id: runEvents.id })
    .from(runEvents)
    .where(eq(runEvents.conversationId, conversationId))
    .all().length;
}

function artifactRowsFor(db: Db, conversationId: string) {
  return db
    .select({ storagePath: artifactsTable.storagePath })
    .from(artifactsTable)
    .where(eq(artifactsTable.conversationId, conversationId))
    .all();
}

async function artifactBytes(
  config: AppConfig,
  rows: Array<{ storagePath: string | null }>,
): Promise<number> {
  const root = path.resolve(path.join(config.dataDir, "artifacts"));
  let total = 0;
  for (const row of rows) {
    if (!row.storagePath) continue;
    const resolved = path.resolve(root, row.storagePath);
    if (!resolved.startsWith(root + path.sep)) continue;
    try {
      total += (await stat(resolved)).size;
    } catch {
      // Missing files are already effectively cleaned; count them as zero.
    }
  }
  return total;
}

export function createRetentionService(options: RetentionServiceOptions): RetentionService {
  const { db, config, runtime, artifacts } = options;
  const now = options.now ?? Date.now;
  let running = false;

  async function loadPlan(): Promise<RetentionPlan> {
    const current = now();
    const settings = effectiveSettings(db, config);
    const conversationCutoff = cutoffFor(settings.retentionConversationDays, current);
    const auditCutoff = cutoffFor(settings.retentionAuditDays, current);

    const eligible =
      conversationCutoff === null
        ? []
        : db
            .select()
            .from(conversations)
            .where(lt(sql<number>`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`, conversationCutoff))
            .all();

    let skippedActiveShares = 0;
    let skippedBusy = 0;
    const deletable: ConversationRow[] = [];
    for (const conversation of eligible) {
      const reportIds = reportIdsFor(db, conversation.id);
      if (hasActiveShare(db, conversation.id, reportIds, current)) {
        skippedActiveShares += 1;
        continue;
      }
      if (runtime.isBusy(conversation.id)) {
        skippedBusy += 1;
        continue;
      }
      deletable.push(conversation);
    }

    return {
      conversationDays: settings.retentionConversationDays,
      auditDays: settings.retentionAuditDays,
      conversationCutoff,
      auditCutoff,
      eligible,
      deletable,
      skippedActiveShares,
      skippedBusy,
    };
  }

  async function preview(): Promise<RetentionPreview> {
    const plan = await loadPlan();
    let runCount = 0;
    let eventCount = 0;
    let artifactCount = 0;
    let bytes = 0;
    let reportCount = 0;
    let shareCount = 0;

    for (const conversation of plan.deletable) {
      runCount += runCountFor(db, conversation.id);
      eventCount += eventCountFor(db, conversation.id);
      const artifactRows = artifactRowsFor(db, conversation.id);
      artifactCount += artifactRows.length;
      bytes += await artifactBytes(config, artifactRows);
      bytes += await conversationFileBytes(config.dataDir, conversation.id);
      const reportIds = reportIdsFor(db, conversation.id);
      reportCount += reportIds.length;
      shareCount +=
        db.select({ id: shares.id }).from(shares).where(eq(shares.conversationId, conversation.id)).all().length +
        (reportIds.length
          ? db.select({ id: shares.id }).from(shares).where(inArray(shares.reportId, reportIds)).all().length
          : 0);
    }

    const timestamps = plan.eligible
      .map((conversation) => conversation.lastMessageAt ?? conversation.createdAt)
      .sort((a, b) => a - b);
    const auditRows =
      plan.auditCutoff === null
        ? 0
        : db
            .select({ id: queryAudit.id })
            .from(queryAudit)
            .where(lt(queryAudit.createdAt, plan.auditCutoff))
            .all().length;

    return {
      conversationDays: plan.conversationDays,
      auditDays: plan.auditDays,
      conversationCutoff: plan.conversationCutoff,
      auditCutoff: plan.auditCutoff,
      conversations: {
        eligible: plan.eligible.length,
        willDelete: plan.deletable.length,
        skippedActiveShares: plan.skippedActiveShares,
        skippedBusy: plan.skippedBusy,
        runs: runCount,
        events: eventCount,
        artifacts: artifactCount,
        artifactBytes: bytes,
        reports: reportCount,
        shares: shareCount,
      },
      auditRows,
      oldestEligibleAt: timestamps[0] ?? null,
      newestEligibleAt: timestamps.at(-1) ?? null,
    };
  }

  async function run(actorUserId: string | null): Promise<RetentionRunResult> {
    if (running) throw new OpsError("RETENTION_RUNNING", "清理任务正在执行", 409);
    running = true;
    const startedAt = now();
    const result: RetentionRunResult = {
      deletedConversations: 0,
      deletedRuns: 0,
      deletedEvents: 0,
      deletedArtifacts: 0,
      deletedReports: 0,
      deletedShares: 0,
      deletedAuditRows: 0,
      skippedActiveShares: 0,
      skippedBusy: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      const plan = await loadPlan();
      if (plan.conversationDays === 0 && plan.auditDays === 0) {
        throw new OpsError("RETENTION_DISABLED", "数据保留未启用");
      }

      for (const conversation of plan.eligible) {
        const reportIds = reportIdsFor(db, conversation.id);
        if (hasActiveShare(db, conversation.id, reportIds, now())) {
          result.skippedActiveShares += 1;
          continue;
        }
        if (runtime.isBusy(conversation.id)) {
          result.skippedBusy += 1;
          continue;
        }

        try {
          const runRows = runCountFor(db, conversation.id);
          const eventRows = eventCountFor(db, conversation.id);
          const artifactRows = artifactRowsFor(db, conversation.id);
          const shareRows = db
            .select({ id: shares.id })
            .from(shares)
            .where(
              reportIds.length
                ? or(eq(shares.conversationId, conversation.id), inArray(shares.reportId, reportIds))
                : eq(shares.conversationId, conversation.id),
            )
            .all().length;

          await runtime.remove(conversation.id);
          await deleteConversationFiles(artifacts, conversation, config.dataDir);
          if (conversation.piSessionFile) {
            const dataRoot = path.resolve(config.dataDir);
            const sessionFile = path.resolve(conversation.piSessionFile);
            if (sessionFile !== dataRoot && sessionFile.startsWith(dataRoot + path.sep)) {
              await rm(sessionFile, { force: true });
            }
          }
          await rm(path.join(config.dataDir, "skills", conversation.id), {
            recursive: true,
            force: true,
          });

          db.transaction((tx) => {
            const target = reportIds.length
              ? or(eq(shares.conversationId, conversation.id), inArray(shares.reportId, reportIds))
              : eq(shares.conversationId, conversation.id);
            tx.delete(shares).where(target).run();
            tx.delete(reports).where(eq(reports.conversationId, conversation.id)).run();
          });
          deleteConversation(db, conversation.id);

          result.deletedConversations += 1;
          result.deletedRuns += runRows;
          result.deletedEvents += eventRows;
          result.deletedArtifacts += artifactRows.length;
          result.deletedReports += reportIds.length;
          result.deletedShares += shareRows;
        } catch (error) {
          result.errors.push({
            conversationId: conversation.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (plan.auditCutoff !== null) {
        const auditRows = db
          .select({ id: queryAudit.id })
          .from(queryAudit)
          .where(lt(queryAudit.createdAt, plan.auditCutoff))
          .all().length;
        db.delete(queryAudit).where(lt(queryAudit.createdAt, plan.auditCutoff)).run();
        result.deletedAuditRows = auditRows;
      }

      result.durationMs = now() - startedAt;
      recordAudit(db, {
        runId: null,
        conversationId: null,
        userId: actorUserId,
        datasourceId: null,
        action: "ops",
        sqlText: "retention",
        status: result.errors.length ? "error" : "ok",
        durationMs: result.durationMs,
        errorMessage: result.errors.length ? `${result.errors.length} 个会话清理失败` : undefined,
        detail: {
          operation: "retention",
          conversationDays: plan.conversationDays,
          auditDays: plan.auditDays,
          deleted: {
            conversations: result.deletedConversations,
            runs: result.deletedRuns,
            events: result.deletedEvents,
            artifacts: result.deletedArtifacts,
            reports: result.deletedReports,
            shares: result.deletedShares,
            auditRows: result.deletedAuditRows,
          },
          skipped: {
            activeShares: result.skippedActiveShares,
            busy: result.skippedBusy,
          },
          errorCount: result.errors.length,
        },
      });
      return result;
    } finally {
      running = false;
    }
  }

  return { preview, run, isRunning: () => running };
}
