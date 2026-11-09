import { useState, type KeyboardEvent } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

const MAX_LENGTH = 8_000;

const THINKING_OPTIONS = [
  { value: "off", label: "思考：关闭" },
  { value: "minimal", label: "思考：极简" },
  { value: "low", label: "思考：低" },
  { value: "medium", label: "思考：中" },
  { value: "high", label: "思考：高" },
  { value: "xhigh", label: "思考：极高" },
  { value: "max", label: "思考：最大" },
] as const;

export interface ComposerProps {
  conversationReady: boolean;
  active: boolean;
  canStop: boolean;
  thinkingLevel: string;
  onThinkingChange: (level: string) => void;
  onSend: (content: string) => Promise<void>;
  onStop: () => void;
}

export function Composer({
  conversationReady,
  active,
  canStop,
  thinkingLevel,
  onThinkingChange,
  onSend,
  onStop,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const disabled = !conversationReady || active || submitting;
  const canType = conversationReady;
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
    <div className="border-t border-line bg-surface/90 backdrop-blur">
      <form
        className="mx-auto w-full max-w-3xl px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-2 shadow-card transition-colors focus-within:border-brand/40 focus-within:ring-2 focus-within:ring-brand/10">
          <Textarea
            aria-label="输入问题"
            rows={2}
            maxLength={MAX_LENGTH}
            value={text}
            disabled={!canType}
            placeholder={
              conversationReady ? "输入问题，例如：users 表有多少行？" : "请先在左侧选择或新建会话"
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-[52px] resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:border-0 focus-visible:ring-0"
          />
          <Select
            value={thinkingLevel}
            onValueChange={onThinkingChange}
            disabled={!conversationReady}
          >
            <SelectTrigger
              aria-label="思考等级"
              title="模型思考等级（对下一次提问生效）"
              className="h-8 w-[7.5rem] shrink-0 gap-1 px-2 text-[11px] text-inksoft"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end" className="w-[8.5rem]">
              {THINKING_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value} className="text-xs">
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-muted">
          <span>Enter 发送，Shift + Enter 换行</span>
          <span>
            {trimmed.length > MAX_LENGTH - 1_000 ? `${trimmed.length} / ${MAX_LENGTH}` : null}
          </span>
        </div>
      </form>
    </div>
  );
}
