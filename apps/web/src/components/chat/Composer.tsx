import { useState, type KeyboardEvent } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const MAX_LENGTH = 8_000;

export interface ComposerProps {
  conversationReady: boolean;
  active: boolean;
  canStop: boolean;
  onSend: (content: string) => Promise<void>;
  onStop: () => void;
}

export function Composer({
  conversationReady,
  active,
  canStop,
  onSend,
  onStop,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = !conversationReady || active || submitting;
  const trimmed = text.trim();

  const submit = async () => {
    if (!trimmed || disabled) return;
    setSubmitting(true);
    try {
      await onSend(trimmed);
      setText("");
    } catch {
      // The page renders the send error inline; keep the draft for a retry.
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-t border-neutral-200 bg-white">
      <form
        className="mx-auto w-full max-w-3xl px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-end gap-2">
          <Textarea
            aria-label="输入问题"
            rows={2}
            maxLength={MAX_LENGTH}
            value={text}
            disabled={disabled}
            placeholder={
              conversationReady ? "输入问题，例如：users 表有多少行？" : "请先在左侧选择或新建会话"
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-[64px] resize-none"
          />
          {active && canStop ? (
            <Button variant="outline" className="gap-2" onClick={onStop}>
              <Square className="h-3.5 w-3.5 fill-current" />
              停止
            </Button>
          ) : (
            <Button type="submit" className="gap-2" disabled={disabled || !trimmed}>
              <SendHorizontal className="h-4 w-4" />
              {submitting ? "发送中…" : "发送"}
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-neutral-400">
          <span>Enter 发送，Shift + Enter 换行</span>
          <span>
            {trimmed.length > MAX_LENGTH - 1_000 ? `${trimmed.length} / ${MAX_LENGTH}` : null}
          </span>
        </div>
      </form>
    </div>
  );
}
