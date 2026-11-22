import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import {
  validateDatasourceDriver,
  type DatasourceDriver,
  type DatasourceDriverManifest,
  type OptionFieldSchema,
} from "@datachat/datasource-sdk";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { datasourcePlugins, datasources } from "../db/schema.js";
import type { PoolRegistry } from "../agent/datasource/pool.js";
import { extractPluginBundle, PluginArchiveError } from "../drivers/archive.js";
import {
  importDriverModule,
  type DriverRegistry,
  type DriverSource,
} from "../drivers/registry.js";

export class DatasourcePluginError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DatasourcePluginError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export interface AdminDriverPluginItem {
  id: string;
  label: string;
  source: DriverSource;
  builtin: boolean;
  enabled: boolean;
  loaded: boolean;
  version: string | null;
  fileName: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  defaultPort: number | null;
  supportsSsl: boolean;
  capabilities: DatasourceDriverManifest["capabilities"] | null;
  optionsSchema: OptionFieldSchema[];
  datasourceCount: number;
  uploadedAt: number | null;
  updatedAt: number | null;
}

export function pluginsRootDir(config: Pick<AppConfig, "dataDir">): string {
  return path.resolve(config.dataDir, "plugins", "datasources");
}

function resolvePersistedEntry(rootDir: string, relativeEntry: string): string {
  const absRoot = path.resolve(rootDir);
  const absEntry = path.resolve(absRoot, relativeEntry);
  const rel = path.relative(absRoot, absEntry);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new DatasourcePluginError("INVALID_PLUGIN_PATH", "插件入口路径非法", 500);
  }
  return absEntry;
}

