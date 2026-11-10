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

/** A right-side turn rail: hover for a preview, click to jump to that turn. */
export function ConversationMinimap({
  messages,
  containerRef,
  maxTicks = 40,
}: ConversationMinimapProps) {
  const [hovered, setHovered] = useState<string | null>(null);
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
  };

  return (
    <div
      aria-label="会话导航"
      className="absolute inset-y-24 right-1 z-10 hidden w-8 lg:block"
    >
      <div className="flex h-full flex-col items-end justify-center gap-1.5">
        {ticks.map((message) => {
          const index = messages.indexOf(message) + 1;
          const open = hovered === message.runId;
          return (
            <div key={message.runId} className="group relative flex h-2.5 items-center">
              <button
                type="button"
                aria-label={`跳到第 ${index} 轮`}
                onMouseEnter={() => setHovered(message.runId)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(message.runId)}
                onBlur={() => setHovered(null)}
                onClick={() => jump(message.runId)}
                className={cn(
                  "h-1 w-4 rounded-full bg-line transition-all hover:w-5 hover:bg-brand",
                  open && "w-5 bg-brand",
                )}
              />
              {open ? (
                <div className="pointer-events-none absolute right-6 top-1/2 w-64 -translate-y-1/2 rounded-lg border border-line bg-surface p-2 text-left shadow-pop">
                  <p className="text-[10px] text-muted">第 {index} 轮</p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] font-medium text-ink">
                    {snippet(message.user.content, 90)}
                  </p>
                  {message.assistant?.content ? (
                    <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-muted">
                      {snippet(message.assistant.content, 140)}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
