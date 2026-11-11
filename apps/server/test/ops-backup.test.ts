import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { users } from "../src/db/schema.js";
import { insertUser } from "../src/db/repositories/users.js";
import {
  createBackup,
  listBackups,
  restoreBackup,
} from "../src/services/ops-backup.js";

let root: string;
let dataDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "dc-ops-backup-"));
  dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const handle = createDb(path.join(dataDir, "datachat.db"));
  migrateDb(handle.db);
  insertUser(handle.db, {
    id: randomUUID(),
    username: "alice",
    passwordHash: "hash",
    role: "user",
    createdAt: Date.now(),
  });
  handle.sqlite.close();
  fs.mkdirSync(path.join(dataDir, "artifacts"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "artifacts", "result.json"), "original");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ops backup", () => {
  it("creates a manifest, copies artifacts and restores them", async () => {
    const result = await createBackup({ dataDir, now: new Date(Date.UTC(2026, 10, 11, 12)) });
    expect(result.directory).toBe(path.join(dataDir, "backups", "backup-20261111-120000"));
    expect(result.manifest.entries).toEqual(["datachat.db", "artifacts"]);
    expect(result.manifest.files).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(result.directory, "manifest.json"))).toBe(true);
    expect(listBackups(dataDir)[0]).toMatchObject({ name: "backup-20261111-120000" });

    fs.writeFileSync(path.join(dataDir, "artifacts", "result.json"), "changed");
    const restored = restoreBackup({ dataDir, from: result.directory });
    expect(fs.readFileSync(path.join(dataDir, "artifacts", "result.json"), "utf8")).toBe(
      "original",
    );
    expect(fs.existsSync(restored.rollbackDir)).toBe(true);
    expect(
      fs.readFileSync(path.join(restored.rollbackDir, "artifacts", "result.json"), "utf8"),
    ).toBe("changed");

    const handle = createDb(path.join(dataDir, "datachat.db"));
    const rows = handle.db.select().from(users).all();
    expect(rows).toHaveLength(1);
    handle.sqlite.close();
  });

  it("refuses to write into a non-empty directory", async () => {
    const output = path.join(root, "existing");
    fs.mkdirSync(output);
    fs.writeFileSync(path.join(output, "keep.txt"), "keep");
    await expect(createBackup({ dataDir, output })).rejects.toThrow(/已存在且非空/);
  });

  it("rejects a tampered database and leaves the target untouched", async () => {
    const result = await createBackup({ dataDir });
    const manifestPath = path.join(result.directory, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { dbSha256: string };
    manifest.dbSha256 = "0".repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(dataDir, "artifacts", "result.json"), "still-here");

    expect(() => restoreBackup({ dataDir, from: result.directory })).toThrow(/校验失败/);
    expect(fs.readFileSync(path.join(dataDir, "artifacts", "result.json"), "utf8")).toBe(
      "still-here",
    );
  });
});
