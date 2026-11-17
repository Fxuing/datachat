/**
 * Rendered diagrams, keyed by theme and source.
 *
 * A finished answer can remount — a history refetch, a list rerender — and
 * re-running mermaid on the way back makes the figure blink to its placeholder.
 * At the bottom of a long turn that blink also moves the scroll position, which
 * feeds the next rerender, so the same diagram appears to render in a loop.
 * Cached output paints on the first frame instead.
 */
const SVG_CACHE_LIMIT = 24;

const svgCache = new Map<string, string>();

export function cacheKeyFor(dark: boolean, source: string): string {
  return `${dark ? "dark" : "light"}\u0000${source}`;
}

export function readCachedSvg(key: string): string | null {
  return svgCache.get(key) ?? null;
}

export function writeCachedSvg(key: string, svg: string): void {
  if (svgCache.size >= SVG_CACHE_LIMIT) {
    const oldest = svgCache.keys().next();
    if (!oldest.done) svgCache.delete(oldest.value);
  }
  svgCache.set(key, svg);
}

/** Test hook: each case starts from an empty cache. */
export function clearSvgCache(): void {
  svgCache.clear();
}
