import { useEffect, type ReactNode } from "react";
import { Button } from "../ui/button";

export interface ConfirmDialogProps {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "primary" | "danger";
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Small centered confirmation dialog shared by delete/seed/discard flows. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  variant = "primary",
  pending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, pending]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onMouseDown={() => {
        if (!pending) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-lg border border-line bg-surface shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-line px-4 py-3 text-sm font-semibold text-ink">
          {title}
        </div>
        <div className="space-y-3 p-4">
          {description ? <div className="text-sm text-muted">{description}</div> : null}
          {error ? (
            <p role="alert" className="rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button variant={variant === "danger" ? "danger" : "primary"} size="sm" disabled={pending} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
