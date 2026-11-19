import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Shield } from "lucide-react";
import { AdminShell } from "../../components/admin/AdminShell";
import { DepartmentMultiSelect } from "../../components/admin/DepartmentMultiSelect";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { PageSpinner } from "../../components/ui/spinner";
import {
  createAdminUser,
  fetchMe,
  listAdminUsers,
  listDepartments,
  listRoles,
  setUserDepartments,
  updateAdminUser,
  type AdminUser,
  type CreateAdminUserInput,
  type DepartmentRow,
  type RoleSummary,
  type UpdateAdminUserInput,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { cn, formatDateTime } from "../../lib/utils";

const labelClass = "block text-xs font-medium text-muted";

const MEMBER_ROLE_ID = "role_member";

const statusLabel: Record<AdminUser["status"], string> = {
  active: "启用",
  disabled: "禁用",
};

type SavePayload =
  | {
      mode: "create";
      input: CreateAdminUserInput;
      departmentIds: string[];
      primaryDepartmentId: string | null;
    }
  | {
      mode: "edit";
      id: string;
      input: UpdateAdminUserInput;
      departmentIds: string[];
      primaryDepartmentId: string | null;
    };

interface UserEditorProps {
  /** null creates a new user. */
  user: AdminUser | null;
  roles: RoleSummary[];
  rolesError: string | null;
  departments: DepartmentRow[];
  canManageDepartments: boolean;
  isSelf: boolean;
  saving: boolean;
  error: string | null;
  onSave: (payload: SavePayload) => void;
  onCancel: () => void;
}

function UserEditor({
  user,
  roles,
  rolesError,
  departments,
  canManageDepartments,
  isSelf,
  saving,
  error,
  onSave,
  onCancel,
}: UserEditorProps) {
  const editing = user !== null;
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<AdminUser["status"]>(user?.status ?? "active");
  const [isAdmin, setIsAdmin] = useState(user?.role === "admin");
  const [roleIds, setRoleIds] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        user
          ? user.roleIds
          : roles.some((role) => role.id === MEMBER_ROLE_ID)
            ? [MEMBER_ROLE_ID]
            : [],
      ),
  );

  const [departmentIds, setDepartmentIds] = useState<ReadonlySet<string>>(
    () => new Set((user?.departments ?? []).map((row) => row.id)),
  );
  const [primaryDepartmentId, setPrimaryDepartmentId] = useState<string | null>(
    user?.departments?.find((row) => row.isPrimary)?.id ?? null,
  );

  const passwordValid = editing ? password === "" || password.length >= 8 : password.length >= 8;
  const usernameValid = username.trim().length >= 2;
  const canSubmit = roleIds.size > 0 && passwordValid && (editing || usernameValid);

  const orderedRoleIds = roles.filter((role) => roleIds.has(role.id)).map((role) => role.id);

  const submit = () => {
    if (saving || !canSubmit) return;
    const trimmedDisplayName = displayName.trim();
    if (editing) {
      onSave({
        mode: "edit",
        id: user.id,
        input: {
          displayName: trimmedDisplayName === "" ? null : trimmedDisplayName,
          roleIds: orderedRoleIds,
          status,
          role: isAdmin ? "admin" : "user",
          ...(password === "" ? {} : { password }),
        },
        departmentIds: [...departmentIds],
        primaryDepartmentId:
          primaryDepartmentId && departmentIds.has(primaryDepartmentId) ? primaryDepartmentId : null,
      });
      return;
    }
    onSave({
      mode: "create",
      input: {
        username: username.trim(),
        password,
        ...(trimmedDisplayName === "" ? {} : { displayName: trimmedDisplayName }),
        role: isAdmin ? "admin" : "user",
        roleIds: orderedRoleIds,
      },
      departmentIds: [...departmentIds],
      primaryDepartmentId:
        primaryDepartmentId && departmentIds.has(primaryDepartmentId) ? primaryDepartmentId : null,
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

        {editing ? null : (
          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="user-username">
              用户名
            </label>
            <Input
              id="user-username"
              value={username}
              maxLength={64}
              disabled={saving}
              placeholder="登录名"
              autoComplete="off"
              onChange={(event) => setUsername(event.target.value)}
            />
            {username !== "" && !usernameValid ? (
              <p className="text-[11px] text-danger">用户名至少 2 个字符。</p>
            ) : null}
          </div>
        )}

        <div className="space-y-1.5">
          <label className={labelClass} htmlFor="user-display-name">
            显示名称
          </label>
          <Input
            id="user-display-name"
            value={displayName}
            maxLength={64}
            disabled={saving}
            placeholder="用于界面展示（可选）"
            autoComplete="off"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <label className={labelClass} htmlFor="user-password">
            {editing ? "新密码（可选）" : "密码"}
          </label>
          <Input
            id="user-password"
            type="password"
            value={password}
            maxLength={200}
            disabled={saving}
            placeholder={editing ? "留空则不修改" : "至少 8 个字符"}
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          {password !== "" && password.length < 8 ? (
            <p className="text-[11px] text-danger">密码至少 8 个字符。</p>
          ) : null}
        </div>

        {editing ? (
          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="user-status">
              状态
            </label>
            <Select
              value={status}
              disabled={saving || isSelf}
              onValueChange={(value) => setStatus(value as AdminUser["status"])}
            >
              <SelectTrigger id="user-status" aria-label="状态">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">启用</SelectItem>
                <SelectItem value="disabled">禁用</SelectItem>
              </SelectContent>
            </Select>
            {isSelf ? (
              <p className="text-[11px] text-muted">不能禁用自己的账号。</p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-inksoft">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-brand"
              checked={isAdmin}
              disabled={saving || isSelf}
              onChange={(event) => setIsAdmin(event.target.checked)}
            />
            <span>系统管理员</span>
          </label>
          <p className="text-[11px] text-muted">
            {isSelf
              ? "不能修改自己的管理员角色。"
              : "管理员不受角色与数据源限制，可进入所有管理页面。"}
          </p>
        </div>

        <fieldset className="space-y-1.5">
          <legend className={labelClass}>角色</legend>
          {rolesError ? (
            <p role="alert" className="rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
              {rolesError}
            </p>
          ) : null}
          <div className="rounded-md border border-line">
            {roles.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted">暂无角色。</p>
            ) : (
              roles.map((role) => (
                <label
                  key={role.id}
                  className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-inksoft hover:bg-subtle"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand"
                    checked={roleIds.has(role.id)}
                    disabled={saving}
                    onChange={() =>
                      setRoleIds((current) => {
                        const next = new Set(current);
                        if (next.has(role.id)) next.delete(role.id);
                        else next.add(role.id);
                        return next;
                      })
                    }
                  />
                  <span className="truncate">{role.name}</span>
                </label>
              ))
            )}
          </div>
          {roleIds.size === 0 ? (
            <p className="text-[11px] text-danger">至少选择一个角色。</p>
          ) : null}
        </fieldset>

        {canManageDepartments ? (
          <fieldset className="space-y-1.5">
            <legend className={labelClass}>部门</legend>
            {departments.length === 0 ? (
              <p className="rounded-md border border-line px-3 py-2 text-xs text-muted">
                还没有部门，可先在部门管理中创建。
              </p>
            ) : (
              <DepartmentMultiSelect
                departments={departments}
                value={departmentIds}
                primaryId={primaryDepartmentId}
                disabled={saving}
                onChange={(ids, primaryId) => {
                  setDepartmentIds(new Set(ids));
                  setPrimaryDepartmentId(primaryId);
                }}
              />
            )}
            <p className="text-[11px] text-muted">
              部门决定数据边界；主部门仅用于展示，数据权限按所有部门子树取并集。
            </p>
          </fieldset>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" disabled={saving} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" size="sm" disabled={saving || !canSubmit}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export default function UsersPage() {
  const queryClient = useQueryClient();

  const [editor, setEditor] = useState<{ mode: "new" } | { mode: "edit"; user: AdminUser } | null>(
    null,
  );

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const usersQuery = useQuery({ queryKey: queryKeys.adminUsers, queryFn: listAdminUsers });
  const rolesQuery = useQuery({ queryKey: queryKeys.roles, queryFn: listRoles });
  const canManageDepartments = Boolean(
    meQuery.data &&
      (meQuery.data.user.role === "admin" ||
        meQuery.data.permissions.includes("admin.departments")),
  );
  const departmentsQuery = useQuery({
    queryKey: queryKeys.departments,
    queryFn: listDepartments,
    enabled: canManageDepartments,
  });

  const saveMutation = useMutation({
    mutationFn: async (payload: SavePayload) => {
      const saved =
        payload.mode === "create"
          ? await createAdminUser(payload.input)
          : await updateAdminUser(payload.id, payload.input);
      if (canManageDepartments) {
        await setUserDepartments(
          saved.user.id,
          payload.departmentIds,
          payload.primaryDepartmentId,
        );
      }
      return saved;
    },
    onSuccess: () => {
      setEditor(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });

  const openCreate = () => {
    saveMutation.reset();
    setEditor({ mode: "new" });
  };

  const openEdit = (user: AdminUser) => {
    saveMutation.reset();
    setEditor({ mode: "edit", user });
  };

  const closeEditor = () => {
    setEditor(null);
    saveMutation.reset();
  };

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const users = usersQuery.data?.users ?? [];
  const roles = rolesQuery.data?.roles ?? [];
  const departmentRows = departmentsQuery.data?.flat ?? [];
  const rolesError = rolesQuery.isError
    ? describeApiError(rolesQuery.error, "角色列表加载失败，请稍后重试。")
    : null;
  const saveError = saveMutation.error
    ? describeApiError(saveMutation.error, "保存用户失败，请稍后重试。")
    : null;


  return (
    <AdminShell user={user}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink">用户管理</h1>
              <p className="mt-1 text-sm text-muted">
                用户拥有多个角色时，权限和数据源取并集；管理员不受角色限制。
              </p>
            </div>
            <Button size="sm" className="gap-1.5" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              新建用户
            </Button>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
            {usersQuery.isPending ? (
              <div className="px-4 py-10 text-center text-sm text-muted">加载中…</div>
            ) : usersQuery.isError ? (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted">
                <p>{describeApiError(usersQuery.error, "用户列表加载失败，请稍后重试。")}</p>
                <Button variant="outline" size="sm" onClick={() => void usersQuery.refetch()}>
                  重试
                </Button>
              </div>
            ) : users.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted">
                还没有用户，点击右上角新建。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-subtle text-xs text-muted">
                    <tr>
                      <th className="px-4 py-2 font-medium">用户</th>
                      <th className="px-4 py-2 font-medium">角色</th>
                      <th className="px-4 py-2 font-medium">状态</th>
                      <th className="px-4 py-2 font-medium">创建时间</th>
                      <th className="px-4 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((row) => (
                      <tr key={row.id} className="border-t border-line">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-ink">{row.displayName ?? row.username}</div>
                          <div className="text-[11px] text-muted">@{row.username}</div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-1">
                            {row.role === "admin" ? (
                              <span className="inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                                <Shield className="h-3 w-3" aria-hidden />
                                管理员
                              </span>
                            ) : null}
                            {row.roles.map((role) => (
                              <span
                                key={role.id}
                                className="rounded bg-brandsoft px-1.5 py-0.5 text-[10px] font-medium text-brandtext"
                              >
                                {role.name}
                              </span>
                            ))}
                            {row.role !== "admin" && row.roles.length === 0 ? (
                              <span className="text-xs text-muted">—</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={cn(
                              "text-xs",
                              row.status === "active" ? "text-success" : "text-muted",
                            )}
                          >
                            {statusLabel[row.status]}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted">
                          {formatDateTime(row.createdAt)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(row)}
                            >
                              编辑
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
        </div>
      </div>

      {editor !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !saveMutation.isPending) closeEditor();
          }}
        >
          <DialogContent className="max-w-xl gap-0 p-0">
            <DialogHeader>
              <DialogTitle>{editor.mode === "edit" ? "编辑用户" : "新建用户"}</DialogTitle>
              <DialogDescription>
                {editor.mode === "edit"
                  ? "调整用户的角色、状态，或重置密码。"
                  : "创建账号并选择至少一个角色，默认分配成员角色。"}
              </DialogDescription>
            </DialogHeader>
            {rolesQuery.isPending ? (
              <div className="p-8">
                <PageSpinner label="加载角色…" />
              </div>
            ) : (
              <UserEditor
                key={editor.mode === "edit" ? editor.user.id : "new"}
                user={editor.mode === "edit" ? editor.user : null}
                roles={roles}
                rolesError={rolesError}
                departments={departmentRows}
                canManageDepartments={canManageDepartments}
                isSelf={editor.mode === "edit" && editor.user.id === user.id}
                saving={saveMutation.isPending}
                error={saveError}
                onSave={(payload) => saveMutation.mutate(payload)}
                onCancel={closeEditor}
              />
            )}
          </DialogContent>
        </Dialog>
      ) : null}
    </AdminShell>
  );
}
