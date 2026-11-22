import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const PLUGIN_MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
export const PLUGIN_MAX_EXTRACTED_BYTES = 60 * 1024 * 1024; // 60 MB
export const PLUGIN_MAX_FILES = 500;

export class PluginArchiveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginArchiveError";
    this.code = code;
  }
}

export interface ExtractedPluginBundle {
  /** Entry file path relative to `destDir` using POSIX slashes. */
  entryRelativePath: string;
  /** Absolute path to the entry module file. */
  entryAbsolutePath: string;
  /** Package version from `package.json` if present, otherwise `"1.0.0"`. */
  version: string;
}

interface ArchiveEntry {
  name: string;
  data: Buffer;
}

function normalizeArchiveEntryPath(rawName: string): string | null {
  const unified = rawName.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!unified || unified.endsWith("/")) return null;
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified) || unified.includes("\0")) {
    throw new PluginArchiveError("INVALID_ARCHIVE", `插件包包含非法路径：${rawName}`);
  }
  const normalized = path.posix.normalize(unified);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new PluginArchiveError("INVALID_ARCHIVE", `插件包包含路径穿越条目：${rawName}`);
  }
  return normalized;
}

function extractTarEntries(tarBuf: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let totalBytes = 0;
  let paxPath: string | null = null;
  let gnuLongName: string | null = null;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark end-of-archive.
    if (header.every((byte) => byte === 0)) break;

    const rawName = readTarString(header, 0, 100);
    const sizeOctal = readTarString(header, 124, 12).trim();
    const typeFlag = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const prefix = readTarString(header, 345, 155);
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new PluginArchiveError("INVALID_ARCHIVE", "无效的 tar 压缩包（文件大小字段损坏）");
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuf.length) {
      throw new PluginArchiveError("INVALID_ARCHIVE", "tar 压缩包内容不完整或已截断");
    }
    const content = tarBuf.subarray(dataStart, dataEnd);
    const blocks = Math.ceil(size / 512);
    offset = dataStart + blocks * 512;

    if (typeFlag === "x") {
      paxPath = parsePaxPath(content.toString("utf8")) ?? paxPath;
      continue;
    }
    if (typeFlag === "L") {
      gnuLongName = content.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (typeFlag === "g" || typeFlag === "5") {
      paxPath = null;
      gnuLongName = null;
      continue;
    }
    if (typeFlag === "1" || typeFlag === "2") {
      throw new PluginArchiveError("INVALID_ARCHIVE", "插件包不允许包含符号链接或硬链接");
    }
    if (typeFlag !== "0") {
      paxPath = null;
      gnuLongName = null;
      continue;
    }

    const fullName =
      paxPath ?? gnuLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    paxPath = null;
    gnuLongName = null;

    const normalized = normalizeArchiveEntryPath(fullName);
    if (!normalized) continue;

    entries.push({ name: normalized, data: Buffer.from(content) });
    if (entries.length > PLUGIN_MAX_FILES) {
      throw new PluginArchiveError(
        "ARCHIVE_TOO_LARGE",
        `插件包文件数量超过上限（最多 ${PLUGIN_MAX_FILES} 个文件）`,
      );
    }
    totalBytes += size;
    if (totalBytes > PLUGIN_MAX_EXTRACTED_BYTES) {
      throw new PluginArchiveError("ARCHIVE_TOO_LARGE", "插件包解压后体积超过 60 MB 上限");
    }
  }

  return entries;
}

function readTarString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const zeroIdx = slice.indexOf(0);
  return slice.subarray(0, zeroIdx === -1 ? len : zeroIdx).toString("utf8");
}

function parsePaxPath(text: string): string | null {
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const kv = line.slice(space + 1);
    if (kv.startsWith("path=")) return kv.slice(5);
  }
  return null;
}

