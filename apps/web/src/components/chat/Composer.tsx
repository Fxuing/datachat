import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { SendHorizontal, Sparkles, Square, X } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ModelPicker, type ModelPickerStatus } from "./ModelPicker";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import type { ChatModelInfo, ConversationSkill } from "../../lib/api";
import { cn } from "../../lib/utils";

const MAX_LENGTH = 8_000;

export interface ComposerProps {
  conversationReady: boolean;
  active: boolean;
  canStop: boolean;
  models: ChatModelInfo[];
  modelId: string;
  modelPickerDisabled: boolean;
  modelsStatus?: ModelPickerStatus;
  thinkingLevel: string;
  skills: ConversationSkill[];
  /** When set, the composer is locked and shows this placeholder. */
  readOnlyReason?: string;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  onModelChange: (modelId: string) => void;
  onThinkingChange: (level: string) => void;
  onSend: (content: string, skill?: string) => Promise<void>;
  onStop: () => void;
}

export function Composer({
  conversationReady,
  active,
  canStop,
  models,
  modelId,
  modelPickerDisabled,
  modelsStatus = "ready",
  thinkingLevel,
  skills,
  readOnlyReason,
  contextUsage,
  onModelChange,
  onThinkingChange,
  onSend,
  onStop,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<ConversationSkill | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const fit = () => {
      element.style.height = "auto";
      if (element.scrollHeight > 0) {
        element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [text]);

  const readOnly = Boolean(readOnlyReason);
  const disabled = readOnly || !conversationReady || active || submitting;
  const canType = conversationReady && !readOnly;
  const trimmed = text.trim();

  const slashMatch = /(^|\s)\/([^\s]*)$/.exec(text);
  const slashQuery = slashMatch?.[2]?.toLowerCase() ?? "";
  const slashIndex = slashMatch
    ? slashMatch.index + slashMatch[0].lastIndexOf("/")
    : -1;
  const menuOpen =
    Boolean(slashMatch) && !slashDismissed && canType && skills.length > 0;
  const filtered = menuOpen
    ? skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(slashQuery) ||
          skill.description.toLowerCase().includes(slashQuery),
      )
    : [];
  const highlighted = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  useEffect(() => {
    if (!menuOpen) return;
    optionRefs.current[highlighted]?.scrollIntoView?.({ block: "nearest" });
  }, [menuOpen, highlighted]);

  const submit = async () => {
    if (!trimmed || disabled || menuOpen) return;
    setSubmitting(true);
    try {
      await onSend(trimmed, selectedSkill?.name);
      setText("");
      setSelectedSkill(null);
    } catch {
      // The page renders the send error inline; keep the draft for a retry.
    } finally {
      setSubmitting(false);
    }
  };

  const chooseSkill = (skill: ConversationSkill) => {
    setSelectedSkill(skill);
    setText(slashIndex >= 0 ? text.slice(0, slashIndex) : "");
    setSlashDismissed(false);
    setActiveIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex(filtered.length === 0 ? 0 : (highlighted + 1) % filtered.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(filtered.length === 0 ? 0 : (highlighted - 1 + filtered.length) % filtered.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        const skill = filtered[highlighted];
        if (skill) chooseSkill(skill);
        return;
      }
    }
    if (!menuOpen && event.key === "Backspace" && text === "" && selectedSkill) {
      event.preventDefault();
      setSelectedSkill(null);
      return;
    }
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
        <div className="relative rounded-xl border border-line bg-surface shadow-card transition-colors focus-within:border-brand/40 focus-within:ring-2 focus-within:ring-brand/10">
          {menuOpen ? (
            <div
              role="listbox"
              aria-label="选择技能"
              className="absolute inset-x-2 bottom-full z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop"
            >
              <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted">
                技能
              </p>
              {filtered.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted">没有匹配的技能</p>
              ) : (
                filtered.map((skill, index) => (
                  <button
                    key={skill.name}
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    type="button"
                    role="option"
                    aria-selected={index === highlighted}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => chooseSkill(skill)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-1.5 text-left",
                      index === highlighted && "bg-subtle",
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5 text-xs font-medium text-ink">
                      <Sparkles className="h-3 w-3 text-brand" />
                      <span className="truncate">{skill.name}</span>
                      <span className="ml-auto shrink-0 text-[10px] font-normal text-muted">
                        {skill.scope === "global" ? "全局" : "数据源"}
                      </span>
                    </span>
                    {skill.description ? (
                      <span className="line-clamp-1 text-[11px] text-muted">
                        {skill.description}
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          ) : null}

          {selectedSkill ? (
            <div className="flex flex-wrap items-center gap-1 px-3 pt-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-brandsoft px-2 py-0.5 text-[11px] text-brandtext">
                <Sparkles className="h-3 w-3" />
                技能 · {selectedSkill.name}
                <button
                  type="button"
                  aria-label="移除技能"
                  onClick={() => setSelectedSkill(null)}
                  className="rounded p-0.5 text-brandtext/70 hover:bg-brand/10 hover:text-brandtext"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </div>
          ) : null}

          <div className="flex items-end gap-1.5 px-2 pt-2">
            <Textarea
              ref={textareaRef}
              aria-label="输入问题"
              rows={1}
              maxLength={MAX_LENGTH}
              value={text}
              disabled={!canType}
              placeholder={
                readOnly && readOnlyReason
                  ? readOnlyReason
                  : conversationReady
                  ? skills.length > 0
                    ? "输入问题，输入 / 选择技能"
                    : "输入问题，例如：users 表有多少行？"
                  : "请先在左侧选择或新建会话"
              }
              onChange={(event) => {
                setText(event.target.value);
                setSlashDismissed(false);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              className="max-h-40 min-h-[28px] resize-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:border-0 focus-visible:ring-0"
            />
          </div>
          <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-1 text-[11px] text-muted">
            <span className="hidden truncate sm:inline">Enter 发送，Shift + Enter 换行</span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {trimmed.length > MAX_LENGTH - 1_000 ? (
                <span className="tabular-nums">{`${trimmed.length} / ${MAX_LENGTH}`}</span>
              ) : null}
              <ContextRing usage={contextUsage ?? null} />
              <ModelPicker
                models={models}
                modelId={modelId}
                thinkingLevel={thinkingLevel}
                disabled={!conversationReady || modelPickerDisabled || readOnly}
                status={modelsStatus}
                onModelChange={onModelChange}
                onThinkingChange={onThinkingChange}
              />
              {active && canStop ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 px-2.5"
                  onClick={onStop}
                >
                  <Square className="h-3 w-3 fill-current" />
                  停止
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 px-3"
                  disabled={disabled || !trimmed || menuOpen}
                >
                  <SendHorizontal className="h-3.5 w-3.5" />
                  {submitting ? "发送中…" : "发送"}
                </Button>
              )}
            </div>
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
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-1.5" tabIndex={0} aria-label={title}>
          <svg viewBox="0 0 16 16" className={cn("h-4 w-4 -rotate-90", color)} aria-hidden>
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity="0.2"
            />
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
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
