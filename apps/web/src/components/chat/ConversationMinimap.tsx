import { useState, type RefObject } from "react";
import type { ChatMessage } from "../../lib/api";
import { cn } from "../../lib/utils";

export interface ConversationMinimapProps {
  messages: ChatMessage[];
  containerRef: RefObject<HTMLDivElement | null>;
  maxTicks?: number;
}

function snippet(text: string, length: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length)}…` : compact;
}

/** A right-side turn rail that unfolds into a list of user questions on hover. */
export function ConversationMinimap({
  messages,
  containerRef,
  maxTicks = 40,
}: ConversationMinimapProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  if (messages.length < 3) return null;

  const stride = Math.max(1, Math.ceil(messages.length / maxTicks));
  const ticks = messages.filter(
    (_, index) => index % stride === 0 || index === messages.length - 1,
  );

  const jump = (runId: string) => {
    const target =
      containerRef.current?.querySelector<HTMLElement>(`#turn-${runId}`) ??
      document.getElementById(`turn-${runId}`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    setOpen(false);
  };

  return (
    <div
      aria-label="会话导航"
      className="pointer-events-none absolute inset-0 z-10 hidden lg:block"
    >
      <div
        className="pointer-events-auto absolute right-[calc((100%-48rem)/4-1rem)] top-1/2 -translate-y-1/2"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => {
          setOpen(false);
          setActive(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setOpen(false);
          }
        }}
      >
        {open ? (
          <div className="max-h-[60vh] w-60 translate-x-[5.75rem] animate-[minimap-panel_200ms_ease-out] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop">
            <p className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted">
              {messages.length} 轮对话
            </p>
            {messages.map((message, index) => (
              <button
                key={message.runId}
                type="button"
                aria-label={`跳到第 ${index + 1} 轮`}
                onMouseEnter={() => setActive(message.runId)}
                onFocus={() => setActive(message.runId)}
                onClick={() => jump(message.runId)}
                style={{ animationDelay: `${Math.min(index, 8) * 18}ms` }}
                className={cn(
                  "flex w-full animate-[minimap-reveal_180ms_ease-out_both] items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-subtle",
                  active === message.runId && "bg-subtle",
                )}
              >
                <span className="w-5 shrink-0 text-right text-[10px] tabular-nums text-muted">
                  {index + 1}
                </span>
                <span className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-4 text-ink">
                  {snippet(message.user.content, 120)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-end gap-1.5">
            {ticks.map((message) => {
              const index = messages.indexOf(message) + 1;
              const current = active === message.runId;
              return (
                <button
                  key={message.runId}
                  type="button"
                  aria-label={`跳到第 ${index} 轮`}
                  onMouseEnter={() => setActive(message.runId)}
                  onFocus={() => setActive(message.runId)}
                  onClick={() => jump(message.runId)}
                  className="flex h-4 w-8 items-center justify-end rounded-md transition-colors hover:bg-subtle"
                >
                  <span
                    className={cn(
                      "block h-1 w-5 rounded-full bg-line transition-all",
                      current && "bg-brand",
                    )}
                  />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
