import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateDatasourceDriver,
  type DatasourceDriver,
  type PublicDriverDescriptor,
} from "@datachat/datasource-sdk";
import { mysqlDriver } from "./mysql.js";
import { postgresDriver } from "./postgres.js";

export type DriverSource = "builtin" | "env" | "upload";

export interface RegisteredDriverEntry {
  driver: DatasourceDriver;
  source: DriverSource;
  builtin: boolean;
}

export interface LoadPluginsOptions {
  /** Fail startup if any configured plugin fails to load or validate. */
  strict?: boolean;
  /** Working directory for resolving relative plugin file paths. */
  baseDir?: string;
  log?: (level: "info" | "warn" | "error", message: string, detail?: Record<string, unknown>) => void;
}

export function resolveImportSpecifier(specifier: string, baseDir: string): string {
  const trimmed = specifier.trim();
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    path.isAbsolute(trimmed) ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  ) {
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
    return pathToFileURL(resolved).href;
  }
  return trimmed;
}

export function extractExportedDrivers(mod: Record<string, unknown>): unknown[] {
  if (Array.isArray(mod.drivers)) return mod.drivers;
  if (mod.driver !== undefined) return [mod.driver];
  if (mod.default !== undefined) {
    return Array.isArray(mod.default) ? mod.default : [mod.default];
  }
  return [];
}

/**
 * Dynamically imports an ESM driver module by package name or file path and extracts
 * its exported driver candidate(s).
 */
export async function importDriverModule(
  specifier: string,
  baseDir: string = process.cwd(),
): Promise<unknown[]> {
  const target = resolveImportSpecifier(specifier, baseDir);
  const mod = (await import(/* @vite-ignore */ target)) as Record<string, unknown>;
  const candidates = extractExportedDrivers(mod);
  if (candidates.length === 0) {
    throw new Error("插件模块未导出 default / driver / drivers");
  }
  return candidates;
}

/**
 * Central registry of built-in, env-configured, and admin-uploaded datasource
 * driver plugins. Built-in drivers (MySQL, PostgreSQL) are always registered first
 * and cannot be overridden by external or uploaded plugins.
 */
export class DriverRegistry {
  private readonly entries = new Map<string, RegisteredDriverEntry>();

  constructor(options?: { includeBuiltins?: boolean }) {
    if (options?.includeBuiltins !== false) {
      this.register(mysqlDriver, { builtin: true, source: "builtin" });
      this.register(postgresDriver, { builtin: true, source: "builtin" });
    }
  }

  register(
    candidate: unknown,
    opts: { builtin?: boolean; source?: DriverSource; replaceUploaded?: boolean } = {},
  ): DatasourceDriver {
    const validated = validateDatasourceDriver(candidate);
    if (!validated.ok) {
      throw new Error(`驱动校验失败：${validated.reason}`);
    }
    const { driver } = validated;
    const source: DriverSource = opts.source ?? (opts.builtin ? "builtin" : "env");
    const existing = this.entries.get(driver.manifest.id);
    if (existing) {
      const canReplace =
        opts.replaceUploaded === true && source === "upload" && existing.source === "upload";
      if (!canReplace) {
        throw new Error(`数据源驱动 id 冲突：${driver.manifest.id} 已存在`);
      }
    }
    this.entries.set(driver.manifest.id, {
      driver,
      source,
      builtin: source === "builtin",
    });
    return driver;
  }

  /** Removes a dynamically uploaded driver; built-in and env drivers cannot be unregistered. */
  unregisterUploaded(id: string): boolean {
    const existing = this.entries.get(id);
    if (!existing || existing.source !== "upload") return false;
    this.entries.delete(id);
    return true;
  }

  get(id: string): DatasourceDriver | undefined {
    return this.entries.get(id)?.driver;
  }

  getSource(id: string): DriverSource | undefined {
    return this.entries.get(id)?.source;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  listEntries(): RegisteredDriverEntry[] {
    return [...this.entries.values()];
  }

  listPublic(): PublicDriverDescriptor[] {
    return [...this.entries.values()].map(({ driver, builtin }) => ({
      ...driver.manifest,
      builtin,
    }));
  }

  async loadExternalPlugins(
    specifiers: string[],
    options: LoadPluginsOptions = {},
  ): Promise<{ loaded: string[]; failed: Array<{ specifier: string; reason: string }> }> {
    const loaded: string[] = [];
    const failed: Array<{ specifier: string; reason: string }> = [];
    const baseDir = options.baseDir ?? process.cwd();
    const log = options.log;

    for (const rawSpecifier of specifiers) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;
      try {
        const candidates = await importDriverModule(specifier, baseDir);
        for (const candidate of candidates) {
          const registered = this.register(candidate, { builtin: false, source: "env" });
          loaded.push(registered.manifest.id);
          log?.("info", "Loaded datasource driver plugin", {
            specifier,
            driverId: registered.manifest.id,
            label: registered.manifest.label,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failed.push({ specifier, reason });
        log?.("error", "Failed to load datasource driver plugin", { specifier, reason });
        if (options.strict) {
          throw new Error(`加载数据源驱动插件「${specifier}」失败：${reason}`);
        }
      }
    }

    return { loaded, failed };
  }
}

export const defaultDriverRegistry = new DriverRegistry();
