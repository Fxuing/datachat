import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { conversations, artifacts, queryAudit, reports, shares } from "../src/db/schema.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { saveSettings } from "../src/services/app-settings.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import { createRetentionService } from "../src/services/ops-retention.js";
import { testConfig } from "./helpers/config.js";

const DAY = 86_400_000;

interface Fixture {
  db: Db;
  dataDir: string;
  handle: ReturnType<typeof createDb>;
  artifacts: ArtifactStore;
  oldId: string;
  shareId: string;
  reportId: string;
  artifactId: string;
  busyId: string;
}

let fixture: Fixture | null = null;

async function setup(): Promise<Fixture> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "dc-ops-"));
  const handle = createDb(":memory:");
  migrateDb(handle.db);
  const db = handle.db;
  const config = { ...testConfig, dataDir };
  const store = new ArtifactStore(db, path.join(dataDir, "artifacts"));
  await store.init();

  saveSettings(db, { retentionConversationDays: 7, retentionAuditDays: 7 });
  const now = Date.now();
  const oldId = createConversation(db, {
    userId: "user-1",
    datasourceId: "ds-1",
    title: "old",
  }).id;
  db.update(conversations)
    .set({ lastMessageAt: now - 30 * DAY })
    .where(eq(conversations.id, oldId))
    .run();

  const busyId = createConversation(db, {
    userId: "user-1",
    datasourceId: "ds-1",
    title: "busy",
  }).id;
  db.update(conversations)
    .set({ lastMessageAt: now - 30 * DAY })
    .where(eq(conversations.id, busyId))
    .run();

  const sharedId = createConversation(db, {
    userId: "user-1",
    datasourceId: "ds-1",
    title: "shared",
  }).id;
  db.update(conversations)
    .set({ lastMessageAt: now - 30 * DAY })
    .where(eq(conversations.id, sharedId))
    .run();

  createConversation(db, { userId: "user-1", datasourceId: "ds-1", title: "new" });

  // One result file owned by the old conversation.
  const artifactId = randomUUID();
  const storagePath = `${oldId}/result.jsonl`;
  const absPath = path.join(dataDir, "artifacts", storagePath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, '{"a":1}\n');
  db.insert(artifacts)
    .values({
      id: artifactId,
      conversationId: oldId,
      userId: "user-1",
      kind: "result",
      storagePath,
      columnsJson: "[]",
      rowCount: 1,
      truncated: 0,
      createdAt: now - 30 * DAY,
    })
    .run();

  // Report + revoked share for the old conversation.
  const reportId = randomUUID();
  db.insert(reports)
    .values({
      id: reportId,
      conversationId: oldId,
      userId: "user-1",
      title: "old report",
      markdown: "# old",
      artifactIdsJson: "[]",
      createdAt: now - 30 * DAY,
      updatedAt: now - 30 * DAY,
    })
    .run();
  const shareId = randomUUID();
  db.insert(shares)
    .values({
      id: shareId,
      tokenHash: randomUUID(),
      conversationId: oldId,
      reportId: null,
      createdBy: "user-1",
      expiresAt: now + DAY,
      revokedAt: now - DAY,
      createdAt: now - 30 * DAY,
    })
    .run();

  // Active share keeps the shared conversation forever.
  db.insert(shares)
    .values({
      id: randomUUID(),
      tokenHash: randomUUID(),
      conversationId: sharedId,
      reportId: null,
      createdBy: "user-1",
      expiresAt: now + DAY,
      revokedAt: null,
      createdAt: now,
    })
    .run();

  // Old audit row.
  db.insert(queryAudit)
    .values({
      id: randomUUID(),
      runId: null,
      conversationId: oldId,
      userId: "user-1",
      datasourceId: "ds-1",
      action: "query",
      sqlText: "select 1",
      sqlHash: "hash-1",
      status: "ok",
      durationMs: 5,
      createdAt: now - 30 * DAY,
    })
    .run();

  return {
    db,
    dataDir,
    handle,
    artifacts: store,
    oldId,
    busyId,
    shareId,
    reportId,
    artifactId,
  };
}