function extractZipEntries(zipBuf: Buffer): ArchiveEntry[] {
  // Locate End of Central Directory (signature 0x06054b50) scanning backwards from the tail.
  const minEocd = 22;
  if (zipBuf.length < minEocd) {
    throw new PluginArchiveError("INVALID_ARCHIVE", "无效的 ZIP 文件");
  }
  const searchStart = Math.max(0, zipBuf.length - 65557);
  let eocdOffset = -1;
  for (let i = zipBuf.length - minEocd; i >= searchStart; i -= 1) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new PluginArchiveError("INVALID_ARCHIVE", "无效的 ZIP 文件（未找到中央目录）");
  }

  const entryCount = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  if (entryCount > PLUGIN_MAX_FILES * 2) {
    throw new PluginArchiveError(
      "ARCHIVE_TOO_LARGE",
      `插件包文件数量超过上限（最多 ${PLUGIN_MAX_FILES} 个文件）`,
    );
  }

  const entries: ArchiveEntry[] = [];
  let cursor = centralDirOffset;
  let totalBytes = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > zipBuf.length || zipBuf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new PluginArchiveError("INVALID_ARCHIVE", "ZIP 中央目录损坏");
    }
    const compressionMethod = zipBuf.readUInt16LE(cursor + 10);
    const compressedSize = zipBuf.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuf.readUInt32LE(cursor + 24);
    const nameLen = zipBuf.readUInt16LE(cursor + 28);
    const extraLen = zipBuf.readUInt16LE(cursor + 30);
    const commentLen = zipBuf.readUInt16LE(cursor + 32);
    const externalAttr = zipBuf.readUInt32LE(cursor + 38);
    const localHeaderOffset = zipBuf.readUInt32LE(cursor + 42);
    const rawName = zipBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;

    // Detect Unix symlink in external attributes (S_IFLNK = 0o120000).
    const unixMode = (externalAttr >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      throw new PluginArchiveError("INVALID_ARCHIVE", "插件包不允许包含符号链接");
    }

    const normalized = normalizeArchiveEntryPath(rawName);
    if (!normalized) continue;

    if (
      localHeaderOffset + 30 > zipBuf.length ||
      zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      throw new PluginArchiveError("INVALID_ARCHIVE", `ZIP 条目损坏：${rawName}`);
    }
    const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuf.length) {
      throw new PluginArchiveError("INVALID_ARCHIVE", `ZIP 条目截断：${rawName}`);
    }
    if (totalBytes + uncompressedSize > PLUGIN_MAX_EXTRACTED_BYTES) {
      throw new PluginArchiveError("ARCHIVE_TOO_LARGE", "插件包解压后体积超过 60 MB 上限");
    }

    const compressed = zipBuf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (compressionMethod === 0) {
      data = Buffer.from(compressed);
    } else if (compressionMethod === 8) {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: PLUGIN_MAX_EXTRACTED_BYTES });
      } catch {
        throw new PluginArchiveError("INVALID_ARCHIVE", `ZIP 条目解压失败：${rawName}`);
      }
    } else {
      throw new PluginArchiveError(
        "INVALID_ARCHIVE",
        `不支持的 ZIP 压缩方式（method=${compressionMethod}），请使用标准 Deflate/Store 压缩`,
      );
    }

    totalBytes += data.length;
    if (totalBytes > PLUGIN_MAX_EXTRACTED_BYTES) {
      throw new PluginArchiveError("ARCHIVE_TOO_LARGE", "插件包解压后体积超过 60 MB 上限");
    }

    entries.push({ name: normalized, data });
    if (entries.length > PLUGIN_MAX_FILES) {
      throw new PluginArchiveError(
        "ARCHIVE_TOO_LARGE",
        `插件包文件数量超过上限（最多 ${PLUGIN_MAX_FILES} 个文件）`,
      );
    }
  }

  return entries;
}

function stripCommonRootDir(entries: ArchiveEntry[]): ArchiveEntry[] {
  if (entries.length === 0) return entries;
  const firstSlash = entries[0]!.name.indexOf("/");
  if (firstSlash <= 0) return entries;
  const prefix = entries[0]!.name.slice(0, firstSlash + 1);
  if (entries.every((e) => e.name.startsWith(prefix) && e.name.length > prefix.length)) {
    return entries.map((e) => ({ ...e, name: e.name.slice(prefix.length) }));
  }
  return entries;
}

