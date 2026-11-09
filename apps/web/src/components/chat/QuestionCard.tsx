import { useMemo, useState } from "react";
import { Check, CircleHelp, Loader2, X } from "lucide-react";
import type { QuestionAnswerEntry, QuestionPrompt } from "../../lib/api";
import { answerQuestion } from "../../lib/api";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export interface QuestionCardProps {
  conversationId: string;
  toolCallId: string;
  questions: QuestionPrompt[];
}

/**
 * Web counterpart of the questionnaire extension. Options mirror the terminal UI:
 * single/multi select, an optional free-text answer per question, and a cancel action.
 */
export function QuestionCard({ conversationId, toolCallId, questions }: QuestionCardProps) {
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<number[][]>(() => questions.map(() => []));
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ""));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = useMemo(
    () =>
      questions.every(
        (_, index) => (selected[index]?.length ?? 0) > 0 || (texts[index] ?? "").trim().length > 0,
      ),
    [questions, selected, texts],
  );

  const toggle = (questionIndex: number, optionIndex: number) => {
    const question = questions[questionIndex];
    if (!question) return;
    setSelected((current) =>
      current.map((value, index) => {
        if (index !== questionIndex) return value;
        if (!question.multiSelect) return value.includes(optionIndex) ? [] : [optionIndex];
        return value.includes(optionIndex)
          ? value.filter((item) => item !== optionIndex)
          : [...value, optionIndex];
      }),
    );
  };

  const submit = async () => {
    if (pending || !complete) return;
    setPending(true);
    setError(null);
    const answers: QuestionAnswerEntry[] = questions.map((_, index) => ({
      questionIndex: index,
      ...(selected[index]?.length ? { optionIndexes: selected[index] } : {}),
      ...(texts[index]?.trim() ? { text: texts[index]!.trim() } : {}),
    }));
    try {
      await answerQuestion(conversationId, toolCallId, { answers });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交失败，请重试");
      setPending(false);
    }
  };

  const cancel = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await answerQuestion(conversationId, toolCallId, { cancel: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取消失败，请重试");
      setPending(false);
    }
  };

  const current = questions[active] ?? questions[0];
  if (!current) return null;

  return (
    <div className="mx-auto w-full max-w-3xl rounded-card border border-brand/30 bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <CircleHelp className="size-4 text-brandtext" />
        <span className="text-sm font-medium text-ink">需要你的选择</span>
        <span className="text-xs text-muted">模型正在等待回答</span>
      </div>

      {questions.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
          {questions.map((question, index) => (
            <button
              key={`${question.header}-${index}`}
              type="button"
              onClick={() => setActive(index)}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-xs transition-colors",
                index === active
                  ? "bg-brandsoft text-brandtext"
                  : "text-muted hover:bg-subtle hover:text-ink",
              )}
            >
              {question.header || `问题 ${index + 1}`}
              {(selected[index]?.length ?? 0) > 0 || texts[index]?.trim() ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-3 px-4 py-4">
        <div>
          <p className="text-sm font-medium text-ink">{current.question}</p>
          {current.multiSelect && <p className="mt-0.5 text-xs text-muted">可多选</p>}
        </div>

        <div className="space-y-2">
          {current.options.map((option, index) => {
            const checked = selected[active]?.includes(index) ?? false;
            return (
              <button
                key={`${option.label}-${index}`}
                type="button"
                onClick={() => toggle(active, index)}
                disabled={pending}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  checked
                    ? "border-brand bg-brandsoft/60"
                    : "border-line bg-surface hover:border-linestrong hover:bg-subtle",
                  pending && "opacity-60",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                    current.multiSelect ? "rounded" : "rounded-full",
                    checked ? "border-brand bg-brand text-white" : "border-linestrong",
                  )}
                >
                  {checked && <Check className="size-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted" htmlFor={`question-text-${active}`}>
            其他答案或补充说明（可选）
          </label>
          <Textarea
            id={`question-text-${active}`}
            rows={2}
            value={texts[active] ?? ""}
            disabled={pending}
            onChange={(event) =>
              setTexts((currentTexts) =>
                currentTexts.map((value, index) => (index === active ? event.target.value : value)),
              )
            }
            placeholder="直接输入你的答案，或补充选择理由"
          />
        </div>

        {questions.length > 1 && !complete && (
          <p className="text-xs text-muted">还有问题未回答，切换上方标签继续选择。</p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
        <Button variant="ghost" size="sm" onClick={() => void cancel()} disabled={pending}>
          <X className="size-3.5" />
          取消
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={pending || !complete}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {pending ? "提交中" : "提交回答"}
        </Button>
      </div>
    </div>
  );
}
