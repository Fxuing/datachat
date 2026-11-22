import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  CheckCircle2,
  Code2,
  MessageSquareWarning,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
  XCircle,
} from "lucide-react";
import {
  listDatasourceFeedback,
  updateDatasourceFeedbackStatus,
  type DatasourceFeedbackItem,
  type FeedbackReviewStatus,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { cn, formatClock } from "../../lib/utils";
import { Button } from "../ui/button";
import { PageSpinner } from "../ui/spinner";

export interface SemanticFeedbackPanelProps {
  datasourceId: string;
  onPromoteToExample: (item: DatasourceFeedbackItem) => void;
  onPromoteToMetric: (item: DatasourceFeedbackItem) => void;
}

function statusPill(status: FeedbackReviewStatus): { label: string; className: string } {
  if (status === "promoted") {
    return { label: "已沉淀", className: "bg-successsoft text-success" };
  }
  if (status === "dismissed") {
    return { label: "已忽略", className: "bg-subtle text-muted" };
  }
  return { label: "待处理", className: "bg-warningsoft text-warning" };
}

export function SemanticFeedbackPanel({
  datasourceId,
  onPromoteToExample,
  onPromoteToMetric,
}: SemanticFeedbackPanelProps) {
  const queryClient = useQueryClient();
  const [ratingFilter, setRatingFilter] = useState<"all" | "-1" | "1">("all");
  const [statusFilter, setStatusFilter] = useState<"pending" | "all" | "promoted" | "dismissed">(
    "pending",
  );

  const feedbackQuery = useQuery({
    queryKey: queryKeys.semanticFeedback(datasourceId, ratingFilter, statusFilter),
    queryFn: () =>
      listDatasourceFeedback(datasourceId, {
        rating: ratingFilter,
        status: statusFilter,
      }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, reviewStatus }: { id: string; reviewStatus: FeedbackReviewStatus }) =>
      updateDatasourceFeedbackStatus(datasourceId, id, reviewStatus),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.semanticFeedbackAll(datasourceId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.semanticLayer(datasourceId) });
    },
  });

  const items = feedbackQuery.data?.items ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted">评价：</span>
          {(
            [
              { value: "all", label: "全部" },
              { value: "-1", label: "仅点踩（优先纠错）" },
              { value: "1", label: "仅点赞（优质沉淀）" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setRatingFilter(opt.value)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                ratingFilter === opt.value
                  ? "bg-brandsoft font-medium text-brandtext"
                  : "text-muted hover:bg-subtle hover:text-ink",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted">状态：</span>
          {(
            [
              { value: "pending", label: "待处理" },
              { value: "promoted", label: "已沉淀" },
              { value: "dismissed", label: "已忽略" },
              { value: "all", label: "全部" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatusFilter(opt.value)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                statusFilter === opt.value
                  ? "bg-brandsoft font-medium text-brandtext"
                  : "text-muted hover:bg-subtle hover:text-ink",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {feedbackQuery.isPending ? (
          <PageSpinner label="加载问答反馈…" />
        ) : feedbackQuery.isError ? (
          <div role="alert" className="p-4 text-xs text-danger">
            {describeApiError(feedbackQuery.error, "加载问答反馈失败，请稍后重试。")}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <MessageSquareWarning className="h-8 w-8 text-muted/60" />
            <p className="text-sm font-medium text-ink">当前筛选下没有问答反馈</p>
            <p className="max-w-md text-xs text-muted">
              用户在对话中点赞或点踩的问答会自动汇总到这里，管理员可一键纠错并沉淀为 Few-Shot SQL 示例或业务指标口径。
            </p>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {items.map((item) => {
              const pill = statusPill(item.reviewStatus);
              const isDown = item.rating === -1;
              return (
                <div key={item.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
                            isDown
                              ? "bg-dangersoft text-danger"
                              : "bg-successsoft text-success",
                          )}
                        >
                          {isDown ? (
                            <ThumbsDown className="h-3 w-3" />
                          ) : (
                            <ThumbsUp className="h-3 w-3" />
                          )}
                          {isDown ? "点踩" : "点赞"}
                        </span>
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", pill.className)}>
                          {pill.label}
                        </span>
                        <span className="text-xs text-muted">
                          {item.displayName ?? item.username}
                        </span>
                        <span className="text-[11px] text-muted">
                          {formatClock(item.updatedAt)}
                        </span>
                        {item.conversationTitle ? (
                          <span className="truncate text-[11px] text-muted">
                            · {item.conversationTitle}
                          </span>
                        ) : null}
                      </div>

                      <p className="text-sm font-medium text-ink">
                        提问：{item.prompt || "（无提问文本）"}
                      </p>

                      {item.comment ? (
                        <p
                          className={cn(
                            "rounded-md px-2.5 py-1.5 text-xs",
                            isDown
                              ? "border border-danger/20 bg-dangersoft/60 text-danger"
                              : "border border-success/20 bg-successsoft/60 text-success",
                          )}
                        >
                          用户反馈：{item.comment}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant={isDown ? "primary" : "outline"}
                        className="gap-1"
                        onClick={() => onPromoteToExample(item)}
                      >
                        <Code2 className="h-3.5 w-3.5" />
                        {isDown ? "纠错并沉淀 SQL" : "沉淀为 SQL 示例"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        onClick={() => onPromoteToMetric(item)}
                      >
                        <BookOpen className="h-3.5 w-3.5" />
                        沉淀指标
                      </Button>
                      {item.reviewStatus === "pending" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1 text-muted"
                          disabled={statusMutation.isPending}
                          onClick={() =>
                            statusMutation.mutate({ id: item.id, reviewStatus: "dismissed" })
                          }
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          忽略
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1 text-muted"
                          disabled={statusMutation.isPending}
                          onClick={() =>
                            statusMutation.mutate({ id: item.id, reviewStatus: "pending" })
                          }
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          标为待处理
                        </Button>
                      )}
                    </div>
                  </div>

                  {item.sqlQueries.length > 0 ? (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-medium text-muted">
                        该轮执行的 SQL（{item.sqlQueries.length}）
                      </p>
                      {item.sqlQueries.map((entry, index) => (
                        <div
                          key={`${item.id}-sql-${index}`}
                          className="rounded-lg border border-line bg-subtle/50 p-2.5"
                        >
                          <div className="mb-1 flex items-center gap-2 text-[10px] text-muted">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 font-medium",
                                entry.status === "ok" ? "text-success" : "text-danger",
                              )}
                            >
                              {entry.status === "ok" ? (
                                <CheckCircle2 className="h-3 w-3" />
                              ) : (
                                <XCircle className="h-3 w-3" />
                              )}
                              {entry.status}
                            </span>
                            {entry.rowCount != null ? <span>{entry.rowCount} 行</span> : null}
                            {entry.errorMessage ? (
                              <span className="truncate text-danger">{entry.errorMessage}</span>
                            ) : null}
                          </div>
                          <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-inksoft whitespace-pre-wrap">
                            {entry.sql}
                          </pre>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted">该轮对话未执行数据库 SQL 查询。</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
