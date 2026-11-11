import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { createSessionSigner } from "../src/auth/jwt.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { conversations } from "../src/db/schema.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { insertUser } from "../src/db/repositories/users.js";
import { saveSettings } from "../src/services/app-settings.js";
import { testConfig } from "./helpers/config.js";

const DAY = 86_400_000;

let root: string;
let db: Db;
let adminCookie: string;
let userCookie: string;
let oldId: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dc-ops-routes-"));
  const handle = createDb(":memory:");
  db = handle.db;
  migrateDb(db);
  const adminId = randomUUID();
  const userId = randomUUID();
  insertUser(db, {
    id: adminId,
    username: "root",
    passwordHash: "hash",
    role: "admin",
    createdAt: Date.now(),
  });
  insertUser(db, {
    id: userId,
    username: "alice",
    passwordHash: "hash",
    role: "user",
    createdAt: Date.now(),
  });
  const signer = createSessionSigner(testConfig.appSecret);
  adminCookie = await signer.sign({ sub: adminId, username: "root", role: "admin" });
  userCookie = await signer.sign({ sub: userId, username: "alice", role: "user" });

  saveSettings(db, { retentionConversationDays: 7, retentionAuditDays: 0 });
  oldId = createConversation(db, { userId, datasourceId: "ds-1", title: "old" }).id;
  db.update(conversations)
    .set({ lastMessageAt: Date.now() - 30 * DAY })
    .where(eq(conversations.id, oldId))
    .run();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function appFor() {
  return buildApp({
    config: {
      ...testConfig,
      dataDir: root,
      agentAuthPath: path.join(root, "agent", "auth.json"),
    },
    db,
    enableRateLimit: false,
  });
}

describe("ops routes", () => {
  it("previews and runs retention for admins", async () => {
    const app = await appFor();
    try {
      const preview = await app.inject({
        method: "GET",
        url: "/api/admin/ops/retention",
        headers: { cookie: `dc_session=${adminCookie}` },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        conversationDays: 7,
        conversations: { eligible: 1, willDelete: 1 },
      });

      const run = await app.inject({
        method: "POST",
        url: "/api/admin/ops/retention/run",
        headers: { cookie: `dc_session=${adminCookie}` },
      });
      expect(run.statusCode).toBe(200);
      expect(run.json()).toMatchObject({ deletedConversations: 1, errors: [] });
    } finally {
      await app.close();
    }
  });

  it("rejects non-admin users", async () => {
    const app = await appFor();
    try {
      const preview = await app.inject({
        method: "GET",
        url: "/api/admin/ops/retention",
        headers: { cookie: `dc_session=${userCookie}` },
      });
      expect(preview.statusCode).toBe(403);

      const run = await app.inject({
        method: "POST",
        url: "/api/admin/ops/retention/run",
        headers: { cookie: `dc_session=${userCookie}` },
      });
      expect(run.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("returns RETENTION_DISABLED when nothing is configured", async () => {
    saveSettings(db, { retentionConversationDays: 0, retentionAuditDays: 0 });
    const app = await appFor();
    try {
      const run = await app.inject({
        method: "POST",
        url: "/api/admin/ops/retention/run",
        headers: { cookie: `dc_session=${adminCookie}` },
      });
      expect(run.statusCode).toBe(400);
      expect(run.json()).toMatchObject({ error: { code: "RETENTION_DISABLED" } });
    } finally {
      await app.close();
    }
  });
});
