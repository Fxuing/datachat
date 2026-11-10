import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Clock3, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import type { ChatFeedback, ChatUsage } from "../../lib/api";
import { deleteRunFeedback, saveRunFeedback } from "../../lib/api";
import { cn } from "../../lib/utils";
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
  durationMs?: number | null;
  feedback?: ChatFeedback | null;
  stepCount: number;
  children?: ReactNode;
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function TurnFooter({
  runId,
  status,
  usage,
  durationMs,
  feedback: savedFeedback,
  stepCount,
  children,
}: TurnFooterProps) {
  const [stepsOpen, setStepsOpen] = useState(false);
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
      {stepsOpen && children ? (
        <div className="rounded-lg border border-line bg-surface/60 p-2">{children}</div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <div className="flex items-center gap-0.5">
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

        {active ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            {status === "queued" ? "排队中…" : "生成中…"}
          </span>
        ) : null}

        {totalTokens > 0 && usage ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{formatTokens(totalTokens)} tokens</span>
            </TooltipTrigger>
            <TooltipContent side="top">
              输入 {usage.input} · 输出 {usage.output} · 缓存读 {usage.cacheRead} · 缓存写{" "}
              {usage.cacheWrite}
            </TooltipContent>
          </Tooltip>
        ) : null}

        {durationMs != null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1" tabIndex={0}>
                <Clock3 className="h-3 w-3" />
                {formatDuration(durationMs)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">本次运行耗时</TooltipContent>
          </Tooltip>
        ) : null}

        {stepCount > 0 ? (
          <button
            type="button"
            aria-expanded={stepsOpen}
            onClick={() => setStepsOpen((open) => !open)}
            className="flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-subtle hover:text-inksoft"
          >
            执行步骤 {stepCount}
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", stepsOpen && "rotate-180")}
            />
          </button>
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
