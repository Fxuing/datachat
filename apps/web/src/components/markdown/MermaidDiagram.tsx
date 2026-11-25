import { memo, useEffect, useRef, useState } from "react";
import { Code2, Loader2 } from "lucide-react";
import { cacheKeyFor, readCachedSvg } from "./mermaid-cache";
import { renderMermaidSvg } from "./mermaid-render";

/**
 * Wait for the source to stop changing before rendering. Chat answers stream in
 * token by token, and a half-written fence throws on every delta.
 */
const RENDER_DELAY_MS = 400;

let sequence = 0;

function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

/** Renders a ```mermaid fence as an inline figure, with the source one click away. */
export const MermaidDiagram = memo(function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(() => {
    if (typeof document === "undefined") return null;
    const dark = document.documentElement.classList.contains("dark");
    return readCachedSvg(cacheKeyFor(dark, source));
  });
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const dark = useIsDark();
  const idRef = useRef("");

  if (idRef.current === "") {
    sequence += 1;
    idRef.current = `mermaid-svg-${sequence}`;
  }

  useEffect(() => {
    const key = cacheKeyFor(dark, source);
    const cached = readCachedSvg(key);
    if (cached) {
      setSvg(cached);
      setFailed(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const rendered = await renderMermaidSvg(source, { dark, id: idRef.current });
          if (cancelled) return;
          setSvg(rendered);
          setFailed(false);
        } catch (error) {
          if (cancelled) return;
          console.warn("mermaid diagram could not be rendered", error);
          setFailed(true);
        }
      })();
    }, RENDER_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, dark]);

  // Keep the last good chart on screen while a newer source fails to parse.
  const showsSource = showSource || (failed && svg === null);

  return (
    <figure
      data-mermaid-source={source}
      className="group/mermaid relative my-3 overflow-hidden rounded-lg border border-line bg-surface"
    >
      <button
        type="button"
        onClick={() => setShowSource((value) => !value)}
        aria-pressed={showSource}
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-1 text-[10px] text-muted opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/mermaid:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Code2 className="h-3 w-3" />
        {showSource ? "图表" : "源码"}
      </button>
      {showsSource ? (
        <pre className="overflow-x-auto px-3 py-3 text-xs leading-5 text-inksoft">{source}</pre>
      ) : svg ? (
        <div
          className="flex justify-center overflow-x-auto px-3 py-3 [&_svg]:h-auto [&_svg]:max-w-full"
          // Mermaid sanitises its own output (securityLevel: "strict").
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="flex items-center gap-2 px-3 py-6 text-[11px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          正在渲染图表…
        </div>
      )}
      {failed && svg === null ? (
        <p className="border-t border-line px-3 py-2 text-[11px] text-muted">图表语法有误，已显示源码。</p>
      ) : null}
    </figure>
  );
});
