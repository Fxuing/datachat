import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import type { ChatModelInfo } from "../../lib/api";

export const THINKING_LEVELS = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "极简" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" },
] as const;

function groupByProvider(models: ChatModelInfo[]): Array<[string, ChatModelInfo[]]> {
  const groups = new Map<string, ChatModelInfo[]>();
  for (const model of models) {
    const list = groups.get(model.providerName) ?? [];
    list.push(model);
    groups.set(model.providerName, list);
  }
  return [...groups.entries()];
}

export interface ModelPickerProps {
  models: ChatModelInfo[];
  modelId: string;
  thinkingLevel: string;
  disabled: boolean;
  onModelChange: (modelId: string) => void;
  onThinkingChange: (level: string) => void;
}

/**
 * One control for the two per-conversation knobs: which model answers, and how hard it
 * thinks. The trigger reads "Model · High" so the current pairing is visible at a glance.
 */
export function ModelPicker({
  models,
  modelId,
  thinkingLevel,
  disabled,
  onModelChange,
  onThinkingChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const selected =
    models.find((model) => model.id === modelId) ??
    models.find((model) => model.modelId === modelId);
  const thinkingLabel =
    THINKING_LEVELS.find((level) => level.value === thinkingLevel)?.label ?? "关闭";
  const label = selected?.name ?? (models.length > 0 ? "选择模型" : "未配置模型");

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || models.length === 0}
          aria-label="选择模型与思考等级"
          className="h-8 max-w-[15rem] shrink-0 gap-1 rounded-lg px-2 text-[11px] font-normal text-inksoft"
        >
          <span className="truncate">{label}</span>
          <span className="shrink-0 text-muted">{" · "}</span>
          <span className="shrink-0">{thinkingLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
        </PopoverTrigger>
      </TooltipTrigger>
      <PopoverContent side="top" align="start" className="w-[17rem]">
        <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
          模型
        </p>
        <div className="max-h-56 space-y-0.5 overflow-auto pr-0.5">
          {groupByProvider(models).map(([providerName, providerModels]) => (
            <div key={providerName}>
              <p className="truncate px-2 pb-0.5 pt-1.5 text-[10px] text-muted">{providerName}</p>
              {providerModels.map((model) => {
                const active = model.id === selected?.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => {
                      onModelChange(model.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                      active
                        ? "bg-brandsoft text-brandtext"
                        : "text-ink hover:bg-subtle",
                    )}
                  >
                    <span className="flex-1 truncate">{model.name}</span>
                    {active ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="my-2 border-t border-line" />
        <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
          思考等级
        </p>
        <div className="grid grid-cols-4 gap-1">
          {THINKING_LEVELS.map((level) => {
            const active = level.value === thinkingLevel;
            return (
              <button
                key={level.value}
                type="button"
                onClick={() => {
                  onThinkingChange(level.value);
                  setOpen(false);
                }}
                className={cn(
                  "rounded-md px-1.5 py-1 text-[11px] transition-colors",
                  active
                    ? "bg-brand text-white"
                    : "text-inksoft hover:bg-subtle",
                )}
              >
                {level.label}
              </button>
            );
          })}
        </div>
      </PopoverContent>
      </Popover>
      <TooltipContent side="top" align="start">模型与思考等级（对下一次提问生效）</TooltipContent>
    </Tooltip>
  );
}
