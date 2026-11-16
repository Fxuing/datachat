import { useEffect, useState } from "react";
import { Clock3, ThumbsDown, ThumbsUp } from "lucide-react";
import type { ChatFeedback, ChatUsage } from "../../lib/api";
import { deleteRunFeedback, saveRunFeedback } from "../../lib/api";
import { cn, formatDuration, formatTokens } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export interface TurnFooterProps {
  runId: string | null;
  status: "idle" | "queued" | "running" | "ok" | "error" | "aborted";
  usage?: ChatUsage | null;
  /** Only shown when the turn has no trace to carry the duration itself. */
  durationMs?: number | null;
  feedback?: ChatFeedback | null;
}

export function TurnFooter({
  runId,
  status,
  usage,
  durationMs,
  feedback: savedFeedback,
}: TurnFooterProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [rating, setRating] = useState<1 | -1>(1);
  const [comment, setComment] = useState("");
  const [feedback, setFeedback] = useState<ChatFeedback | null>(savedFeedback ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    setFeedback(savedFeedback ?? null);
  }, [savedFeedback]);

  const submitFeedback = async () => {
    if (!runId) return;
    setSaving(true);
    setError(null);
    try {
      const trimmed = comment.trim();
      await saveRunFeedback(runId, { rating, comment: trimmed || undefined });
      setFeedback({ rating, comment: trimmed || null });
      setDialogOpen(false);
    } catch {
      setError("保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  const removeFeedback = async () => {
    if (!runId) return;
    setRemoving(true);
    setError(null);
    try {
      await deleteRunFeedback(runId);
      setFeedback(null);
      setDialogOpen(false);
    } catch {
      setError("删除失败，请稍后重试");
    } finally {
      setRemoving(false);
    }
  };

  const totalTokens = usage ? usage.input + usage.output : 0;
  const showTokens = Boolean(usage) && totalTokens > 0;
  const active = status === "running" || status === "queued";
  const canRate = Boolean(runId) && !active;

  const openFeedback = (next: 1 | -1) => {
    setRating(next);
    setComment(feedback?.comment ?? "");
    setError(null);
    setDialogOpen(true);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <div
          className={cn(
            "flex items-center gap-0.5 transition-opacity",
            // Rating stays out of the way until the reader is on this turn. An
            // already-rated turn keeps showing which way it went, and touch
            // screens (no hover) always get the buttons.
            !feedback &&
              "opacity-0 focus-within:opacity-100 group-hover/turn:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        >
          <button
            type="button"
            aria-label="有帮助"
            aria-pressed={feedback?.rating === 1}
            disabled={!canRate}
            onClick={() => openFeedback(1)}
            className={cn(
              "rounded-md p-1 transition-colors hover:bg-subtle disabled:opacity-40",
              feedback?.rating === 1 && "text-success",
            )}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="没有帮助"
            aria-pressed={feedback?.rating === -1}
            disabled={!canRate}
            onClick={() => openFeedback(-1)}
            className={cn(
              "rounded-md p-1 transition-colors hover:bg-subtle disabled:opacity-40",
              feedback?.rating === -1 && "text-danger",
            )}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </div>

        {durationMs != null || showTokens ? (
          <span className="flex items-center gap-1.5">
            {durationMs != null ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 tabular-nums" tabIndex={0}>
                    <Clock3 className="h-3 w-3" />
                    {formatDuration(durationMs)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">本次运行耗时</TooltipContent>
              </Tooltip>
            ) : null}
            {durationMs != null && showTokens ? (
              <span aria-hidden="true" className="text-muted/60">
                /
              </span>
            ) : null}
            {showTokens && usage ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="tabular-nums" tabIndex={0}>
                    {formatTokens(totalTokens)} tokens
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  输入 {usage.input} · 输出 {usage.output} · 缓存读 {usage.cacheRead} · 缓存写{" "}
                  {usage.cacheWrite}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </span>
        ) : null}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>评价这条回答</DialogTitle>
            <DialogDescription>反馈会帮助我们发现模型与数据问题。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variant={rating === 1 ? "primary" : "secondary"}
                size="sm"
                onClick={() => setRating(1)}
              >
                <ThumbsUp className="h-3.5 w-3.5" />
                有帮助
              </Button>
              <Button
                type="button"
                variant={rating === -1 ? "primary" : "secondary"}
                size="sm"
                onClick={() => setRating(-1)}
              >
                <ThumbsDown className="h-3.5 w-3.5" />
                没帮助
              </Button>
            </div>
            <Textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="补充说明（可选）：哪里不对、期望什么结果…"
              maxLength={2_000}
              rows={3}
            />
            {error ? <p className="text-xs text-danger">{error}</p> : null}
          </div>
          <DialogFooter>
            {feedback ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={removing}
                onClick={() => void removeFeedback()}
                className="sm:mr-auto"
              >
                删除评价
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saving}
              onClick={() => void submitFeedback()}
            >
              {saving ? "保存中…" : "保存评价"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
