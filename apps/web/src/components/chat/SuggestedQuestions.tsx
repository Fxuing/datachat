import { ArrowUpRight, Sparkles, X } from "lucide-react";

export function SuggestedQuestions({
  suggestions,
  disabled = false,
  onSelect,
  onDismiss,
}: {
  suggestions: string[];
  disabled?: boolean;
  onSelect: (question: string) => void;
  onDismiss: () => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div
      aria-label="建议追问"
      className="mx-auto w-full max-w-3xl px-4 pb-2 pt-1.5 animate-fade-in"
    >
      <div className="flex items-center justify-between gap-2 pb-1.5">
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted">
          <Sparkles className="h-3 w-3 text-brand" aria-hidden />
          建议追问
        </span>
        <button
          type="button"
          aria-label="隐藏建议问题"
          onClick={onDismiss}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-subtle hover:text-ink"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {suggestions.map((question) => (
          <button
            key={question}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(question)}
            className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-xs text-inksoft shadow-card transition-colors hover:border-brand/40 hover:bg-brandsoft/50 hover:text-brandtext disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="truncate">{question}</span>
            <ArrowUpRight
              className="h-3 w-3 shrink-0 text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-brandtext"
              aria-hidden
            />
          </button>
        ))}
      </div>
    </div>
  );
}
