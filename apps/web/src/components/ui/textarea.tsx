import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink shadow-sm",
        "placeholder:text-muted/70",
        "focus-visible:border-brand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/15",
        "disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted",
        className,
      )}
      {...props}
    />
  );
});
