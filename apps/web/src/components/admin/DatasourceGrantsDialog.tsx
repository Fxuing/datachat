import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  listAdminUsers,
  listDatasourceGrants,
  replaceDatasourceGrants,
  type DatasourceSummary,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { Button } from "../ui/button";

export interface DatasourceGrantsDialogProps {
  datasource: DatasourceSummary;
  onClose: () => void;
}

export function DatasourceGrantsDialog({ datasource, onClose }: DatasourceGrantsDialogProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers,
    queryFn: listAdminUsers,
  });
  const grantsQuery = useQuery({
    queryKey: queryKeys.datasourceGrants(datasource.id),
    queryFn: () => listDatasourceGrants(datasource.id),
  });

  useEffect(() => {
    if (grantsQuery.data) setSelected(new Set(grantsQuery.data.userIds));
  }, [grantsQuery.data]);

  const save = useMutation({
    mutationFn: (userIds: string[]) => replaceDatasourceGrants(datasource.id, userIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.datasourceGrants(datasource.id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.datasources });
      onClose();
    },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !save.isPending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, save.isPending]);

  const users = (usersQuery.data?.users ?? []).filter((user) => user.status === "active");
  const loading = usersQuery.isPending || grantsQuery.isPending;
  const loadError = usersQuery.isError
    ? describeApiError(usersQuery.error, "加载用户列表失败，请稍后重试。")
    : grantsQuery.isError
      ? describeApiError(grantsQuery.error, "加载授权失败，请稍后重试。")
      : null;
  const saveError = save.isError
    ? describeApiError(save.error, "保存授权失败，请稍后重试。")
    : null;

  const toggle = (userId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onMouseDown={() => {
        if (!save.isPending) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${datasource.name} 的授权`}
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-line bg-surface shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink">授权数据源</h2>
            <p className="truncate text-[11px] text-muted">
              {datasource.name} · 仅列出启用中的用户
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭授权"
            disabled={save.isPending}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loadError ? (
            <p role="alert" className="mb-2 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
              {loadError}
            </p>
          ) : null}
          {saveError ? (
            <p role="alert" className="mb-2 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
              {saveError}
            </p>
          ) : null}
          {loading ? (
            <p className="p-2 text-xs text-muted">正在加载用户…</p>
          ) : users.length === 0 ? (
            <p className="p-2 text-xs text-muted">暂无启用中的用户。</p>
          ) : (
            <ul className="space-y-0.5">
              {users.map((user) => (
                <li key={user.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-subtle">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-brand"
                      checked={selected.has(user.id)}
                      onChange={() => toggle(user.id)}
                    />
                    <span className="text-xs text-inksoft">{user.displayName}</span>
                    <span className="text-[11px] text-muted">@{user.username}</span>
                    {user.role === "admin" ? (
                      <span className="ml-auto rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                        管理员
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
          <Button variant="outline" size="sm" disabled={save.isPending} onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={loading || save.isPending || loadError !== null}
            onClick={() => save.mutate([...selected])}
          >
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  );
}
