import { useEffect, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";

export interface ThinkingBlockProps {
  thinking: string;
  running?: boolean;
}

/** Collapsible reasoning transcript. Kept separate from execution steps so the
 * model's train of thought can be inspected without expanding tool output. */
export function ThinkingBlock({ thinking, running = false }: ThinkingBlockProps) {
  const [open, setOpen] = useState(running);
  const contentRef = useRef<HTMLDivElement>(null);
  const text = thinking.trim();

  // Follow the live stream while the model is thinking, then fold the block
  // once the turn settles so the final answer stays compact.
  useEffect(() => {
    setOpen(running);
  }, [running]);

  useEffect(() => {
    if (!running || !open) return;
    const node = contentRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [text, running, open]);

  if (!text && !running) return null;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted transition-colors hover:bg-subtle hover:text-inksoft"
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span>思考过程</span>
        {running ? (
          <span className="text-brandtext">思考中…</span>
        ) : (
          <span className="text-muted/70">{text.length} 字</span>
        )}
        <ChevronDown
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div
          ref={contentRef}
          data-testid="thinking-content"
          className="max-h-80 overflow-y-auto whitespace-pre-wrap border-l-2 border-line pl-3 text-[12px] leading-6 text-muted"
        >
          {text || "…"}
        </div>
      ) : null}
    </div>
  );
}
