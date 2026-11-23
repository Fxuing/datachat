import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";

export const DEFAULT_BRAND_TITLE = "DataChat";
export const DEFAULT_BRAND_SUBTITLE = "数据工作台";
export const DEFAULT_BRAND_ICON = "/logo.svg";
export const DEFAULT_BRAND_FAVICON = "/favicon.svg";

const MAX_BRAND_ICON_BYTES = 5 * 1024 * 1024;

const ICON_MIME_BY_EXT: Record<string, string> = {
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".gif": "image/gif",
};

interface ResolvedAsset {
  url: string;
  filePath: string | null;
  mimeType: string | null;
  isSvg: boolean;
}

export interface BrandingRouteOptions {
  config: AppConfig;
}

function tryResolveLocalIcon(rawValue: string, dataDir: string): {
  filePath: string;
  mimeType: string;
  version: string;
  isSvg: boolean;
} | null {
  const candidates = path.isAbsolute(rawValue)
    ? [rawValue]
    : [path.resolve(dataDir, rawValue), path.resolve(process.cwd(), rawValue)];

  for (const candidate of candidates) {
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BRAND_ICON_BYTES) {
      continue;
    }
    const ext = path.extname(candidate).toLowerCase();
    const mimeType = ICON_MIME_BY_EXT[ext];
    if (!mimeType) continue;
    return {
      filePath: candidate,
      mimeType,
      version: `${Math.floor(stat.mtimeMs)}-${stat.size}`,
      isSvg: ext === ".svg",
    };
  }
  return null;
}

function resolveBrandAsset(
  rawValue: string | undefined,
  endpoint: string,
  fallbackUrl: string,
  dataDir: string,
): ResolvedAsset {
  const trimmed = rawValue?.trim();
  if (!trimmed) {
    return { url: fallbackUrl, filePath: null, mimeType: null, isSvg: false };
  }

  // 1. Explicit http(s) URL
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return { url: parsed.toString(), filePath: null, mimeType: null, isSvg: false };
      }
    } catch {
      return { url: fallbackUrl, filePath: null, mimeType: null, isSvg: false };
    }
  }

  // 2. Local / container-mounted image file served safely through the API
  const local = tryResolveLocalIcon(trimmed, dataDir);
  if (local) {
    return {
      url: `${endpoint}?v=${local.version}`,
      filePath: local.filePath,
      mimeType: local.mimeType,
      isSvg: local.isSvg,
    };
  }

  // 3. Web-relative image path served by nginx / frontend public dir (reject // or ..)
  if (
    trimmed.startsWith("/") &&
    !trimmed.startsWith("//") &&
    !trimmed.includes("..") &&
    !/[\r\n]/.test(trimmed)
  ) {
    const cleanPath = trimmed.split(/[?#]/, 1)[0] ?? "";
    const ext = path.extname(cleanPath).toLowerCase();
    if (ext && ICON_MIME_BY_EXT[ext]) {
      return { url: trimmed, filePath: null, mimeType: null, isSvg: false };
    }
  }

  return { url: fallbackUrl, filePath: null, mimeType: null, isSvg: false };
}

export async function brandingRoutes(
  app: FastifyInstance,
  opts: BrandingRouteOptions,
): Promise<void> {
  const title = opts.config.appTitle?.trim() || DEFAULT_BRAND_TITLE;
  const subtitle = opts.config.appSubtitle?.trim() || DEFAULT_BRAND_SUBTITLE;

  const resolveCurrent = () => {
    const icon = resolveBrandAsset(
      opts.config.appIcon,
      "/api/public/branding/icon",
      DEFAULT_BRAND_ICON,
      opts.config.dataDir,
    );
    const faviconFallback = icon.url !== DEFAULT_BRAND_ICON ? icon.url : DEFAULT_BRAND_FAVICON;
    const favicon = resolveBrandAsset(
      opts.config.appFavicon,
      "/api/public/branding/favicon",
      faviconFallback,
      opts.config.dataDir,
    );
    return { icon, favicon };
  };

  app.get("/api/public/branding", async (_request, reply) => {
    const { icon, favicon } = resolveCurrent();
    reply.header("Cache-Control", "no-cache");
    return {
      title,
      subtitle,
      iconUrl: icon.url,
      faviconUrl: favicon.url,
    };
  });

  const serveLocalAsset = async (
    asset: ResolvedAsset,
    reply: import("fastify").FastifyReply,
  ) => {
    if (!asset.filePath || !asset.mimeType) {
      return reply
        .code(404)
        .send({ error: { code: "NOT_FOUND", message: "未配置本地品牌图标" } });
    }
    try {
      const bytes = await readFile(asset.filePath);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_BRAND_ICON_BYTES) {
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: "品牌图标不可用" } });
      }
      reply.header("Content-Type", asset.mimeType);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", "public, max-age=300");
      if (asset.isSvg) {
        reply.header(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        );
      }
      return reply.send(bytes);
    } catch {
      return reply
        .code(404)
        .send({ error: { code: "NOT_FOUND", message: "品牌图标文件不存在" } });
    }
  };

  app.get("/api/public/branding/icon", async (_request, reply) => {
    return serveLocalAsset(resolveCurrent().icon, reply);
  });

  app.get("/api/public/branding/favicon", async (_request, reply) => {
    return serveLocalAsset(resolveCurrent().favicon, reply);
  });
}
