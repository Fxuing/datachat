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

/** A right-side turn rail: hover for the turn list, click a row to jump. */
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
      className="absolute inset-y-24 right-[max(0.5rem,calc((100%-48rem)/2-0.75rem))] z-10 hidden w-8 lg:block"
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
      <div className="flex h-full flex-col items-end justify-center gap-1.5">
        {ticks.map((message) => {
          const index = messages.indexOf(message) + 1;
          const current = active === message.runId;
          return (
            <button
              key={message.runId}
              type="button"
              aria-label={`跳到第 ${index} 轮`}
              onMouseEnter={() => {
                setOpen(true);
                setActive(message.runId);
              }}
              onFocus={() => {
                setOpen(true);
                setActive(message.runId);
              }}
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

      {open ? (
        <div className="absolute right-full top-1/2 -mr-1 max-h-[60vh] w-72 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop">
          <p className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted">
            {messages.length} 轮对话
          </p>
          <div>
            {messages.map((message, index) => (
              <button
                key={message.runId}
                type="button"
                onMouseEnter={() => setActive(message.runId)}
                onFocus={() => setActive(message.runId)}
                onClick={() => jump(message.runId)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-subtle",
                  active === message.runId && "bg-subtle",
                )}
              >
                <span className="mt-0.5 w-5 shrink-0 text-right text-[10px] tabular-nums text-muted">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 block text-[11px] font-medium text-ink">
                    {snippet(message.user.content, 60)}
                  </span>
                  {message.assistant?.content ? (
                    <span className="mt-0.5 line-clamp-1 block text-[10px] text-muted">
                      {snippet(message.assistant.content, 70)}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
