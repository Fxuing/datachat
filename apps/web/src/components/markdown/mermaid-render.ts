import { cacheKeyFor, readCachedSvg, writeCachedSvg } from "./mermaid-cache";

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
}

interface MermaidPalette {
  surface: string;
  subtle: string;
  ink: string;
  line: string;
  lineStrong: string;
  muted: string;
  brandSoft: string;
}

const LIGHT_PALETTE: MermaidPalette = {
  surface: "rgb(255, 255, 255)",
  subtle: "rgb(244, 244, 245)",
  ink: "rgb(24, 24, 27)",
  line: "rgb(228, 228, 231)",
  lineStrong: "rgb(212, 212, 216)",
  muted: "rgb(113, 113, 122)",
  brandSoft: "rgb(238, 242, 255)",
};

const DARK_PALETTE_FALLBACK: MermaidPalette = {
  surface: "rgb(18, 18, 22)",
  subtle: "rgb(27, 27, 33)",
  ink: "rgb(245, 245, 246)",
  line: "rgb(42, 42, 50)",
  lineStrong: "rgb(68, 68, 78)",
  muted: "rgb(158, 158, 168)",
  brandSoft: "rgb(30, 27, 75)",
};

let configuredFor: boolean | null = null;
let exportSequence = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

function cssColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const raw = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Tokens are stored as "24 24 27" triples so Tailwind can add alpha.
  return raw ? `rgb(${raw.split(/\s+/).join(", ")})` : fallback;
}

function paletteFor(dark: boolean): MermaidPalette {
  if (!dark) {
    return LIGHT_PALETTE;
  }
  return {
    surface: cssColor("--surface", DARK_PALETTE_FALLBACK.surface),
    subtle: cssColor("--subtle", DARK_PALETTE_FALLBACK.subtle),
    ink: cssColor("--ink", DARK_PALETTE_FALLBACK.ink),
    line: cssColor("--line", DARK_PALETTE_FALLBACK.line),
    lineStrong: cssColor("--line-strong", DARK_PALETTE_FALLBACK.lineStrong),
    muted: cssColor("--muted", DARK_PALETTE_FALLBACK.muted),
    brandSoft: cssColor("--brand-soft", DARK_PALETTE_FALLBACK.brandSoft),
  };
}

/** Map the app's design tokens onto mermaid's theme variables for light or dark theme. */
export function themeVariablesFor(dark: boolean): Record<string, string | boolean> {
  const palette = paletteFor(dark);
  const fontFamily =
    typeof window !== "undefined"
      ? window.getComputedStyle(document.body).fontFamily || "sans-serif"
      : "sans-serif";

  return {
    darkMode: dark,
    fontFamily,
    fontSize: "13px",
    background: palette.surface,
    mainBkg: palette.brandSoft,
    primaryColor: palette.brandSoft,
    primaryTextColor: palette.ink,
    primaryBorderColor: palette.lineStrong,
    secondaryColor: palette.subtle,
    secondaryTextColor: palette.ink,
    secondaryBorderColor: palette.line,
    tertiaryColor: palette.surface,
    tertiaryTextColor: palette.ink,
    tertiaryBorderColor: palette.line,
    lineColor: palette.lineStrong,
    textColor: palette.ink,
    nodeBorder: palette.lineStrong,
    nodeTextColor: palette.ink,
    clusterBkg: palette.subtle,
    clusterBorder: palette.line,
    edgeLabelBackground: palette.surface,
    titleColor: palette.ink,
    // sequence diagrams
    actorBkg: palette.brandSoft,
    actorBorder: palette.lineStrong,
    actorTextColor: palette.ink,
    signalColor: palette.muted,
    signalTextColor: palette.ink,
    labelBoxBkgColor: palette.brandSoft,
    labelBoxBorderColor: palette.line,
    labelTextColor: palette.ink,
    noteBkgColor: palette.subtle,
    noteBorderColor: palette.line,
    noteTextColor: palette.ink,
  };
}

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const next = renderQueue.then(task, task);
  renderQueue = next.catch(() => undefined);
  return next;
}

/**
 * Render a Mermaid source into SVG for the requested theme (`dark` vs `light`).
 * Mermaid is dynamically imported on demand (~1 MB) and calls are serialized
 * because mermaid holds global singleton config across renders.
 */
export async function renderMermaidSvg(
  source: string,
  options: { dark: boolean; id?: string },
): Promise<string> {
  const key = cacheKeyFor(options.dark, source);
  const cached = readCachedSvg(key);
  if (cached) return cached;

  return await enqueueRender(async () => {
    const cachedInQueue = readCachedSvg(key);
    if (cachedInQueue) return cachedInQueue;

    const { default: mermaid } = (await import("mermaid")) as { default: MermaidApi };
    if (configuredFor !== options.dark) {
      mermaid.initialize({
        startOnLoad: false,
        // Sanitise labels, no click handlers or raw HTML from model output.
        securityLevel: "strict",
        theme: "base",
        darkMode: options.dark,
        themeVariables: themeVariablesFor(options.dark),
      });
      configuredFor = options.dark;
    }

    const renderId = options.id ?? `mermaid-export-svg-${++exportSequence}`;
    try {
      const { svg } = await mermaid.render(renderId, source);
      writeCachedSvg(key, svg);
      return svg;
    } catch (error) {
      // Mermaid leaves its measuring node behind when the grammar is wrong.
      if (typeof document !== "undefined") {
        document.getElementById(`d${renderId}`)?.remove();
      }
      throw error;
    }
  });
}
