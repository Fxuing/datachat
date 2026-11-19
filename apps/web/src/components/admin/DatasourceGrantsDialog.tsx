import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Search, User, X } from "lucide-react";
import {
  listAdminUsers,
  listDatasourceGrants,
  listDepartments,
  replaceDatasourceGrants,
  type DatasourceSummary,
  type DepartmentNode,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface DatasourceGrantsDialogProps {
  datasource: DatasourceSummary;
  onClose: () => void;
}

type GrantTab = "departments" | "users";

interface FlatDepartmentItem {
  id: string;
  name: string;
  code: string;
  depth: number;
  status: "active" | "archived";
  ancestorIds: string[];
  ancestorNames: string[];
}

function flattenDepartments(
  nodes: DepartmentNode[],
  depth = 0,
  ancestorIds: string[] = [],
  ancestorNames: string[] = [],
): FlatDepartmentItem[] {
  const result: FlatDepartmentItem[] = [];
  for (const node of nodes) {
    result.push({
      id: node.id,
      name: node.name,
      code: node.code,
      depth,
      status: node.status,
      ancestorIds,
      ancestorNames,
    });
    result.push(
      ...flattenDepartments(
        node.children,
        depth + 1,
        [...ancestorIds, node.id],
        [...ancestorNames, node.name],
      ),
    );
  }
  return result;
}

/**
 * Single authorization center for one datasource: department grants (inherited
 * down the org tree) plus optional direct user exceptions, with live visibility
 * of which users already inherit access from their department.
 */
export function DatasourceGrantsDialog({ datasource, onClose }: DatasourceGrantsDialogProps) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<GrantTab>("departments");
  const [search, setSearch] = useState("");
  const [selectedDepartments, setSelectedDepartments] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectedUsers, setSelectedUsers] = useState<ReadonlySet<string>>(() => new Set());

  const departmentsQuery = useQuery({
    queryKey: queryKeys.departments,
    queryFn: listDepartments,
  });
  const usersQuery = useQuery({
    queryKey: queryKeys.adminUsers,
    queryFn: listAdminUsers,
  });
  const grantsQuery = useQuery({
    queryKey: queryKeys.datasourceGrants(datasource.id),
    queryFn: () => listDatasourceGrants(datasource.id),
  });

  useEffect(() => {
    if (!grantsQuery.data) return;
    setSelectedUsers(new Set(grantsQuery.data.userIds));
    setSelectedDepartments(new Set(grantsQuery.data.departmentIds));
  }, [grantsQuery.data]);

  const save = useMutation({
    mutationFn: (input: { departmentIds: string[]; userIds: string[] }) =>
      replaceDatasourceGrants(datasource.id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.datasourceGrants(datasource.id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.datasources });
      void queryClient.invalidateQueries({ queryKey: queryKeys.departments });
      void queryClient.invalidateQueries({ queryKey: ["department-grants"] });
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

  const activeDepartments = useMemo(
    () =>
      flattenDepartments(departmentsQuery.data?.departments ?? []).filter(
        (dept) => dept.status === "active",
      ),
    [departmentsQuery.data],
  );
  const departmentById = useMemo(
    () => new Map(activeDepartments.map((dept) => [dept.id, dept])),
    [activeDepartments],
  );
  const users = useMemo(
    () => (usersQuery.data?.users ?? []).filter((user) => user.status === "active"),
    [usersQuery.data],
  );

  // Compute live department-inherited grants for each user so toggling a department
  // immediately updates badges in the "个人特例直授" tab.
  const inheritedByUser = useMemo(() => {
    const result = new Map<string, string[]>();
    const hasDeptTree = activeDepartments.length > 0;
    for (const user of users) {
      if (hasDeptTree && user.departments) {
        const sources = new Set<string>();
        for (const membership of user.departments) {
          const dept = departmentById.get(membership.id);
          if (!dept) continue;
          if (selectedDepartments.has(dept.id)) sources.add(dept.name);
          dept.ancestorIds.forEach((ancestorId, index) => {
            if (selectedDepartments.has(ancestorId)) {
              const ancestorName = dept.ancestorNames[index];
              if (ancestorName) sources.add(ancestorName);
            }
          });
        }
        if (sources.size > 0) result.set(user.id, [...sources]);
      } else {
        const fromServer = grantsQuery.data?.inheritedUsers[user.id];
        if (fromServer && fromServer.length > 0) result.set(user.id, fromServer);
      }
    }
    return result;
  }, [activeDepartments.length, departmentById, grantsQuery.data, selectedDepartments, users]);

  const needle = search.trim().toLowerCase();
  const visibleDepartments = useMemo(() => {
    if (!needle) return activeDepartments;
    return activeDepartments.filter(
      (dept) =>
        dept.name.toLowerCase().includes(needle) || dept.code.toLowerCase().includes(needle),
    );
  }, [activeDepartments, needle]);

  const visibleUsers = useMemo(() => {
    if (!needle) return users;
    return users.filter(
      (user) =>
        (user.displayName ?? "").toLowerCase().includes(needle) ||
        user.username.toLowerCase().includes(needle),
    );
  }, [needle, users]);

  const loading = departmentsQuery.isPending || usersQuery.isPending || grantsQuery.isPending;
  const loadError = grantsQuery.isError
    ? describeApiError(grantsQuery.error, "加载授权失败，请稍后重试。")
    : usersQuery.isError
      ? describeApiError(usersQuery.error, "加载用户列表失败，请稍后重试。")
      : departmentsQuery.isError
        ? describeApiError(departmentsQuery.error, "加载部门列表失败，请稍后重试。")
        : null;
  const saveError = save.isError
    ? describeApiError(save.error, "保存授权失败，请稍后重试。")
    : null;

  const toggleDepartment = (departmentId: string) => {
    setSelectedDepartments((current) => {
      const next = new Set(current);
      if (next.has(departmentId)) next.delete(departmentId);
      else next.add(departmentId);
      return next;
    });
  };

  const toggleUser = (userId: string) => {
    setSelectedUsers((current) => {
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
        className="flex max-h-[82vh] w-full max-w-lg flex-col rounded-lg border border-line bg-surface shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-ink">授权数据源</h2>
            <p className="truncate text-[11px] text-muted">
              {datasource.name} · 按部门授权（向下继承）+ 个人特例直授
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

        <div className="shrink-0 border-b border-line px-4 pt-2.5">
          <div role="tablist" aria-label="授权维度" className="flex gap-1">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "departments"}
              onClick={() => {
                setTab("departments");
                setSearch("");
              }}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === "departments"
                  ? "border-brand text-brandtext"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
              按部门授权
              <span className="rounded-full bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                {selectedDepartments.size}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "users"}
              onClick={() => {
                setTab("users");
                setSearch("");
              }}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === "users"
                  ? "border-brand text-brandtext"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              <User className="h-3.5 w-3.5" aria-hidden="true" />
              个人特例直授
              <span className="rounded-full bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                {selectedUsers.size}
              </span>
            </button>
          </div>
        </div>

        <div className="shrink-0 px-4 pt-3">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={tab === "departments" ? "搜索部门名称或编码" : "搜索用户姓名或用户名"}
              aria-label={tab === "departments" ? "搜索部门" : "搜索用户"}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            {tab === "departments"
              ? "勾选上级部门后，其下级子部门成员自动继承该数据源访问权。"
              : "用于跨部门临时特例；已通过部门获得访问权的用户会在右侧标明来源，管理员始终可访问全部数据源。"}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loadError ? (
            <p
              role="alert"
              className="mb-2 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
            >
              {loadError}
            </p>
          ) : null}
          {saveError ? (
            <p
              role="alert"
              className="mb-2 rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger"
            >
              {saveError}
            </p>
          ) : null}

          {loading ? (
            <p className="p-2 text-xs text-muted">正在加载授权信息…</p>
          ) : tab === "departments" ? (
            visibleDepartments.length === 0 ? (
              <p className="p-2 text-xs text-muted">
                {activeDepartments.length === 0
                  ? "暂无部门，可先在「部门管理」创建，或切换到「个人特例直授」。"
                  : "没有匹配的部门。"}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {visibleDepartments.map((dept) => {
                  const inheritedIndex = dept.ancestorIds.findIndex((id) =>
                    selectedDepartments.has(id),
                  );
                  const inheritedFrom =
                    inheritedIndex >= 0 ? dept.ancestorNames[inheritedIndex] : null;
                  return (
                    <li key={dept.id}>
                      <label
                        className="flex cursor-pointer items-center gap-2 rounded-md py-2 pr-2 hover:bg-subtle"
                        style={{ paddingLeft: `${(needle ? 0 : dept.depth) * 16 + 8}px` }}
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 shrink-0 accent-brand"
                          checked={selectedDepartments.has(dept.id)}
                          onChange={() => toggleDepartment(dept.id)}
                        />
                        <span className="truncate text-xs text-inksoft">{dept.name}</span>
                        <span className="shrink-0 text-[11px] text-muted">{dept.code}</span>
                        {inheritedFrom ? (
                          <span className="ml-auto shrink-0 rounded bg-brandsoft px-1.5 py-0.5 text-[10px] text-brandtext">
                            已继承自 {inheritedFrom}
                          </span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )
          ) : visibleUsers.length === 0 ? (
            <p className="p-2 text-xs text-muted">
              {users.length === 0 ? "暂无启用中的用户。" : "没有匹配的用户。"}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {visibleUsers.map((user) => {
                const viaDepts = inheritedByUser.get(user.id) ?? [];
                return (
                  <li key={user.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-subtle">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0 accent-brand"
                        checked={selectedUsers.has(user.id)}
                        onChange={() => toggleUser(user.id)}
                      />
                      <span className="truncate text-xs text-inksoft">
                        {user.displayName ?? user.username}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted">@{user.username}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        {viaDepts.length > 0 ? (
                          <span className="rounded bg-brandsoft px-1.5 py-0.5 text-[10px] text-brandtext">
                            部门已授权：{viaDepts.join("、")}
                          </span>
                        ) : null}
                        {user.role === "admin" ? (
                          <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                            管理员
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line p-3">
          <span className="text-[11px] text-muted">
            已选 {selectedDepartments.size} 个部门 · {selectedUsers.size} 个个人特例
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={save.isPending} onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={loading || save.isPending || loadError !== null}
              onClick={() =>
                save.mutate({
                  departmentIds: [...selectedDepartments],
                  userIds: [...selectedUsers],
                })
              }
            >
              {save.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