function serviceFor(
  f: Fixture,
  opts: { busy?: string[]; removeError?: Error } = {},
) {
  const busy = new Set(opts.busy ?? []);
  const runtime = {
    isBusy: vi.fn((conversationId: string) => busy.has(conversationId)),
    remove: vi.fn(async () => {
      if (opts.removeError) throw opts.removeError;
    }),
  };
  return {
    runtime,
    service: createRetentionService({
      db: f.db,
      config: { ...testConfig, dataDir: f.dataDir },
      runtime,
      artifacts: f.artifacts,
    }),
  };
}

beforeEach(async () => {
  fixture = await setup();
});

afterEach(async () => {
  fixture?.handle.sqlite.close();
  if (fixture) await rm(fixture.dataDir, { recursive: true, force: true });
  fixture = null;
});

describe("retention service", () => {
  it("previews without deleting and counts bytes", async () => {
    const f = fixture!;
    const { service } = serviceFor(f, { busy: [f.busyId] });
    const preview = await service.preview();

    expect(preview.conversationDays).toBe(7);
    expect(preview.conversations.eligible).toBe(3);
    expect(preview.conversations.willDelete).toBe(1);
    expect(preview.conversations.skippedActiveShares).toBe(1);
    expect(preview.conversations.skippedBusy).toBe(1);
    expect(preview.conversations.artifacts).toBe(1);
    expect(preview.conversations.artifactBytes).toBeGreaterThan(0);
    expect(preview.auditRows).toBe(1);
    expect(preview.oldestEligibleAt).not.toBeNull();

    // Preview is read-only.
    expect(
      f.db.select().from(conversations).all().length,
    ).toBe(4);
    expect(await stat(path.join(f.dataDir, "artifacts", f.oldId, "result.jsonl"))).toBeTruthy();
  });

  it("deletes eligible conversations, files, reports and shares", async () => {
    const f = fixture!;
    const { service, runtime } = serviceFor(f, { busy: [f.busyId] });
    const result = await service.run("admin-1");

    expect(result.deletedConversations).toBe(1);
    expect(result.deletedArtifacts).toBe(1);
    expect(result.deletedReports).toBe(1);
    expect(result.deletedShares).toBe(1);
    expect(result.deletedAuditRows).toBe(1);
    expect(result.skippedActiveShares).toBe(1);
    expect(result.skippedBusy).toBe(1);
    expect(result.errors).toEqual([]);
    expect(runtime.remove).toHaveBeenCalledWith(f.oldId);

    expect(f.db.select().from(conversations).all().map((row) => row.id)).not.toContain(f.oldId);
    expect(f.db.select().from(reports).all()).toHaveLength(0);
    expect(f.db.select().from(shares).all()).toHaveLength(1);
    await expect(
      stat(path.join(f.dataDir, "artifacts", f.oldId, "result.jsonl")),
    ).rejects.toThrow();

    const opsAudit = f.db
      .select()
      .from(queryAudit)
      .all()
      .filter((row) => row.action === "ops");
    expect(opsAudit).toHaveLength(1);
    expect(opsAudit[0]?.status).toBe("ok");
  });

  it("reports a per-conversation failure without stopping the rest", async () => {
    const f = fixture!;
    const { service } = serviceFor(f, {
      busy: [f.busyId],
      removeError: new Error("runtime busy"),
    });
    const result = await service.run(null);
    expect(result.deletedConversations).toBe(0);
    expect(result.errors).toEqual([{ conversationId: f.oldId, message: "runtime busy" }]);
    expect(f.db.select().from(conversations).all().map((row) => row.id)).toContain(f.oldId);
  });

  it("refuses to run when retention is disabled", async () => {
    const f = fixture!;
    saveSettings(f.db, { retentionConversationDays: 0, retentionAuditDays: 0 });
    const { service } = serviceFor(f);
    await expect(service.run(null)).rejects.toMatchObject({ code: "RETENTION_DISABLED" });
  });
});
