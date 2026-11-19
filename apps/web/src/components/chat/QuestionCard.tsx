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

  const answeredCount = questions.filter(
    (_, index) => (selected[index]?.length ?? 0) > 0 || (texts[index] ?? "").trim().length > 0,
  ).length;

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
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
      <div className="flex items-center gap-2.5 bg-subtle/60 px-4 py-2.5">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brandsoft text-brandtext">
          <CircleHelp className="size-3.5" />
        </span>
        <span className="text-[13px] font-medium text-ink">需要你的选择</span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
          <span className="size-1.5 animate-pulse rounded-full bg-warning" />
          模型等待中
        </span>
      </div>

      {questions.length > 1 && (
        <div className="flex items-center gap-1 overflow-x-auto px-3 pt-3">
          <div className="flex min-w-0 items-center gap-1 rounded-lg bg-subtle p-1">
            {questions.map((question, index) => {
              const done =
                (selected[index]?.length ?? 0) > 0 || (texts[index] ?? "").trim().length > 0;
              return (
                <button
                  key={`${question.header}-${index}`}
                  type="button"
                  onClick={() => setActive(index)}
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                    index === active
                      ? "bg-surface text-ink shadow-card"
                      : "text-muted hover:text-ink",
                  )}
                >
                  {question.header || `问题 ${index + 1}`}
                  {done && <Check className="size-3 text-success" />}
                </button>
              );
            })}
          </div>
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted">
            {answeredCount}/{questions.length}
          </span>
        </div>
      )}

      <div className="space-y-3 px-4 py-3.5">
        <div className="flex items-start gap-2">
          <p className="text-[15px] font-medium leading-6 text-ink">{current.question}</p>
          {current.multiSelect && (
            <span className="mt-0.5 shrink-0 rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
              多选
            </span>
          )}
        </div>

        <div className="overflow-hidden rounded-lg border border-line">
          {current.options.map((option, index) => {
            const checked = selected[active]?.includes(index) ?? false;
            return (
              <button
                key={`${option.label}-${index}`}
                type="button"
                onClick={() => toggle(active, index)}
                disabled={pending}
                aria-pressed={checked}
                className={cn(
                  "flex w-full items-start gap-2.5 border-b border-line px-3 py-2.5 text-left transition-colors last:border-b-0",
                  checked ? "bg-brandsoft/60" : "bg-surface hover:bg-subtle/70",
                  pending && "opacity-60",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors",
                    current.multiSelect ? "rounded-[5px]" : "rounded-full",
                    checked
                      ? current.multiSelect
                        ? "border-brand bg-brand text-white"
                        : "border-brand bg-surface"
                      : "border-linestrong bg-surface",
                  )}
                >
                  {checked &&
                    (current.multiSelect ? (
                      <Check className="size-3" />
                    ) : (
                      <span className="size-2 rounded-full bg-brand" />
                    ))}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium leading-5 text-ink">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-[12px] leading-5 text-muted">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div>
          <label
            className="mb-1 flex items-center gap-1.5 text-[11px] text-muted"
            htmlFor={`question-text-${active}`}
          >
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
            placeholder="直接输入答案，或补充选择理由"
            className="min-h-[56px] resize-none text-[13px]"
          />
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line/70 bg-subtle/30 px-4 py-2.5">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {questions.length > 1 && !complete
            ? `还有 ${questions.length - answeredCount} 个问题未回答`
            : "提交后模型会继续执行"}
        </p>
        {questions.length > 1 ? (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || active === 0}
              onClick={() => setActive((index) => Math.max(0, index - 1))}
            >
              上一题
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || active === questions.length - 1}
              onClick={() => setActive((index) => Math.min(questions.length - 1, index + 1))}
            >
              下一题
            </Button>
          </div>
        ) : null}
        <Button variant="ghost" size="sm" onClick={() => void cancel()} disabled={pending}>
          <X className="size-3.5" />
          取消
        </Button>
        <Button
          size="sm"
          className="min-w-[6.5rem]"
          onClick={() => void submit()}
          disabled={pending || !complete}
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {pending ? "提交中" : "提交回答"}
        </Button>
      </div>
    </div>
  );
}
