import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Plus, Trash2 } from "lucide-react";
import { AdminShell } from "../../components/admin/AdminShell";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { DepartmentTree } from "../../components/admin/DepartmentTree";
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
  createDepartment,
  datasourceTypeLabel,
  deleteDepartment,
  fetchMe,
  getDepartmentGrants,
  listDatasources,
  listDepartmentMembers,
  listDepartments,
  moveDepartment,
  updateDepartment,
  type DepartmentNode,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";

const labelClass = "block text-xs font-medium text-muted";

interface DepartmentDialogState {
  mode: "create" | "rename";
  parentId: string | null;
  node?: DepartmentNode;
}

export default function DepartmentsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DepartmentDialogState | null>(null);
  const [formName, setFormName] = useState("");
  const [formCode, setFormCode] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DepartmentNode | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const departmentsQuery = useQuery({ queryKey: queryKeys.departments, queryFn: listDepartments });
  const datasourcesQuery = useQuery({ queryKey: queryKeys.datasources, queryFn: listDatasources });

  const nodes = useMemo(() => departmentsQuery.data?.departments ?? [], [departmentsQuery.data]);
  const flat = departmentsQuery.data?.flat ?? [];
  const allNodes = useMemo(() => {
    const walk = (items: DepartmentNode[]): DepartmentNode[] =>
      items.flatMap((item) => [item, ...walk(item.children)]);
    return walk(nodes);
  }, [nodes]);
  const selected = useMemo(
    () => allNodes.find((row) => row.id === selectedId) ?? null,
    [allNodes, selectedId],
  );

  const membersQuery = useQuery({
    queryKey: queryKeys.departmentMembers(selectedId ?? ""),
    queryFn: () => listDepartmentMembers(selectedId as string),
    enabled: Boolean(selectedId),
  });
  const grantsQuery = useQuery({
    queryKey: queryKeys.departmentGrants(selectedId ?? ""),
    queryFn: () => getDepartmentGrants(selectedId as string),
    enabled: Boolean(selectedId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.departments });
    void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!dialog) return;
      if (dialog.mode === "create") {
        await createDepartment({
          name: formName.trim(),
          ...(formCode.trim() === "" ? {} : { code: formCode.trim() }),
          parentId: dialog.parentId,
        });
        return;
      }
      if (dialog.node) {
        await updateDepartment(dialog.node.id, {
          name: formName.trim(),
          ...(formCode.trim() === "" ? {} : { code: formCode.trim() }),
        });
      }
    },
    onSuccess: () => {
      setDialog(null);
      invalidate();
    },
  });

  const moveMutation = useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) =>
      moveDepartment(id, parentId),
    onSuccess: () => invalidate(),
    onError: (error) => setBanner(describeApiError(error, "移动部门失败")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteDepartment(id),
    onSuccess: () => {
      setDeleteTarget(null);
      setSelectedId(null);
      invalidate();
    },
    onError: (error) => setBanner(describeApiError(error, "删除部门失败")),
  });

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const datasources = datasourcesQuery.data?.datasources ?? [];
  const granted = new Set(grantsQuery.data?.datasourceIds ?? []);
  const saveError = saveMutation.error
    ? describeApiError(saveMutation.error, "保存部门失败")
    : null;

  const openCreate = (parentId: string | null) => {
    saveMutation.reset();
    setFormName("");
    setFormCode("");
    setDialog({ mode: "create", parentId });
  };

  const openRename = (node: DepartmentNode) => {
    saveMutation.reset();
    setFormName(node.name);
    setFormCode(node.code);
    setDialog({ mode: "rename", parentId: node.parentId, node });
  };

  return (
    <AdminShell user={user}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink">部门管理</h1>
              <p className="mt-1 text-sm text-muted">
                部门决定数据边界：上级部门自动包含下级部门，数据源授权向下继承，行级范围按部门子树过滤。
              </p>
            </div>
            <Button size="sm" className="gap-1.5" onClick={() => openCreate(null)}>
              <Plus className="h-3.5 w-3.5" />
              新建根部门
            </Button>
          </div>

          {banner ? (
            <p role="alert" className="mt-3 rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
              {banner}
            </p>
          ) : null}

          <div className="mt-4 grid gap-4 md:grid-cols-[280px_1fr]">
            <div className="rounded-xl border border-line bg-surface p-2 shadow-card">
              {departmentsQuery.isPending ? (
                <p className="px-2 py-6 text-center text-xs text-muted">加载中…</p>
              ) : (
                <DepartmentTree
                  nodes={nodes}
                  selectedId={selectedId}
                  expanded={expanded}
                  onSelect={(node) => setSelectedId(node.id)}
                  onToggle={(id) =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    })
                  }
                  onAddChild={(node) => openCreate(node.id)}
                />
              )}
            </div>

            <div className="rounded-xl border border-line bg-surface p-4 shadow-card">
              {!selected ? (
                <p className="py-10 text-center text-sm text-muted">选择左侧部门查看成员与授权。</p>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="text-base font-semibold text-ink">{selected.name}</h2>
                      <p className="text-[11px] text-muted">编码：{selected.code}</p>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => openRename(selected)}>
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 text-danger hover:bg-dangersoft hover:text-danger"
                        onClick={() => setDeleteTarget(selected)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        删除
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className={labelClass} htmlFor="department-parent">
                      上级部门
                    </label>
                    <Select
                      value={selected.parentId ?? "root"}
                      onValueChange={(value) =>
                        moveMutation.mutate({
                          id: selected.id,
                          parentId: value === "root" ? null : value,
                        })
                      }
                    >
                      <SelectTrigger id="department-parent" aria-label="上级部门">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="root">（根部门）</SelectItem>
                        {flat
                          .filter((row) => row.id !== selected.id)
                          .map((row) => (
                            <SelectItem key={row.id} value={row.id}>
                              {row.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted">不能移动到自己的子部门下。</p>
                  </div>

                  <div>
                    <h3 className="text-xs font-medium text-muted">成员</h3>
                    {membersQuery.isPending ? (
                      <p className="py-2 text-xs text-muted">加载中…</p>
                    ) : (membersQuery.data?.members.length ?? 0) === 0 ? (
                      <p className="py-2 text-xs text-muted">暂无成员，可在用户管理中分配部门。</p>
                    ) : (
                      <ul className="mt-1 divide-y divide-line rounded-md border border-line">
                        {membersQuery.data?.members.map((member) => (
                          <li key={member.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                            <span className="text-ink">{member.displayName ?? member.username}</span>
                            {member.isPrimary ? <span className="text-[10px] text-muted">主部门</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-medium text-muted">可访问数据源（含上级继承）</h3>
                      <Link
                        to="/admin/datasources"
                        className="inline-flex items-center gap-0.5 text-[11px] text-brandtext hover:underline"
                      >
                        前往数据源管理配置授权
                        <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                      </Link>
                    </div>
                    {grantsQuery.isPending ? (
                      <p className="py-2 text-xs text-muted">加载中…</p>
                    ) : granted.size === 0 ? (
                      <p className="py-2 text-xs text-muted">
                        暂无已授权数据源，可在「数据源 → 授权」中按部门分配。
                      </p>
                    ) : (
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {datasources
                          .filter((datasource) => granted.has(datasource.id))
                          .map((datasource) => (
                            <li
                              key={datasource.id}
                              className="inline-flex items-center gap-1 rounded-md border border-line bg-subtle px-2 py-1 text-xs text-inksoft"
                            >
                              <span>{datasource.name}</span>
                              <span className="text-[10px] text-muted">
                                {datasourceTypeLabel(datasource)}
                              </span>
                            </li>
                          ))}
                      </ul>
                    )}
                    <p className="mt-1.5 text-[11px] text-muted">
                      子部门自动继承上级部门的数据源访问权；如需增删授权请统一在「数据源 → 授权」中操作。
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {dialog ? (
        <Dialog open onOpenChange={(open) => (!open ? setDialog(null) : undefined)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{dialog.mode === "create" ? "新建部门" : "编辑部门"}</DialogTitle>
              <DialogDescription>
                {dialog.mode === "create"
                  ? dialog.parentId
                    ? "将在所选部门下创建子部门。"
                    : "创建一个根部门。"
                  : "修改名称或编码；编码用于数据源行过滤（app_code）。"}
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-3 px-4 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (formName.trim() === "" || saveMutation.isPending) return;
                saveMutation.mutate();
              }}
            >
              {saveError ? (
                <p role="alert" className="rounded-md bg-dangersoft px-3 py-2 text-xs text-danger">
                  {saveError}
                </p>
              ) : null}
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="department-name">
                  名称
                </label>
                <Input
                  id="department-name"
                  value={formName}
                  maxLength={64}
                  placeholder="例如：销售部"
                  onChange={(event) => setFormName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="department-code">
                  编码（可选）
                </label>
                <Input
                  id="department-code"
                  value={formCode}
                  maxLength={32}
                  placeholder="留空自动生成"
                  onChange={(event) => setFormCode(event.target.value)}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" type="button" onClick={() => setDialog(null)}>
                  取消
                </Button>
                <Button type="submit" size="sm" disabled={saveMutation.isPending || formName.trim() === ""}>
                  {saveMutation.isPending ? "保存中…" : "保存"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="删除部门"
          description={`确定删除「${deleteTarget.name}」？有子部门或成员时无法删除。`}
          confirmLabel="删除"
          variant="danger"
          pending={deleteMutation.isPending}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        />
      ) : null}
    </AdminShell>
  );
}
