import { createContext, useContext } from "react";

export interface AppBranding {
  title: string;
  subtitle: string;
  iconUrl: string;
  faviconUrl: string;
}

export const DEFAULT_BRANDING: AppBranding = {
  title: "DataChat",
  subtitle: "数据工作台",
  iconUrl: "/logo.svg",
  faviconUrl: "/favicon.svg",
};

const STORAGE_KEY = "datachat.branding";

export function isSafeAssetUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeBranding(raw: unknown): AppBranding {
  if (!raw || typeof raw !== "object") return DEFAULT_BRANDING;
  const record = raw as Record<string, unknown>;
  const title =
    typeof record.title === "string" && record.title.trim()
      ? record.title.trim()
      : DEFAULT_BRANDING.title;
  const subtitle =
    typeof record.subtitle === "string" && record.subtitle.trim()
      ? record.subtitle.trim()
      : DEFAULT_BRANDING.subtitle;
  const iconUrl = isSafeAssetUrl(record.iconUrl)
    ? record.iconUrl.trim()
    : DEFAULT_BRANDING.iconUrl;
  const faviconUrl = isSafeAssetUrl(record.faviconUrl)
    ? record.faviconUrl.trim()
    : DEFAULT_BRANDING.faviconUrl;
  return { title, subtitle, iconUrl, faviconUrl };
}

export function readCachedBranding(): AppBranding | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeBranding(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeCachedBranding(branding: AppBranding): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(branding));
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

export function applyDocumentBranding(branding: AppBranding): void {
  if (typeof document === "undefined") return;
  document.title = branding.title;

  const updateLink = (rel: string, href: string) => {
    let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
    if (!link) {
      link = document.createElement("link");
      link.rel = rel;
      document.head.appendChild(link);
    }
    link.href = href;
    if (rel === "icon") {
      if (href.toLowerCase().split("?")[0]?.endsWith(".svg")) {
        link.type = "image/svg+xml";
      } else {
        link.removeAttribute("type");
      }
    }
  };

  updateLink("icon", branding.faviconUrl);
  updateLink("apple-touch-icon", branding.iconUrl);
}

export const BrandingContext = createContext<AppBranding>(DEFAULT_BRANDING);

export function useBranding(): AppBranding {
  return useContext(BrandingContext);
}
