import { useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import type { ChatMessage, ChatModelInfo } from "../../lib/api";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

export interface RetryActionsProps {
  message: ChatMessage;
  models: ChatModelInfo[];
  retrying: boolean;
  disabled?: boolean;
  onRetry: (message: ChatMessage, modelId?: string) => void;
}

/** Retry a failed turn as-is, or with a different model. */
export function RetryActions({
  message,
  models,
  retrying,
  disabled = false,
  onRetry,
}: RetryActionsProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-[11px]"
        disabled={disabled || retrying}
        onClick={() => onRetry(message)}
      >
        <RotateCcw className="h-3 w-3" />
        {retrying ? "重试中…" : "重试"}
      </Button>
      {models.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-[11px] text-inksoft"
              disabled={disabled || retrying}
            >
              换模型重试
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-64">
            <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
              用这个模型重新回答
            </p>
            <div className="max-h-60 space-y-0.5 overflow-auto pr-0.5">
              {models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onRetry(message, model.id);
                  }}
                  className="flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors hover:bg-subtle"
                >
                  <span className="truncate text-xs text-ink">{model.name}</span>
                  <span className="truncate text-[10px] text-muted">{model.providerName}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
