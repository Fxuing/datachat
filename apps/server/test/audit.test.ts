import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { queryAudit } from "../src/db/schema.js";
import { recordAudit, redactSecrets, type AuditStatus } from "../src/services/audit.js";

let root: string;
let handle: DbHandle;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-audit-"));
  handle = createDb(path.join(root, "test.db"));
  migrateDb(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("recordAudit", () => {
  it.each(["ok", "rejected", "error", "timeout"] as AuditStatus[])(
    "stores a %s row with a hashed sql text",
    (status) => {
      const id = recordAudit(handle.db, {
        runId: "run-1",
        conversationId: "conv-1",
        userId: "user-1",
        datasourceId: "ds-1",
        action: "query",
        sqlText: "SELECT 1",
        status,
        rowCount: status === "ok" ? 1 : undefined,
        durationMs: 12,
        errorMessage: status === "ok" ? undefined : "boom",
      });

      const row = handle.db.select().from(queryAudit).where(eq(queryAudit.id, id)).get();
      expect(row).toBeDefined();
      expect(row?.status).toBe(status);
      expect(row?.sqlHash).toBe(createHash("sha256").update("SELECT 1").digest("hex"));
      expect(row?.sqlText).toBe("SELECT 1");
      expect(row?.durationMs).toBe(12);
      expect(row?.createdAt).toBeGreaterThan(0);
    },
  );

  it("redacts credentials from stored error messages", () => {
    const id = recordAudit(handle.db, {
      runId: null,
      conversationId: null,
      userId: "user-1",
      datasourceId: "ds-1",
      action: "query",
      sqlText: "SELECT 1",
      status: "error",
      errorMessage:
        "Access denied password=hunter2 at mysql://root:secret@localhost:3306/app and postgresql://app:pw@db/app",
    });

    const row = handle.db.select().from(queryAudit).where(eq(queryAudit.id, id)).get();
    expect(row?.errorMessage).not.toContain("hunter2");
    expect(row?.errorMessage).not.toContain("secret");
    expect(row?.errorMessage).not.toContain("pw@");
    expect(row?.errorMessage).toContain("password=***");
    expect(row?.errorMessage).toContain("mysql://root:***@");
  });
});

describe("redactSecrets", () => {
  it("only rewrites password-like fragments", () => {
    expect(redactSecrets("connection refused")).toBe("connection refused");
    expect(redactSecrets('password: "abc"')).toBe("password: ***");
  });
});
