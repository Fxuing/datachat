import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  Trash2,
} from "lucide-react";
import type { DatasourceSummary } from "../../lib/api";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const CLOSE_DELAY_MS = 140;

interface MenuItemProps {
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}

function MenuItem({ icon, danger, disabled, onSelect, children }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-inksoft transition-colors",
        "hover:bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-inksoft",
        danger && "text-danger hover:bg-dangersoft hover:text-danger",
      )}
    >
      <span aria-hidden="true" className="[&>svg]:h-3.5 [&>svg]:w-3.5">
        {icon}
      </span>
      {children}
    </button>
  );
}

export interface DatasourceRowActionsProps {
  datasource: DatasourceSummary;
  testing: boolean;
  refreshing: boolean;
  onTest: () => void;
  onRefresh: () => void;
  onViewSchema: () => void;
  onGrants: () => void;
  onScope: () => void;
  onSemantic?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/**
 * Keeps the two frequent actions inline and folds the rest into a hover/click
 * menu, so the table does not turn into a wall of buttons.
 */
export function DatasourceRowActions({
  datasource,
  testing,
  refreshing,
  onTest,
  onRefresh,
  onViewSchema,
  onGrants,
  onScope,
  onSemantic,
  onEdit,
  onDelete,
}: DatasourceRowActionsProps) {
  const [open, setOpen] = useState(false);
  const skipFocusRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  // Small delay so the pointer can cross the gap into the portaled menu.
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => cancelClose, []);

  const choose = (action: () => void) => () => {
    cancelClose();
    setOpen(false);
    action();
  };

  const driverUnavailable = datasource.driverAvailable === false;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {driverUnavailable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button variant="ghost" size="sm" disabled onClick={onTest}>
                {testing ? "测试中…" : "测试连接"}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">驱动插件未加载</TooltipContent>
        </Tooltip>
      ) : (
        <Button variant="ghost" size="sm" disabled={testing} onClick={onTest}>
          {testing ? "测试中…" : "测试连接"}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onEdit}>
        编辑
      </Button>
      <span
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          skipFocusRef.current = true;
          cancelClose();
          setOpen(true);
        }}
        onPointerLeave={scheduleClose}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1"
              aria-label={`更多操作：${datasource.name}`}
              aria-haspopup="menu"
              onClick={(event) => {
                // Own the toggle; the hover-open above must not be undone by
                // Radix's default click toggle racing with it.
                event.preventDefault();
                skipFocusRef.current = false;
                cancelClose();
                setOpen((value) => !value);
              }}
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              更多
            </Button>
          </PopoverTrigger>
          <PopoverContent
            role="menu"
            aria-label={`${datasource.name} 的更多操作`}
            align="end"
            side="bottom"
            sideOffset={4}
            className="w-44 p-1"
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
            onOpenAutoFocus={(event) => {
              // Hover must not steal focus from the table; click and keyboard
              // still move focus into the menu.
              if (skipFocusRef.current) {
                event.preventDefault();
                skipFocusRef.current = false;
              }
            }}
            onCloseAutoFocus={(event) => {
              if (skipFocusRef.current) {
                event.preventDefault();
                skipFocusRef.current = false;
              }
            }}
          >
            <MenuItem icon={<Table2 />} onSelect={choose(onViewSchema)}>
              查看结构
            </MenuItem>
            <MenuItem
              icon={<RefreshCw className={refreshing ? "animate-spin" : undefined} />}
              disabled={refreshing || driverUnavailable}
              onSelect={choose(onRefresh)}
            >
              {refreshing ? "刷新中…" : "刷新 schema"}
            </MenuItem>
            <MenuItem icon={<ShieldCheck />} onSelect={choose(onGrants)}>
              授权
            </MenuItem>
            <MenuItem icon={<SlidersHorizontal />} onSelect={choose(onScope)}>
              行级权限
            </MenuItem>
            {onSemantic ? (
              <MenuItem icon={<BookOpen />} onSelect={choose(onSemantic)}>
                指标与语义层
              </MenuItem>
            ) : null}
            <div role="separator" className="my-1 border-t border-line" />
            <MenuItem icon={<Trash2 />} danger onSelect={choose(onDelete)}>
              删除
            </MenuItem>
          </PopoverContent>
        </Popover>
      </span>
    </div>
  );
}
