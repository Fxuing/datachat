import { ChevronRight, Plus } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import type { DepartmentNode } from "../../lib/api";

interface DepartmentTreeProps {
  nodes: DepartmentNode[];
  selectedId: string | null;
  expanded: ReadonlySet<string>;
  onSelect: (node: DepartmentNode) => void;
  onToggle: (id: string) => void;
  onAddChild: (node: DepartmentNode) => void;
}

export function DepartmentTree({
  nodes,
  selectedId,
  expanded,
  onSelect,
  onToggle,
  onAddChild,
}: DepartmentTreeProps) {
  const renderNode = (node: DepartmentNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const isOpen = expanded.has(node.id);
    return (
      <li key={node.id}>
        <div
          className={cn(
            "group flex items-center gap-1 rounded-md pr-1 text-sm",
            selectedId === node.id ? "bg-brandsoft text-brandtext" : "text-ink hover:bg-subtle",
          )}
          style={{ paddingLeft: `${depth * 14 + 4}px` }}
        >
          <button
            type="button"
            aria-label={isOpen ? "收起" : "展开"}
            aria-expanded={isOpen}
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted",
              !hasChildren && "invisible",
            )}
            onClick={() => onToggle(node.id)}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")} />
          </button>
          <button
            type="button"
            className="min-w-0 flex-1 truncate py-1.5 text-left"
            onClick={() => onSelect(node)}
          >
            {node.name}
            {node.status === "archived" ? (
              <span className="ml-1 text-[10px] text-muted">（已归档）</span>
            ) : null}
            <span className="ml-1 text-[10px] text-muted">{node.memberCount} 人</span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
            aria-label={`在 ${node.name} 下新建子部门`}
            onClick={() => onAddChild(node)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        {hasChildren && isOpen ? (
          <ul>{node.children.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  };

  if (nodes.length === 0) {
    return <p className="px-2 py-6 text-center text-xs text-muted">还没有部门，先新建根部门。</p>;
  }

  return <ul aria-label="部门树">{nodes.map((node) => renderNode(node, 0))}</ul>;
}
