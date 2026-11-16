import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DatasourceSummary, ScheduledTaskInput, ScheduledTaskSummary } from "../../lib/api";
import { listModels } from "../../lib/api";
import { queryKeys } from "../../lib/query";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

type Frequency = "daily" | "weekly" | "monthly" | "custom";

interface TaskDialogProps {
  open: boolean;
  task: ScheduledTaskSummary | null;
  datasources: DatasourceSummary[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: ScheduledTaskInput) => void;
}

function inferFrequency(cron: string): Frequency {
  const parts = cron.split(" ");
  if (parts.length < 5) return "custom";
  const [, , day, month, weekday] = parts;
  if (month === "*" && weekday === "*" && day === "*") return "daily";
  if (month === "*" && weekday === "1" && day === "*") return "weekly";
  if (month === "*" && weekday === "*" && day === "1") return "monthly";
  return "custom";
}

function timeFromCron(cron: string): string {
  const [minute, hour] = cron.split(" ");
  if (minute === undefined || hour === undefined) return "09:00";
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function buildCron(frequency: Frequency, time: string, custom: string): string {
  if (frequency === "custom") return custom.trim();
  const [hour, minute] = time.split(":");
  if (hour === undefined || minute === undefined) return custom.trim();
  if (frequency === "daily") return `${Number(minute)} ${Number(hour)} * * *`;
  if (frequency === "weekly") return `${Number(minute)} ${Number(hour)} * * 1`;
  return `${Number(minute)} ${Number(hour)} 1 * *`;
}

export function TaskDialog({
  open,
  task,
  datasources,
  saving,
  error,
  onClose,
  onSave,
}: TaskDialogProps) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [datasourceId, setDatasourceId] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [time, setTime] = useState("09:00");
  const [customCron, setCustomCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
  );
  const [modelId, setModelId] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const modelsQuery = useQuery({ queryKey: queryKeys.models, queryFn: listModels, enabled: open });

  const defaultTimezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    [],
  );

  useEffect(() => {
    if (!open) return;
    setName(task?.name ?? "");
    setPrompt(task?.prompt ?? "");
    setDatasourceId(task?.datasourceId ?? datasources[0]?.id ?? "");
    setFrequency(task ? inferFrequency(task.cronExpression) : "daily");
    setTime(task ? timeFromCron(task.cronExpression) : "09:00");
    setCustomCron(task?.cronExpression ?? "0 9 * * *");
    setTimezone(task?.timezone ?? defaultTimezone);
    setModelId(task?.modelId ?? "");
    setLocalError(null);
  }, [open, task, datasources, defaultTimezone]);

  const submit = () => {
    if (!name.trim() || !prompt.trim() || !datasourceId) {
      setLocalError("请填写名称、问题并选择数据源");
      return;
    }
    const cron = buildCron(frequency, time, customCron);
    if (cron.split(" ").length !== 5) {
      setLocalError("cron 必须是 5 段表达式，例如 0 9 * * *");
      return;
    }
    setLocalError(null);
    onSave({
      name: name.trim(),
      prompt: prompt.trim(),
      datasourceId,
      cronExpression: cron,
      timezone: timezone.trim(),
      modelId: modelId || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{task ? "编辑定时任务" : "新建定时任务"}</DialogTitle>
          <DialogDescription>自动执行问题并生成报告，结果发送到站内信。</DialogDescription>
        </DialogHeader>

        <div className="max-h-[calc(90vh-8rem)] space-y-3 overflow-y-auto px-4 py-3">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink">名称</span>
            <Input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink">数据源</span>
            <select
              className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-[13px] text-ink"
              value={datasourceId}
              onChange={(event) => setDatasourceId(event.target.value)}
            >
              {datasources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.type}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-ink">问题</span>
            <textarea
              className="min-h-20 w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] text-ink outline-none focus:border-brand"
              value={prompt}
              maxLength={1000}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：统计昨天的订单量和金额"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink">频率</span>
              <select
                className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-[13px] text-ink"
                value={frequency}
                onChange={(event) => setFrequency(event.target.value as Frequency)}
              >
                <option value="daily">每天</option>
                <option value="weekly">每周一</option>
                <option value="monthly">每月 1 日</option>
                <option value="custom">自定义 cron</option>
              </select>
            </label>
            {frequency === "custom" ? (
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-ink">cron</span>
                <Input
                  value={customCron}
                  onChange={(event) => setCustomCron(event.target.value)}
                  placeholder="0 9 * * *"
                />
              </label>
            ) : (
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-ink">时间</span>
                <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
              </label>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink">时区</span>
              <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-ink">模型</span>
              <select
                className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-[13px] text-ink"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              >
                <option value="">跟随系统默认</option>
                {(modelsQuery.data?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {localError || error ? (
            <p className="rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-[12px] text-danger">
              {localError ?? error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving} onClick={submit}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
