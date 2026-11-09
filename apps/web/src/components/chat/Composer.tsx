import { useState, type KeyboardEvent } from "react";
import { SendHorizontal, Square } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ModelPicker } from "./ModelPicker";
import type { ChatModelInfo } from "../../lib/api";
import { cn } from "../../lib/utils";

const MAX_LENGTH = 8_000;

export interface ComposerProps {
  conversationReady: boolean;
  active: boolean;
  canStop: boolean;
  models: ChatModelInfo[];
  modelId: string;
  modelPickerDisabled: boolean;
  thinkingLevel: string;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  onModelChange: (modelId: string) => void;
  onThinkingChange: (level: string) => void;
  onSend: (content: string) => Promise<void>;
  onStop: () => void;
}

export function Composer({
  conversationReady,
  active,
  canStop,
  models,
  modelId,
  modelPickerDisabled,
  thinkingLevel,
  contextUsage,
  onModelChange,
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
        <div className="rounded-xl border border-line bg-surface shadow-card transition-colors focus-within:border-brand/40 focus-within:ring-2 focus-within:ring-brand/10">
          <div className="flex items-end gap-2 p-2">
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
          <ModelPicker
            models={models}
            modelId={modelId}
            thinkingLevel={thinkingLevel}
            disabled={!conversationReady || modelPickerDisabled}
            onModelChange={onModelChange}
            onThinkingChange={onThinkingChange}
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
          <div className="flex items-center justify-between px-3 pb-2 text-[11px] text-muted">
            <div className="flex items-center gap-2">
              <ContextRing usage={contextUsage ?? null} />
              <span>Enter 发送，Shift + Enter 换行</span>
            </div>
            <span className="pr-1">
              {trimmed.length > MAX_LENGTH - 1_000 ? `${trimmed.length} / ${MAX_LENGTH}` : null}
            </span>
          </div>
        </div>
      </form>
    </div>
  );
}


function ContextRing({
  usage,
}: {
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
}) {
  const percent = usage?.percent ?? null;
  const ratio = percent === null ? 0 : Math.min(1, Math.max(0, percent / 100));
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const color =
    percent !== null && percent >= 90
      ? "text-danger"
      : percent !== null && percent >= 70
        ? "text-warning"
        : "text-brand";
  const label = percent === null ? "上下文 —" : `上下文 ${Math.round(percent)}%`;
  const title =
    usage && usage.tokens !== null
      ? `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`
      : "上下文使用情况（等待首轮回复后更新）";
  return (
    <span className="flex items-center gap-1.5" title={title}>
      <svg viewBox="0 0 16 16" className={cn("h-4 w-4 -rotate-90", color)} aria-hidden>
        <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.2" />
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      <span className="tabular-nums">{label}</span>
    </span>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
