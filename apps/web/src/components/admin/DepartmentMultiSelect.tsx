import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Search, Star, X } from "lucide-react";
import type { DepartmentRow } from "../../lib/api";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export interface DepartmentMultiSelectProps {
  /** Flat department rows; `parentId` is used to build the tree and paths. */
  departments: DepartmentRow[];
  value: ReadonlySet<string>;
  primaryId: string | null;
  onChange: (ids: string[], primaryId: string | null) => void;
  disabled?: boolean;
}

/** Searchable department tree with multi-select and an optional primary marker. */
export function DepartmentMultiSelect({
  departments,
  value,
  primaryId,
  onChange,
  disabled = false,
}: DepartmentMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const byId = useMemo(() => new Map(departments.map((row) => [row.id, row])), [departments]);

  const paths = useMemo(() => {
    const result = new Map<string, string>();
    for (const row of departments) {
      const parts: string[] = [];
      const seen = new Set<string>();
      let current: DepartmentRow | undefined = row;
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        parts.unshift(current.name);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      result.set(row.id, parts.join(" / "));
    }
    return result;
  }, [byId, departments]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, DepartmentRow[]>();
    for (const row of departments) {
      const parentId = row.parentId && byId.has(row.parentId) ? row.parentId : null;
      const list = map.get(parentId) ?? [];
      list.push(row);
      map.set(parentId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "zh"));
    }
    return map;
  }, [byId, departments]);

  // Roots start collapsed so a large org tree does not open as a wall of rows.
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized || departments.length === 0) return;
    const roots = departments.filter(
      (row) =>
        (!row.parentId || !byId.has(row.parentId)) &&
        (childrenByParent.get(row.id) ?? []).length > 0,
    );
    setCollapsed(new Set(roots.map((row) => row.id)));
    setInitialized(true);
  }, [byId, childrenByParent, departments, initialized]);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return null;
    return new Set(
      departments
        .filter(
          (row) =>
            row.name.toLowerCase().includes(needle) ||
            row.code.toLowerCase().includes(needle) ||
            (paths.get(row.id) ?? "").toLowerCase().includes(needle),
        )
        .map((row) => row.id),
    );
  }, [departments, needle, paths]);

  // While filtering, keep ancestors so the matched nodes stay in context.
  const visibleIds = useMemo(() => {
    if (!matches) return null;
    const ids = new Set<string>();
    for (const id of matches) {
      let current: DepartmentRow | undefined = byId.get(id);
      while (current && !ids.has(current.id)) {
        ids.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
    }
    return ids;
  }, [byId, matches]);

  const selected = departments.filter((row) => value.has(row.id));
  const collapsibleIds = departments.filter((row) => (childrenByParent.get(row.id) ?? []).length > 0);

  const commit = (ids: Set<string>, primary: string | null) => {
    const nextPrimary = primary && ids.has(primary) ? primary : (ids.values().next().value ?? null);
    onChange([...ids], nextPrimary);
  };

  const toggle = (id: string) => {
    const ids = new Set(value);
    if (ids.has(id)) {
      ids.delete(id);
      commit(ids, primaryId === id ? null : primaryId);
    } else {
      ids.add(id);
      commit(ids, primaryId ?? id);
    }
  };

  const toggleCollapsed = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clear = () => {
    onChange([], null);
    setQuery("");
  };

  const renderRows = (
    parentId: string | null,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): React.ReactNode[] => {
    const rows = childrenByParent.get(parentId) ?? [];
    const out: React.ReactNode[] = [];
    for (const row of rows) {
      if (ancestors.has(row.id)) continue;
      if (visibleIds && !visibleIds.has(row.id)) continue;
      const path = paths.get(row.id) ?? row.name;
      const checked = value.has(row.id);
      const isPrimary = primaryId === row.id;
      const children = (childrenByParent.get(row.id) ?? []).filter(
        (child) => !visibleIds || visibleIds.has(child.id),
      );
      const hasChildren = children.length > 0;
      const expanded = visibleIds ? true : !collapsed.has(row.id);
      const isMatch = matches?.has(row.id) ?? false;

      out.push(
        <div
          key={row.id}
          className="flex items-center gap-0.5 rounded-md pr-1 hover:bg-subtle"
          style={{ paddingLeft: `${depth * 14}px` }}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${expanded ? "收起" : "展开"} ${path}`}
              aria-expanded={expanded}
              className="rounded p-0.5 text-muted hover:bg-line/60 hover:text-ink"
              onClick={() => toggleCollapsed(row.id)}
            >
              <ChevronRight
                className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")}
              />
            </button>
          ) : (
            <span className="w-[18px] shrink-0" aria-hidden />
          )}
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 text-xs text-ink">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 shrink-0 accent-brand"
              checked={checked}
              disabled={disabled}
              aria-label={`选择 ${path}`}
              onChange={() => toggle(row.id)}
            />
            {checked ? <Check className="h-3 w-3 shrink-0 text-brand" aria-hidden /> : null}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                isMatch && "font-medium text-brand",
                row.status === "archived" && "text-muted line-through",
              )}
            >
              {row.name}
            </span>
            <span className="shrink-0 rounded bg-subtle px-1 py-0.5 text-[10px] text-muted">
              {row.code}
            </span>
          </label>
          {checked ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`设 ${path} 为主部门`}
                  aria-pressed={isPrimary}
                  disabled={disabled}
                  className={cn(
                    "rounded p-1 transition-colors hover:bg-subtle",
                    isPrimary ? "text-warning" : "text-muted hover:text-ink",
                  )}
                  onClick={() => commit(new Set(value), row.id)}
                >
                  <Star className="h-3.5 w-3.5" fill={isPrimary ? "currentColor" : "none"} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {isPrimary ? "主部门" : "设为主部门"}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>,
      );

      if (hasChildren && expanded) {
        const nextAncestors = new Set(ancestors).add(row.id);
        out.push(...renderRows(row.id, depth + 1, nextAncestors));
      }
    }
    return out;
  };

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-label="选择部门"
            disabled={disabled}
            className="h-8 w-full justify-between gap-2 px-2.5 font-normal"
          >
            <span className={cn("truncate text-left", selected.length === 0 && "text-muted")}>
              {selected.length === 0 ? "选择部门" : `已选 ${selected.length} 个部门`}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
          <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按名称、编码或上级筛选"
              aria-label="筛选部门"
              className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
            />
            {query ? (
              <button
                type="button"
                aria-label="清除筛选"
                className="text-muted hover:text-ink"
                onClick={() => setQuery("")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <div className="h-60 overflow-y-auto p-1">
            {matches && matches.size === 0 ? (
              <p className="flex h-full items-center justify-center text-xs text-muted">
                没有匹配的部门
              </p>
            ) : departments.length === 0 ? (
              <p className="flex h-full items-center justify-center text-xs text-muted">还没有部门</p>
            ) : (
              renderRows(null, 0, new Set())
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line px-2.5 py-2 text-[11px] text-muted">
            <span>
              {value.size} 已选
              {primaryId ? " · 1 主部门" : ""}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={query.length > 0 || collapsibleIds.length === 0}
                onClick={() =>
                  setCollapsed((current) =>
                    current.size > 0 ? new Set() : new Set(collapsibleIds.map((row) => row.id)),
                  )
                }
              >
                {collapsed.size > 0 ? "全部展开" : "全部收起"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={value.size === 0}
                onClick={clear}
              >
                清空
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setOpen(false)}
              >
                完成
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {/* 固定一行高度，避免增删部门时弹窗高度变化导致整体上下跳动。 */}
      <div className="flex h-7 items-center gap-1 overflow-x-auto whitespace-nowrap">
        {selected.length === 0 ? (
          <span className="text-[11px] text-muted">未选择部门</span>
        ) : (
          selected.map((row) => (
            <Tooltip key={row.id}>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
                    primaryId === row.id
                      ? "border-warning/40 bg-warningsoft text-ink"
                      : "border-line bg-subtle text-inksoft",
                  )}
                >
                  {primaryId === row.id ? (
                    <Star className="h-3 w-3" fill="currentColor" aria-hidden />
                  ) : null}
                  <span className="truncate">{row.name}</span>
                  <button
                    type="button"
                    aria-label={`移除 ${paths.get(row.id) ?? row.name}`}
                    disabled={disabled}
                    className="rounded p-0.5 text-muted hover:bg-surface hover:text-ink"
                    onClick={() => toggle(row.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              </TooltipTrigger>
              {paths.get(row.id) ? (
                <TooltipContent side="top">{paths.get(row.id)}</TooltipContent>
              ) : null}
            </Tooltip>
          ))
        )}
      </div>
    </div>
  );
}