async function loadValidatedSingleDriver(entryPath: string): Promise<DatasourceDriver> {
  let candidates: unknown[];
  try {
    candidates = await importDriverModule(entryPath);
  } catch (err) {
    throw new DatasourcePluginError(
      "PLUGIN_LOAD_FAILED",
      `加载插件模块失败：${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }
  if (candidates.length !== 1) {
    throw new DatasourcePluginError(
      "INVALID_PLUGIN",
      `离线上传插件包必须导出单个驱动（当前导出 ${candidates.length} 个）`,
      400,
    );
  }
  const validated = validateDatasourceDriver(candidates[0]);
  if (!validated.ok) {
    throw new DatasourcePluginError("INVALID_PLUGIN", `驱动协议校验失败：${validated.reason}`, 400);
  }
  return validated.driver;
}

function countDatasourcesByType(db: Db): Map<string, number> {
  const rows = db
    .select({
      type: datasources.type,
      count: sql<number>`count(*)`,
    })
    .from(datasources)
    .groupBy(datasources.type)
    .all();
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.type, Number(row.count));
  }
  return map;
}

/**
 * Lists all built-in, env-configured, and admin-uploaded datasource drivers
 * (including disabled uploaded plugins persisted in SQLite).
 */
export function listAdminDatasourcePlugins(input: {
  db: Db;
  config: AppConfig;
  drivers: DriverRegistry;
}): { allowUpload: boolean; drivers: AdminDriverPluginItem[] } {
  const counts = countDatasourcesByType(input.db);
  const uploadedRows = input.db
    .select()
    .from(datasourcePlugins)
    .orderBy(asc(datasourcePlugins.createdAt))
    .all();
  const uploadedById = new Map(uploadedRows.map((row) => [row.driverId, row]));

  const items: AdminDriverPluginItem[] = [];
  const seen = new Set<string>();

  for (const entry of input.drivers.listEntries()) {
    const id = entry.driver.manifest.id;
    seen.add(id);
    const meta = entry.source === "upload" ? uploadedById.get(id) : undefined;
    items.push({
      id,
      label: entry.driver.manifest.label,
      source: entry.source,
      builtin: entry.builtin,
      enabled: true,
      loaded: true,
      version: meta?.version ?? null,
      fileName: meta?.fileName ?? null,
      sha256: meta?.sha256 ?? null,
      sizeBytes: meta?.sizeBytes ?? null,
      defaultPort: entry.driver.manifest.defaultPort ?? null,
      supportsSsl: entry.driver.manifest.supportsSsl,
      capabilities: entry.driver.manifest.capabilities,
      optionsSchema: entry.driver.manifest.optionsSchema,
      datasourceCount: counts.get(id) ?? 0,
      uploadedAt: meta?.createdAt ?? null,
      updatedAt: meta?.updatedAt ?? null,
    });
  }

  for (const row of uploadedRows) {
    if (seen.has(row.driverId)) continue;
    items.push({
      id: row.driverId,
      label: row.label,
      source: "upload",
      builtin: false,
      enabled: row.enabled === 1,
      loaded: false,
      version: row.version,
      fileName: row.fileName,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      defaultPort: null,
      supportsSsl: true,
      capabilities: null,
      optionsSchema: [],
      datasourceCount: counts.get(row.driverId) ?? 0,
      uploadedAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return {
    allowUpload: input.config.allowPluginUpload !== false,
    drivers: items,
  };
}

/**
 * Loads all enabled admin-uploaded plugins from SQLite + `DATA_DIR/plugins/datasources`
 * during server startup. Env-configured and built-in drivers take precedence.
 */
export async function loadPersistedDatasourcePlugins(input: {
  db: Db;
  config: Pick<AppConfig, "dataDir">;
  drivers: DriverRegistry;
  log?: (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}): Promise<{ loaded: string[]; failed: Array<{ driverId: string; reason: string }> }> {
  const rootDir = pluginsRootDir(input.config);
  const rows = input.db
    .select()
    .from(datasourcePlugins)
    .where(eq(datasourcePlugins.enabled, 1))
    .orderBy(asc(datasourcePlugins.createdAt))
    .all();

  const loaded: string[] = [];
  const failed: Array<{ driverId: string; reason: string }> = [];

  for (const row of rows) {
    if (input.drivers.has(row.driverId)) {
      input.log?.("warn", "Skipping uploaded datasource plugin shadowed by built-in or env driver", {
        driverId: row.driverId,
      });
      continue;
    }
    try {
      const absEntry = resolvePersistedEntry(rootDir, row.entryPath);
      if (!fs.existsSync(absEntry)) {
        throw new Error(`插件入口文件缺失：${row.entryPath}`);
      }
      const driver = await loadValidatedSingleDriver(absEntry);
      if (driver.manifest.id !== row.driverId) {
        throw new Error(
          `插件 id 不一致（记录为 ${row.driverId}，实际导出 ${driver.manifest.id}）`,
        );
      }
      input.drivers.register(driver, { builtin: false, source: "upload" });
      loaded.push(row.driverId);
      input.log?.("info", "Loaded persisted datasource plugin", {
        driverId: row.driverId,
        version: row.version,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ driverId: row.driverId, reason });
      input.log?.("error", "Failed to load persisted datasource plugin", {
        driverId: row.driverId,
        reason,
      });
    }
  }

  return { loaded, failed };
}

/**
 * Validates, extracts, persists, and hot-registers an uploaded offline datasource
 * driver plugin (`.mjs`, `.zip`, `.tgz`, `.tar.gz`).
 */
export async function uploadDatasourcePlugin(input: {
  db: Db;
  config: AppConfig;
  drivers: DriverRegistry;
  pools: PoolRegistry;
  buffer: Buffer;
  fileName: string;
  replace: boolean;
  uploadedBy: string;
}): Promise<{ plugin: AdminDriverPluginItem; replaced: boolean }> {
  if (input.config.allowPluginUpload === false) {
    throw new DatasourcePluginError(
      "PLUGIN_UPLOAD_DISABLED",
      "服务端已通过 ALLOW_PLUGIN_UPLOAD=false 禁止在界面上传插件",
      403,
    );
  }

  const rootDir = pluginsRootDir(input.config);
  fs.mkdirSync(rootDir, { recursive: true });
  const stagingDir = path.join(rootDir, `.staging-${randomUUID()}`);

  try {
    let extracted;
    try {
      extracted = extractPluginBundle(input.buffer, input.fileName, stagingDir);
    } catch (err) {
      if (err instanceof PluginArchiveError) {
        throw new DatasourcePluginError(err.code, err.message, 400);
      }
      throw err;
    }

    const driver = await loadValidatedSingleDriver(extracted.entryAbsolutePath);
    const driverId = driver.manifest.id;
    const existingSource = input.drivers.getSource(driverId);
    if (existingSource === "builtin" || existingSource === "env") {
      throw new DatasourcePluginError(
        "PLUGIN_ID_CONFLICT",
        `驱动「${driverId}」已由${existingSource === "builtin" ? "内置驱动" : "环境变量 DATASOURCE_PLUGINS"}提供，不能覆盖`,
        409,
      );
    }

    const existingRow = input.db
      .select()
      .from(datasourcePlugins)
      .where(eq(datasourcePlugins.driverId, driverId))
      .get();

    if (existingRow && !input.replace) {
      throw new DatasourcePluginError(
        "PLUGIN_ALREADY_EXISTS",
        `驱动「${driver.manifest.label}」（${driverId}）已存在，确认覆盖升级后重试`,
        409,
        { driverId, existingVersion: existingRow.version, newVersion: extracted.version },
      );
    }

    const sha256 = createHash("sha256").update(input.buffer).digest("hex");
    const releaseSlug = `${sha256.slice(0, 12)}-${Date.now().toString(36)}`;
    const driverRoot = path.join(rootDir, driverId);
    const finalDir = path.join(driverRoot, releaseSlug);
    fs.mkdirSync(driverRoot, { recursive: true });
    fs.renameSync(stagingDir, finalDir);

    const finalEntryAbs = path.join(finalDir, extracted.entryRelativePath);
    const finalEntryRel = path.relative(rootDir, finalEntryAbs).replace(/\\/g, "/");

    // Re-import from the final unique path so Node ESM caches the permanent location.
    const liveDriver = await loadValidatedSingleDriver(finalEntryAbs);
    input.drivers.register(liveDriver, {
      builtin: false,
      source: "upload",
      replaceUploaded: true,
    });
    await input.pools.evictByDriver(driverId);

    const now = Date.now();
    if (existingRow) {
      input.db
        .update(datasourcePlugins)
        .set({
          label: liveDriver.manifest.label,
          version: extracted.version,
          fileName: path.basename(input.fileName).slice(0, 160),
          entryPath: finalEntryRel,
          sha256,
          sizeBytes: input.buffer.length,
          enabled: 1,
          uploadedBy: input.uploadedBy,
          updatedAt: now,
        })
        .where(eq(datasourcePlugins.driverId, driverId))
        .run();

      // Clean up superseded release folder(s) best-effort.
      try {
        const oldReleaseDir = path.dirname(resolvePersistedEntry(rootDir, existingRow.entryPath));
        if (oldReleaseDir !== finalDir && oldReleaseDir.startsWith(driverRoot)) {
          fs.rmSync(oldReleaseDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore best-effort cleanup failure.
      }
    } else {
      input.db
        .insert(datasourcePlugins)
        .values({
          driverId,
          label: liveDriver.manifest.label,
          version: extracted.version,
          fileName: path.basename(input.fileName).slice(0, 160),
          entryPath: finalEntryRel,
          sha256,
          sizeBytes: input.buffer.length,
          enabled: 1,
          uploadedBy: input.uploadedBy,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const list = listAdminDatasourcePlugins({
      db: input.db,
      config: input.config,
      drivers: input.drivers,
    });
    const plugin = list.drivers.find((d) => d.id === driverId)!;
    return { plugin, replaced: Boolean(existingRow) };
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

/** Hot-enables or hot-disables an admin-uploaded datasource plugin. */
export async function setDatasourcePluginEnabled(input: {
  db: Db;
  config: AppConfig;
  drivers: DriverRegistry;
  pools: PoolRegistry;
  driverId: string;
  enabled: boolean;
}): Promise<AdminDriverPluginItem> {
  const row = input.db
    .select()
    .from(datasourcePlugins)
    .where(eq(datasourcePlugins.driverId, input.driverId))
    .get();
  if (!row) {
    throw new DatasourcePluginError("NOT_FOUND", "未找到该上传的数据源插件", 404);
  }

  const currentSource = input.drivers.getSource(input.driverId);
  if (currentSource === "builtin" || currentSource === "env") {
    throw new DatasourcePluginError("FORBIDDEN", "内置或环境变量加载的驱动不可在界面启停", 400);
  }

  if (input.enabled) {
    const absEntry = resolvePersistedEntry(pluginsRootDir(input.config), row.entryPath);
    if (!fs.existsSync(absEntry)) {
      throw new DatasourcePluginError("PLUGIN_MISSING", "插件文件已丢失，请重新上传", 400);
    }
    const driver = await loadValidatedSingleDriver(absEntry);
    input.drivers.register(driver, { builtin: false, source: "upload", replaceUploaded: true });
  } else {
    input.drivers.unregisterUploaded(input.driverId);
    await input.pools.evictByDriver(input.driverId);
  }

  input.db
    .update(datasourcePlugins)
    .set({ enabled: input.enabled ? 1 : 0, updatedAt: Date.now() })
    .where(eq(datasourcePlugins.driverId, input.driverId))
    .run();

  const list = listAdminDatasourcePlugins({
    db: input.db,
    config: input.config,
    drivers: input.drivers,
  });
  return list.drivers.find((d) => d.id === input.driverId)!;
}

/** Uninstalls an admin-uploaded datasource plugin, evicting pools and removing files. */
export async function deleteDatasourcePlugin(input: {
  db: Db;
  config: AppConfig;
  drivers: DriverRegistry;
  pools: PoolRegistry;
  driverId: string;
}): Promise<{ ok: true }> {
  const row = input.db
    .select()
    .from(datasourcePlugins)
    .where(eq(datasourcePlugins.driverId, input.driverId))
    .get();
  if (!row) {
    throw new DatasourcePluginError("NOT_FOUND", "未找到该上传的数据源插件", 404);
  }

  input.drivers.unregisterUploaded(input.driverId);
  await input.pools.evictByDriver(input.driverId);
  input.db
    .delete(datasourcePlugins)
    .where(eq(datasourcePlugins.driverId, input.driverId))
    .run();

  const driverRoot = path.join(pluginsRootDir(input.config), input.driverId);
  fs.rmSync(driverRoot, { recursive: true, force: true });
  return { ok: true };
}
