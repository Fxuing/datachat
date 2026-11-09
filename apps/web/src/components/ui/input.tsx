import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink shadow-sm",
        "placeholder:text-muted/70",
        "focus-visible:border-brand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/15",
        "disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted",
        className,
      )}
      {...props}
    />
  );
});
