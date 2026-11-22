import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const BACKUP_VERSION = 1;
const DB_FILE = "datachat.db";
const COPY_ENTRIES = ["artifacts", "pi-sessions", "skills", "agent", "plugins"] as const;
const RESTORE_ENTRIES = [DB_FILE, ...COPY_ENTRIES] as const;

export interface BackupManifest {
  version: number;
  createdAt: number;
  appVersion: string;
  files: number;
  bytes: number;
  dbSha256: string;
  entries: string[];
}

export interface BackupSummary {
  name: string;
  createdAt: number;
  files: number;
  bytes: number;
}

export interface BackupResult {
  directory: string;
  manifest: BackupManifest;
}

function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walk(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  if (fs.existsSync(root)) visit(root);
  return { files, bytes };
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function backupDirectoryName(date: Date): string {
  return `backup-${timestamp(date)}`;
}

export async function createBackup(input: {
  dataDir: string;
  output?: string;
  now?: Date;
  appVersion?: string;
}): Promise<BackupResult> {
  const dataDir = path.resolve(input.dataDir);
  const dbPath = path.join(dataDir, DB_FILE);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`找不到数据库：${dbPath}`);
  }
  const output = path.resolve(
    input.output ?? path.join(dataDir, "backups", backupDirectoryName(input.now ?? new Date())),
  );
  if (output === dataDir) {
    throw new Error("备份目录不能等于 DATA_DIR");
  }
  for (const entry of COPY_ENTRIES) {
    const source = path.join(dataDir, entry);
    if (isInside(source, output) || source === output) {
      throw new Error(`备份目录不能位于 ${source} 内`);
    }
  }
  if (fs.existsSync(output)) {
    if (!fs.statSync(output).isDirectory() || fs.readdirSync(output).length > 0) {
      throw new Error(`备份目录已存在且非空：${output}`);
    }
  }
  fs.mkdirSync(output, { recursive: true });

  const destinationDb = path.join(output, DB_FILE);
  const source = new Database(dbPath);
  try {
    await source.backup(destinationDb);
  } finally {
    source.close();
  }

  const entries: string[] = [DB_FILE];
  for (const entry of COPY_ENTRIES) {
    const from = path.join(dataDir, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(output, entry), { recursive: true });
    entries.push(entry);
  }

  const totals = walk(output);
  const manifest: BackupManifest = {
    version: BACKUP_VERSION,
    createdAt: (input.now ?? new Date()).getTime(),
    appVersion: input.appVersion ?? "0.1.0",
    files: totals.files,
    bytes: totals.bytes,
    dbSha256: sha256(destinationDb),
    entries,
  };
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { directory: output, manifest };
}

export function listBackups(dataDir: string): BackupSummary[] {
  const root = path.join(dataDir, "backups");
  if (!fs.existsSync(root)) return [];
  const results: BackupSummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
      if (manifest.version !== BACKUP_VERSION) continue;
      results.push({
        name: entry.name,
        createdAt: manifest.createdAt,
        files: manifest.files,
        bytes: manifest.bytes,
      });
    } catch {
      // Ignore partial or manually edited backups.
    }
  }
  return results.sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
}

function readManifest(backupDir: string): BackupManifest {
  const manifestPath = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("备份缺少 manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (manifest.version !== BACKUP_VERSION) {
    throw new Error(`不支持的备份版本：${String(manifest.version)}`);
  }
  if (!manifest.dbSha256) throw new Error("manifest 缺少 dbSha256");
  return manifest;
}

function verifyDatabase(file: string, expectedHash: string): void {
  if (!fs.existsSync(file)) throw new Error("备份缺少 datachat.db");
  const actual = sha256(file);
  if (actual !== expectedHash) throw new Error("备份数据库校验失败（dbSha256 不匹配）");
  const db = new Database(file, { readonly: true });
  try {
    const result = db.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`数据库完整性检查失败：${String(result)}`);
  } finally {
    db.close();
  }
}

function uniqueRollbackPath(dataDir: string): string {
  const parent = path.dirname(dataDir);
  const base = `restore-rollback-${timestamp(new Date())}`;
  let candidate = path.join(parent, base);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${base}-${index}`);
    index += 1;
  }
  return candidate;
}

export function restoreBackup(input: { dataDir: string; from: string }): { rollbackDir: string } {
  const dataDir = path.resolve(input.dataDir);
  const backupDir = path.resolve(input.from);
  const manifest = readManifest(backupDir);
  verifyDatabase(path.join(backupDir, DB_FILE), manifest.dbSha256);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "datachat-restore-"));
  let moved = false;
  let rollbackDir = "";
  try {
    for (const entry of RESTORE_ENTRIES) {
      const source = path.join(backupDir, entry);
      if (!fs.existsSync(source)) continue;
      fs.cpSync(source, path.join(staging, entry), { recursive: true });
    }
    if (!fs.existsSync(path.join(staging, DB_FILE))) {
      throw new Error("暂存目录缺少数据库");
    }

    rollbackDir = uniqueRollbackPath(dataDir);
    if (fs.existsSync(dataDir)) {
      fs.renameSync(dataDir, rollbackDir);
      moved = true;
    }
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      for (const entry of fs.readdirSync(staging)) {
        fs.cpSync(path.join(staging, entry), path.join(dataDir, entry), { recursive: true });
      }
    } catch (error) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      if (moved) fs.renameSync(rollbackDir, dataDir);
      throw error;
    }
    return { rollbackDir };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
