import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Shield } from "lucide-react";
import {
  FUNCTIONAL_PERMISSIONS,
  PERMISSION_GROUPS,
  isSystemPermission,
  type Permission,
} from "@datachat/shared";
import { AdminShell } from "../../components/admin/AdminShell";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { PageSpinner } from "../../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import {
  createRole,
  deleteRole,
  fetchMe,
  getRole,
  listRoles,
  updateRole,
  type RoleDetail,
  type RoleInput,
  type RoleSummary,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";

/** System permissions stay admin-only, so editors never offer them. */
const OFFERED_GROUPS = PERMISSION_GROUPS.map((group) => ({
  label: group.label,
  permissions: group.permissions.filter(
    (entry) => !isSystemPermission(entry.permission),
  ),
})).filter((group) => group.permissions.length > 0);

const labelClass = "block text-xs font-medium text-muted";

function toggleValue<T>(current: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

interface RoleEditorProps {
  /** null creates a new role. */
  role: RoleDetail | null;
  saving: boolean;
  error: string | null;
  onSave: (input: RoleInput) => void;
  onCancel: () => void;
}

function RoleEditor({
  role,
  saving,
  error,
  onSave,
  onCancel,
}: RoleEditorProps) {
  const builtin = role?.builtin ?? false;
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [permissions, setPermissions] = useState<ReadonlySet<Permission>>(
    () => new Set(role?.permissions ?? []),
  );

  const submit = () => {
    if (saving || name.trim() === "") return;
    onSave({
      name: name.trim(),
      description: description.trim() === "" ? null : description.trim(),
      permissions: FUNCTIONAL_PERMISSIONS.filter((permission) => permissions.has(permission)),
    });
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        ) : null}

        <div className="space-y-1.5">
          <label className={labelClass} htmlFor="role-name">
            名称
          </label>
          <Input
            id="role-name"
            value={name}
            maxLength={40}
            disabled={builtin || saving}
            placeholder="例如：财务分析师"
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
          {builtin ? (
            <p className="text-[11px] text-muted">内置角色不可改名。</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <label className={labelClass} htmlFor="role-description">
            描述
          </label>
          <Input
            id="role-description"
            value={description}
            maxLength={200}
            disabled={saving}
            placeholder="一句话说明该角色的用途（可选）"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="space-y-3">
          {OFFERED_GROUPS.map((group) => (
            <fieldset key={group.label} className="space-y-1.5">
              <legend className="text-xs font-medium text-muted">{group.label}</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {group.permissions.map((entry) => (
                  <label
                    key={entry.permission}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-inksoft hover:bg-subtle"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-brand"
                      checked={permissions.has(entry.permission)}
                      disabled={saving}
                      onChange={() =>
                        setPermissions((current) => toggleValue(current, entry.permission))
                      }
                    />
                    {entry.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <p className="text-[11px] text-muted">
            角色只控制功能权限，系统权限仅内置管理员拥有；数据源访问请在「数据源 → 授权」中配置。
          </p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={saving || name.trim() === ""}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export default function RolesPage() {
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<"new" | string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RoleSummary | null>(null);

  const editingId = draft !== null && draft !== "new" ? draft : null;

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const rolesQuery = useQuery({ queryKey: queryKeys.roles, queryFn: listRoles });
  const detailQuery = useQuery({
    queryKey: queryKeys.role(editingId ?? "new"),
    queryFn: () => getRole(editingId as string),
    enabled: editingId !== null,
  });

  const saveMutation = useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: RoleInput }) =>
      id ? updateRole(id, input) : createRole(input),
    onSuccess: (_result, variables) => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.roles });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      if (variables.id) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.role(variables.id) });
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRole(id),
    onSuccess: () => {
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.roles });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });

  const openCreate = () => {
    saveMutation.reset();
    setDraft("new");
  };

  const openEdit = (id: string) => {
    saveMutation.reset();
    setDraft(id);
  };

  const closeEditor = () => {
    setDraft(null);
    saveMutation.reset();
  };

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const roles = rolesQuery.data?.roles ?? [];
  const saveError = saveMutation.error
    ? describeApiError(saveMutation.error, "保存角色失败，请稍后重试。")
    : null;
  const deleteError = deleteMutation.error
    ? describeApiError(deleteMutation.error, "删除角色失败，请稍后重试。")
    : null;

  return (
    <AdminShell user={user}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink">角色管理</h1>
              <p className="mt-1 text-sm text-muted">
                角色只控制功能权限；管理员不受角色限制，用户拥有多个角色时功能权限取并集。数据源访问权请在「数据源 → 授权」中按部门或个人配置。
              </p>
            </div>
            <Button size="sm" className="gap-1.5" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              新建角色
            </Button>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
            {rolesQuery.isPending ? (
              <div className="px-4 py-10 text-center text-sm text-muted">加载中…</div>
            ) : rolesQuery.isError ? (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted">
                <p>{describeApiError(rolesQuery.error, "角色列表加载失败，请稍后重试。")}</p>
                <Button variant="outline" size="sm" onClick={() => void rolesQuery.refetch()}>
                  重试
                </Button>
              </div>
            ) : roles.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted">
                还没有角色，点击右上角新建。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-subtle text-xs text-muted">
                    <tr>
                      <th className="px-4 py-2 font-medium">名称</th>
                      <th className="px-4 py-2 font-medium">描述</th>
                      <th className="px-4 py-2 font-medium">功能权限</th>
                      <th className="px-4 py-2 font-medium">用户</th>
                      <th className="px-4 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((role) => (
                      <tr key={role.id} className="border-t border-line">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-ink">{role.name}</span>
                            {role.builtin ? (
                              <span className="inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                                <Shield className="h-3 w-3" aria-hidden />
                                内置
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="max-w-[20rem] px-4 py-2.5 text-xs text-muted">
                          {role.description ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-inksoft">{role.permissionCount}</td>
                        <td className="px-4 py-2.5 text-xs text-inksoft">{role.userCount}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => openEdit(role.id)}>
                              编辑
                            </Button>
                            {role.builtin ? null : role.userCount > 0 ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-danger hover:bg-dangersoft hover:text-danger"
                                      disabled
                                    >
                                      删除
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">请先解除该角色下的用户分配</TooltipContent>
                              </Tooltip>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-danger hover:bg-dangersoft hover:text-danger"
                                onClick={() => {
                                  deleteMutation.reset();
                                  setDeleteTarget(role);
                                }}
                              >
                                删除
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {draft !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !saveMutation.isPending) closeEditor();
          }}
        >
          <DialogContent className="max-w-xl gap-0 p-0">
            <DialogHeader>
              <DialogTitle>{editingId ? "编辑角色" : "新建角色"}</DialogTitle>
              <DialogDescription>
                {editingId
                  ? "内置角色可调整功能权限，但不能改名或删除。"
                  : "选择该角色拥有的功能权限。"}
              </DialogDescription>
            </DialogHeader>
            {editingId !== null && detailQuery.isPending ? (
              <div className="p-8">
                <PageSpinner label="加载角色…" />
              </div>
            ) : editingId !== null && (detailQuery.isError || !detailQuery.data) ? (
              <div className="flex flex-col items-center gap-3 p-8 text-sm text-muted">
                <p>{describeApiError(detailQuery.error, "角色加载失败，请稍后重试。")}</p>
                <Button variant="outline" size="sm" onClick={closeEditor}>
                  关闭
                </Button>
              </div>
            ) : (
              <RoleEditor
                key={editingId ?? "new"}
                role={editingId !== null ? detailQuery.data!.role : null}
                saving={saveMutation.isPending}
                error={saveError}
                onSave={(input) => saveMutation.mutate({ id: editingId, input })}
                onCancel={closeEditor}
              />
            )}
          </DialogContent>
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="删除角色"
          description={
            <>
              确定删除角色“{deleteTarget.name}”？已分配该角色的用户会失去对应功能权限。
            </>
          }
          confirmLabel="确认删除"
          variant="danger"
          pending={deleteMutation.isPending}
          error={deleteError}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
          onCancel={() => {
            deleteMutation.reset();
            setDeleteTarget(null);
          }}
        />
      ) : null}
    </AdminShell>
  );
}
