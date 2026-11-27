import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Plus, X } from "lucide-react";
import { Link } from "react-router-dom";
import {
  createScheduledTask,
  fetchMe,
  listDatasources,
  listScheduledTasks,
  listScheduledTaskRuns,
  runScheduledTask,
  updateScheduledTask,
  deleteScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskSummary,
} from "../lib/api";
import { AppShell } from "../components/AppShell";
import { ConfirmDialog } from "../components/admin/ConfirmDialog";
import { ConversationSidebar } from "../components/chat/ConversationSidebar";
import { Button } from "../components/ui/button";
import { useToast } from "../components/ui/toast";
import { useCan } from "../hooks/use-access";
import { describeApiError } from "../lib/errors";
import { queryKeys } from "../lib/query";
import { cn, formatDateTime } from "../lib/utils";
import { TaskDialog } from "../components/scheduled/TaskDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

const statusLabels: Record<string, string> = {
  success: "成功",
  failed: "失败",
  skipped: "已跳过",
  running: "执行中",
};

function statusTone(status: string | null): string {
  if (status === "success") return "text-success";
  if (status === "failed") return "text-danger";
  if (status === "skipped") return "text-warning";
  return "text-muted";
}

function scheduleLabel(task: ScheduledTaskSummary): string {
  const [minute, hour, day, month, weekday] = task.cronExpression.split(" ");
  if (month === "*" && weekday === "*" && day === "*" && minute !== undefined && hour !== undefined) {
    return `每天 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  if (month === "*" && weekday === "1" && minute !== undefined && hour !== undefined) {
    return `每周一 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  if (month === "*" && day === "1" && minute !== undefined && hour !== undefined) {
    return `每月 1 日 ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  return task.cronExpression;
}

export default function ScheduledTasksPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canChat = useCan("chat.use");
  const canReport = useCan("report.create");
  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const tasksQuery = useQuery({ queryKey: queryKeys.scheduledTasks, queryFn: listScheduledTasks });
  const datasourcesQuery = useQuery({ queryKey: queryKeys.datasources, queryFn: listDatasources });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTaskSummary | null>(null);
  const [historyTask, setHistoryTask] = useState<ScheduledTaskSummary | null>(null);
  const [deletingTask, setDeletingTask] = useState<ScheduledTaskSummary | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [togglingTaskId, setTogglingTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks });
  };

  const saveMutation = useMutation({
    mutationFn: async (input: ScheduledTaskInput) => {
      if (editing) return updateScheduledTask(editing.id, input);
      return createScheduledTask(input);
    },
    onSuccess: async () => {
      setDialogOpen(false);
      setEditing(null);
      setError(null);
      await invalidate();
      toast.success(editing ? "定时任务已更新" : "定时任务已创建");
    },
    onError: (err) => setError(describeApiError(err, "操作失败")),
  });

  const runMutation = useMutation({
    mutationFn: (task: ScheduledTaskSummary) => runScheduledTask(task.id),
    onMutate: (task) => {
      setRunningTaskId(task.id);
      setNotice(null);
      setError(null);
    },
    onSuccess: async (_data, task) => {
      setError(null);
      const msg = `已触发「${task.name}」执行，结果将通过站内通知发送。`;
      setNotice(msg);
      toast.info(msg);
      await invalidate();
    },
    onError: (err) => setError(describeApiError(err, "操作失败")),
    onSettled: () => setRunningTaskId(null),
  });

  const toggleMutation = useMutation({
    mutationFn: (task: ScheduledTaskSummary) =>
      updateScheduledTask(task.id, { enabled: task.enabled !== 1 }),
    onMutate: (task) => {
      setTogglingTaskId(task.id);
      setError(null);
    },
    onSuccess: async (_data, task) => {
      await invalidate();
      toast.success(task.enabled === 1 ? `已暂停「${task.name}」` : `已启用「${task.name}」`);
    },
    onError: (err) => setError(describeApiError(err, "状态更新失败")),
    onSettled: () => setTogglingTaskId(null),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteScheduledTask(id),
    onSuccess: async () => {
      setDeletingTask(null);
      setError(null);
      await invalidate();
      toast.success("定时任务已删除");
    },
    onError: (err) => setError(describeApiError(err, "操作失败")),
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const enabledCount = tasks.filter((task) => task.enabled === 1).length;

  return (
    <AppShell
      user={meQuery.data?.user ?? { id: "", username: "", displayName: null, role: "user", status: "active" }}
      sidebar={<ConversationSidebar datasources={datasourcesQuery.data?.datasources ?? []} />}
      topbar={
        <div className="flex min-w-0 items-center gap-2">
          <Clock className="h-4 w-4 text-muted" />
          <h1 className="truncate text-sm font-semibold text-ink">定时任务</h1>
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[13px] text-muted">
                按计划自动运行问题，结果保存为报告并发送站内信。
              </p>
              <p className="mt-1 text-[11px] text-muted">
                {tasks.length} 个任务 · {enabledCount} 个启用
              </p>
            </div>
            <Button
              size="sm"
              disabled={!canChat || !canReport}
              onClick={() => {
                setEditing(null);
                setError(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> 新建任务
            </Button>
          </div>

          {!canChat || !canReport ? (
            <p className="mt-4 rounded-lg border border-line bg-subtle px-3 py-2 text-[12px] text-muted">
              当前角色没有{!canChat ? "对话" : "生成报告"}权限，无法创建定时任务。
            </p>
          ) : null}

          {notice ? (
            <div
              role="status"
              className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-success/20 bg-successsoft px-3 py-2 text-[12px] text-success"
            >
              <span>{notice}</span>
              <button
                type="button"
                aria-label="关闭提示"
                className="rounded p-0.5 text-success/70 hover:bg-success/10 hover:text-success"
                onClick={() => setNotice(null)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-danger/20 bg-dangersoft px-3 py-2 text-[12px] text-danger"
            >
              {error}
            </p>
          ) : null}

          {tasksQuery.isPending ? (
            <p className="mt-8 text-center text-sm text-muted">正在加载任务…</p>
          ) : tasksQuery.isError ? (
            <div className="mt-8 text-center text-sm text-muted">
              加载失败
              <button className="ml-2 text-brand" onClick={() => void tasksQuery.refetch()}>
                重试
              </button>
            </div>
          ) : tasks.length === 0 ? (
            <div className="mt-8 rounded-xl border border-dashed border-line bg-surface p-10 text-center">
              <Clock className="mx-auto h-8 w-8 text-muted" />
              <p className="mt-3 text-sm font-medium text-ink">还没有定时任务</p>
              <p className="mt-1 text-[12px] text-muted">
                创建一个任务，让常用问题每天/每周自动生成报告。
              </p>
            </div>
          ) : (
            <div className="mt-5 overflow-hidden rounded-xl border border-line bg-surface">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead className="border-b border-line bg-subtle/60 text-[11px] text-muted">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">任务</th>
                      <th className="px-4 py-2.5 font-medium">计划</th>
                      <th className="px-4 py-2.5 font-medium">状态</th>
                      <th className="px-4 py-2.5 font-medium">下次</th>
                      <th className="px-4 py-2.5 font-medium">最近</th>
                      <th className="px-4 py-2.5 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => {
                      const runningThis = runningTaskId === task.id;
                      return (
                        <tr key={task.id} className="border-b border-line/70 last:border-0">
                          <td className="px-4 py-3">
                            <p className="font-medium text-ink">{task.name}</p>
                            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted">{task.prompt}</p>
                            <p className="mt-0.5 text-[10px] text-muted">{task.datasourceName}</p>
                          </td>
                          <td className="px-4 py-3 text-[12px] text-inksoft">
                            <p>{scheduleLabel(task)}</p>
                            <p className="text-[10px] text-muted">{task.timezone}</p>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={task.enabled === 1}
                              aria-label={`${task.enabled === 1 ? "暂停" : "启用"} ${task.name}`}
                              disabled={!canReport || togglingTaskId === task.id}
                              onClick={() => toggleMutation.mutate(task)}
                              className={cn(
                                "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                                task.enabled === 1 ? "bg-brand" : "bg-line",
                              )}
                            >
                              <span
                                className={cn(
                                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
                                  task.enabled === 1 ? "left-[18px]" : "left-0.5",
                                )}
                              />
                            </button>
                          </td>
                          <td className="px-4 py-3 text-[12px] text-inksoft">
                            {task.enabled ? formatDateTime(task.nextRunAt) : "已暂停"}
                          </td>
                          <td className="px-4 py-3">
                            <span className={cn("text-[12px]", statusTone(task.lastStatus))}>
                              {task.lastRun
                                ? statusLabels[task.lastRun.status] ?? task.lastRun.status
                                : "未运行"}
                            </span>
                            {task.consecutiveFailures > 0 ? (
                              <p className="text-[10px] text-danger">
                                连续失败 {task.consecutiveFailures} 次
                              </p>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={!canChat || runningThis}
                                onClick={() => runMutation.mutate(task)}
                              >
                                {runningThis ? "执行中…" : "立即执行"}
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setHistoryTask(task)}>
                                历史
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={!canReport}
                                onClick={() => {
                                  setEditing(task);
                                  setError(null);
                                  setDialogOpen(true);
                                }}
                              >
                                编辑
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-danger"
                                disabled={!canReport}
                                onClick={() => {
                                  deleteMutation.reset();
                                  setDeletingTask(task);
                                }}
                              >
                                删除
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <TaskDialog
        open={dialogOpen}
        task={editing}
        datasources={datasourcesQuery.data?.datasources ?? []}
        saving={saveMutation.isPending}
        error={error}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSave={(input) => saveMutation.mutate(input)}
      />

      {deletingTask ? (
        <ConfirmDialog
          title="删除定时任务"
          description={`确定删除任务“${deletingTask.name}”吗？删除后不再自动执行，且无法恢复。`}
          confirmLabel={deleteMutation.isPending ? "删除中…" : "删除"}
          variant="danger"
          pending={deleteMutation.isPending}
          error={deleteMutation.isError ? describeApiError(deleteMutation.error, "删除失败") : null}
          onConfirm={() => deleteMutation.mutate(deletingTask.id)}
          onCancel={() => {
            deleteMutation.reset();
            setDeletingTask(null);
          }}
        />
      ) : null}

      <TaskHistoryDialog task={historyTask} onClose={() => setHistoryTask(null)} />
    </AppShell>
  );
}

function TaskHistoryDialog({
  task,
  onClose,
}: {
  task: ScheduledTaskSummary | null;
  onClose: () => void;
}) {
  const runsQuery = useQuery({
    queryKey: task ? queryKeys.scheduledRuns(task.id) : ["scheduled-runs", "none"],
    queryFn: () => listScheduledTaskRuns(task!.id),
    enabled: Boolean(task),
  });
  return (
    <Dialog open={Boolean(task)} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{task ? `历史 · ${task.name}` : "历史"}</DialogTitle>
          <DialogDescription>最近 50 次运行记录。</DialogDescription>
        </DialogHeader>
      {runsQuery.isPending ? (
        <p className="text-sm text-muted">加载中…</p>
      ) : (runsQuery.data?.runs.length ?? 0) === 0 ? (
        <p className="text-sm text-muted">还没有运行记录。</p>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[10px] text-muted">
              <tr>
                <th className="py-1 font-medium">时间</th>
                <th className="py-1 font-medium">触发</th>
                <th className="py-1 font-medium">状态</th>
                <th className="py-1 font-medium">报告</th>
              </tr>
            </thead>
            <tbody>
              {runsQuery.data?.runs.map((run) => (
                <tr key={run.id} className="border-t border-line/60">
                  <td className="py-1.5 text-inksoft">{formatDateTime(run.createdAt)}</td>
                  <td className="py-1.5 text-muted">{run.trigger === "manual" ? "手动" : "计划"}</td>
                  <td className={cn("py-1.5", statusTone(run.status))}>
                    {statusLabels[run.status] ?? run.status}
                  </td>
                  <td className="py-1.5">
                    {run.reportId ? (
                      <Link className="text-brand hover:underline" to={`/reports/${run.reportId}`}>
                        查看
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </DialogContent>
    </Dialog>
  );
}

