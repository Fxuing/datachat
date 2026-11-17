import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Plus } from "lucide-react";
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
import { Button } from "../components/ui/button";
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
  if (status === "success") return "text-emerald-600";
  if (status === "failed") return "text-danger";
  if (status === "skipped") return "text-amber-600";
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
  const canChat = useCan("chat.use");
  const canReport = useCan("report.create");
  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const tasksQuery = useQuery({ queryKey: queryKeys.scheduledTasks, queryFn: listScheduledTasks });
  const datasourcesQuery = useQuery({ queryKey: queryKeys.datasources, queryFn: listDatasources });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTaskSummary | null>(null);
  const [historyTask, setHistoryTask] = useState<ScheduledTaskSummary | null>(null);
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
    },
    onError: (err) => setError(describeApiError(err, "操作失败")),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => runScheduledTask(id),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err) => setError(describeApiError(err, "操作失败")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteScheduledTask(id),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err) => setError(describeApiError(err, "操作失败")),
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const enabledCount = tasks.filter((task) => task.enabled === 1).length;

  return (
    <AppShell
      user={meQuery.data?.user ?? { id: "", username: "", displayName: null, role: "user", status: "active" }}
      sidebar={
        <div className="p-2">
          {/* Router link: a plain anchor would reload the whole app. */}
          <Link
            to="/chat"
            className="block rounded-lg px-2 py-1.5 text-[13px] text-inksoft hover:bg-subtle hover:text-ink"
          >
            ← 返回对话
          </Link>
        </div>
      }
      topbar={
        <div className="flex min-w-0 items-center gap-2">
          <Clock className="h-4 w-4 text-muted" />
          <h1 className="truncate text-sm font-semibold text-ink">定时任务</h1>
        </div>
      }
    >
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

        {error ? (
          <p className="mt-4 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-[12px] text-danger">
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
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-line bg-subtle/60 text-[11px] text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">任务</th>
                  <th className="px-4 py-2.5 font-medium">计划</th>
                  <th className="px-4 py-2.5 font-medium">下次</th>
                  <th className="px-4 py-2.5 font-medium">最近</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
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
                    <td className="px-4 py-3 text-[12px] text-inksoft">
                      {task.enabled ? formatDateTime(task.nextRunAt) : "已暂停"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("text-[12px]", statusTone(task.lastStatus))}>
                        {task.lastRun ? statusLabels[task.lastRun.status] ?? task.lastRun.status : "未运行"}
                      </span>
                      {task.consecutiveFailures > 0 ? (
                        <p className="text-[10px] text-danger">连续失败 {task.consecutiveFailures} 次</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canChat || runMutation.isPending}
                          onClick={() => runMutation.mutate(task.id)}
                        >
                          立即执行
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
                            if (window.confirm(`删除任务“${task.name}”？`)) deleteMutation.mutate(task.id);
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

