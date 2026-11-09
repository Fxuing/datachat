import type { ReactNode } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

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
  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onCancel() : undefined)}>
      <DialogContent className="max-w-sm gap-0 p-0" hideClose>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 p-4">
          {description ? <div className="text-sm text-muted">{description}</div> : null}
          {error ? (
            <p role="alert" className="rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter className="border-0 p-0">
            <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button
              variant={variant === "danger" ? "danger" : "primary"}
              size="sm"
              disabled={pending}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
