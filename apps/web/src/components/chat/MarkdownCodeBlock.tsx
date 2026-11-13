import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "../../lib/clipboard";

/** A fenced code block with a hover-revealed copy action. */
export function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async () => {
    const text = preRef.current?.textContent?.replace(/\n$/, "");
    if (!text || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard access can be blocked; keep the code visible for manual copy.
    }
  };

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "已复制代码" : "复制代码"}
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded border border-white/10 bg-white/10 px-2 py-1 text-[10px] text-white/75 opacity-0 backdrop-blur transition-opacity hover:bg-white/20 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "已复制" : "复制"}
      </button>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}