function resolvePackageEntry(pkg: Record<string, unknown>): string | null {
  if (typeof pkg.exports === "string") return pkg.exports;
  if (pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports)) {
    const dot = (pkg.exports as Record<string, unknown>)["."];
    if (typeof dot === "string") return dot;
    if (dot && typeof dot === "object" && !Array.isArray(dot)) {
      const obj = dot as Record<string, unknown>;
      if (typeof obj.import === "string") return obj.import;
      if (typeof obj.default === "string") return obj.default;
    }
  }
  if (typeof pkg.main === "string" && pkg.main.trim()) return pkg.main.trim();
  return null;
}

function ensureInside(rootDir: string, targetPath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PluginArchiveError("INVALID_ARCHIVE", "插件入口路径超出了插件根目录");
  }
  return resolvedTarget;
}

/**
 * Extracts an uploaded `.mjs`, `.zip`, `.tgz`, or `.tar.gz` plugin bundle safely
 * into `destDir` and resolves its ESM entry module path.
 */
export function extractPluginBundle(
  buffer: Buffer,
  fileName: string,
  destDir: string,
): ExtractedPluginBundle {
  if (buffer.length === 0) {
    throw new PluginArchiveError("INVALID_ARCHIVE", "上传的文件为空");
  }
  if (buffer.length > PLUGIN_MAX_UPLOAD_BYTES) {
    throw new PluginArchiveError("ARCHIVE_TOO_LARGE", "插件包大小不能超过 20 MB");
  }

  const lower = fileName.trim().toLowerCase();
  fs.mkdirSync(destDir, { recursive: true });

  if (lower.endsWith(".mjs")) {
    const absEntry = path.join(destDir, "index.mjs");
    fs.writeFileSync(absEntry, buffer);
    return {
      entryRelativePath: "index.mjs",
      entryAbsolutePath: absEntry,
      version: "1.0.0",
    };
  }

  let rawEntries: ArchiveEntry[];
  if (lower.endsWith(".zip")) {
    rawEntries = extractZipEntries(buffer);
  } else if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) {
    let tarBuf: Buffer;
    try {
      tarBuf = zlib.gunzipSync(buffer, { maxOutputLength: PLUGIN_MAX_EXTRACTED_BYTES });
    } catch {
      throw new PluginArchiveError("INVALID_ARCHIVE", "无法解压 .tgz / .tar.gz 文件（gzip 损坏或超限）");
    }
    rawEntries = extractTarEntries(tarBuf);
  } else {
    throw new PluginArchiveError(
      "UNSUPPORTED_FORMAT",
      "仅支持上传 .mjs、.zip、.tgz 或 .tar.gz 格式的数据源插件包",
    );
  }

  const entries = stripCommonRootDir(rawEntries);
  if (entries.length === 0) {
    throw new PluginArchiveError("INVALID_ARCHIVE", "插件压缩包不包含任何有效文件");
  }

  for (const entry of entries) {
    const target = ensureInside(destDir, path.join(destDir, entry.name));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }

  let version = "1.0.0";
  let declaredEntry: string | null = null;
  const pkgPath = path.join(destDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      if (typeof pkg.version === "string" && pkg.version.trim()) {
        version = pkg.version.trim().slice(0, 64);
      }
      declaredEntry = resolvePackageEntry(pkg);
    } catch {
      throw new PluginArchiveError("INVALID_ARCHIVE", "插件包中的 package.json 格式无效");
    }
  }

  const candidates = [declaredEntry, "index.mjs", "index.js"].filter(
    (item): item is string => Boolean(item),
  );
  for (const candidate of candidates) {
    const cleanRel = candidate.replace(/^\.\//, "").replace(/\\/g, "/");
    const abs = ensureInside(destDir, path.join(destDir, cleanRel));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return {
        entryRelativePath: path.relative(destDir, abs).replace(/\\/g, "/"),
        entryAbsolutePath: abs,
        version,
      };
    }
  }

  throw new PluginArchiveError(
    "INVALID_ARCHIVE",
    "未在插件包中找到入口文件（请在 package.json 中声明 main/exports，或提供根目录 index.mjs）",
  );
}
