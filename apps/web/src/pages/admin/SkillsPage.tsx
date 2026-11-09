import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, RotateCcw } from "lucide-react";
import { AppShell } from "../../components/AppShell";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { SkillEditor } from "../../components/admin/SkillEditor";
import { Button } from "../../components/ui/button";
import { PageSpinner } from "../../components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import {
  ApiError,
  createSkill,
  deleteSkill,
  fetchMe,
  getSkill,
  listDatasources,
  listSkills,
  seedSkills,
  updateSkill,
  type SkillInput,
  type SkillScope,
} from "../../lib/api";
import { queryKeys } from "../../lib/query";
import { formatClock } from "../../lib/utils";

type ScopeFilter = "all" | SkillScope;
type EnabledFilter = "all" | "enabled" | "disabled";

interface ValidationDetails {
  fieldErrors?: Record<string, string[]>;
  formErrors?: string[];
}

/** Surface zod field errors from the API envelope alongside the generic message. */
function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (typeof error.details === "string") return error.details;
  const details = error.details as ValidationDetails | undefined;
  const lines: string[] = [];
  if (details?.fieldErrors) {
    for (const messages of Object.values(details.fieldErrors)) {
      if (Array.isArray(messages)) lines.push(...messages);
    }
  }
  if (Array.isArray(details?.formErrors)) lines.push(...details.formErrors);
  return lines.length ? `${error.message}：${lines.join("；")}` : error.message;
}

const selectClass =
  "h-8 rounded-md border border-linestrong bg-surface px-2 text-xs text-inksoft focus:border-linestrong focus:outline-none";

export default function SkillsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>("all");
  const [draft, setDraft] = useState<"new" | string | null>(null);
  const [seedOpen, setSeedOpen] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);

  const editingId = draft !== null && draft !== "new" ? draft : null;

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const skillsQuery = useQuery({ queryKey: queryKeys.skills, queryFn: listSkills });
  const datasourcesQuery = useQuery({
    queryKey: queryKeys.datasources,
    queryFn: listDatasources,
  });
  const detailQuery = useQuery({
    queryKey: queryKeys.skill(editingId ?? "new"),
    queryFn: () => getSkill(editingId as string),
    enabled: editingId !== null,
  });

  const saveMutation = useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: SkillInput }) =>
      id ? updateSkill(id, input) : createSkill(input),
    onSuccess: (_result, variables) => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
      if (variables.id) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.skill(variables.id) });
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSkill(id),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });

  const seedMutation = useMutation({
    mutationFn: seedSkills,
    onSuccess: (result) => {
      setSeedOpen(false);
      setSeedResult(`已导入 ${result.imported} 个，跳过 ${result.skipped} 个。`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.skills });
    },
  });

  const resetMutations = () => {
    saveMutation.reset();
    deleteMutation.reset();
  };

  const openCreate = () => {
    resetMutations();
    setDraft("new");
  };

  const openEdit = (id: string) => {
    resetMutations();
    setDraft(id);
  };

  const closeEditor = () => {
    setDraft(null);
    resetMutations();
  };

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const skills = skillsQuery.data?.skills ?? [];
  const datasources = datasourcesQuery.data?.datasources ?? [];
  const datasourceName = (id: string | null) =>
    id ? (datasources.find((datasource) => datasource.id === id)?.name ?? "未知数据源") : "—";

  const filtered = skills.filter((skill) => {
    if (scopeFilter !== "all" && skill.scope !== scopeFilter) return false;
    if (enabledFilter === "enabled" && !skill.enabled) return false;
    if (enabledFilter === "disabled" && skill.enabled) return false;
    return true;
  });

  const listForbidden =
    skillsQuery.isError && skillsQuery.error instanceof ApiError && skillsQuery.error.status === 403;

  const sidebar = (
    <div className="p-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2"
        onClick={() => navigate("/chat")}
      >
        <ArrowLeft className="h-4 w-4" />
        返回对话
      </Button>
    </div>
  );

  return (
    <AppShell user={user} sidebar={sidebar}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink">技能管理</h1>
              <p className="mt-1 text-sm text-muted">
                技能会注入到 Agent 系统提示中；数据源技能可覆盖同名的全局技能。
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={seedMutation.isPending}
                onClick={() => {
                  seedMutation.reset();
                  setSeedOpen(true);
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                恢复内置技能
              </Button>
              <Button size="sm" className="gap-1.5" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                新建技能
              </Button>
            </div>
          </div>

          {seedResult ? (
            <p
              role="status"
              className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted"
            >
              {seedResult}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Select
              value={scopeFilter}
              onValueChange={(value) => setScopeFilter(value as ScopeFilter)}
            >
              <SelectTrigger aria-label="按范围筛选" className="h-8 w-[8.5rem] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部范围</SelectItem>
                <SelectItem value="global">全局</SelectItem>
                <SelectItem value="datasource">数据源</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={enabledFilter}
              onValueChange={(value) => setEnabledFilter(value as EnabledFilter)}
            >
              <SelectTrigger aria-label="按状态筛选" className="h-8 w-[8.5rem] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="enabled">已启用</SelectItem>
                <SelectItem value="disabled">已停用</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-xs text-muted">共 {filtered.length} 个技能</span>
          </div>

          <div className="mt-3 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
            {skillsQuery.isPending ? (
              <div className="px-4 py-10 text-center text-sm text-muted">加载中…</div>
            ) : listForbidden ? (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted">
                <p>没有管理员权限，无法查看技能。</p>
                <Button variant="outline" size="sm" onClick={() => navigate("/chat")}>
                  返回对话
                </Button>
              </div>
            ) : skillsQuery.isError ? (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-sm text-muted">
                <p>{describeError(skillsQuery.error, "技能列表加载失败，请稍后重试。")}</p>
                <Button variant="outline" size="sm" onClick={() => void skillsQuery.refetch()}>
                  重试
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted">
                {skills.length === 0
                  ? "还没有技能，点击右上角新建，或恢复内置技能。"
                  : "没有符合筛选条件的技能。"}
              </div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="bg-subtle text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-medium">名称</th>
                    <th className="px-4 py-2 font-medium">范围</th>
                    <th className="px-4 py-2 font-medium">数据源</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 font-medium">更新时间</th>
                    <th className="px-4 py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((skill) => (
                    <tr key={skill.id} className="border-t border-line">
                      <td className="max-w-[20rem] px-4 py-2.5">
                        <p className="truncate font-medium text-ink">{skill.name}</p>
                        <p className="truncate text-xs text-muted">{skill.description}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={
                            skill.scope === "global"
                              ? "rounded bg-subtle px-1.5 py-0.5 text-[11px] text-muted"
                              : "rounded bg-brandsoft px-1.5 py-0.5 text-[11px] text-brandtext"
                          }
                        >
                          {skill.scope === "global" ? "全局" : "数据源"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted">
                        {skill.scope === "global" ? "—" : datasourceName(skill.datasourceId)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={skill.enabled ? "text-xs text-success" : "text-xs text-muted"}>
                          {skill.enabled ? "启用" : "停用"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted">
                        {formatClock(skill.updatedAt)}
                      </td>
                      <td className="px-4 py-2.5">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(skill.id)}>
                          编辑
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {draft === "new" ? (
        <SkillEditor
          key="new"
          skill={null}
          datasources={datasources}
          saving={saveMutation.isPending}
          deleting={false}
          error={
            saveMutation.error ? describeError(saveMutation.error, "保存失败，请稍后重试。") : null
          }
          deleteError={null}
          onSave={(input) => saveMutation.mutate({ id: null, input })}
          onDelete={() => undefined}
          onClose={closeEditor}
        />
      ) : null}

      {editingId ? (
        detailQuery.isPending ? (
          <div className="fixed inset-0 z-40 flex justify-end bg-black/30">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="编辑技能"
              className="flex h-full w-full max-w-xl items-center justify-center border-l border-line bg-surface shadow-xl"
            >
              <PageSpinner label="加载技能…" />
            </div>
          </div>
        ) : detailQuery.isError || !detailQuery.data ? (
          <div className="fixed inset-0 z-40 flex justify-end bg-black/30">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="编辑技能"
              className="flex h-full w-full max-w-xl flex-col items-center justify-center gap-3 border-l border-line bg-surface px-6 shadow-xl"
            >
              <p className="text-sm text-muted">
                {describeError(detailQuery.error, "技能加载失败，请稍后重试。")}
              </p>
              <Button variant="outline" size="sm" onClick={closeEditor}>
                关闭
              </Button>
            </div>
          </div>
        ) : (
          <SkillEditor
            key={editingId}
            skill={detailQuery.data.skill}
            datasources={datasources}
            saving={saveMutation.isPending}
            deleting={deleteMutation.isPending}
            error={
              saveMutation.error ? describeError(saveMutation.error, "保存失败，请稍后重试。") : null
            }
            deleteError={
              deleteMutation.error
                ? describeError(deleteMutation.error, "删除失败，请稍后重试。")
                : null
            }
            onSave={(input) => saveMutation.mutate({ id: editingId, input })}
            onDelete={() => deleteMutation.mutate(editingId)}
            onClose={closeEditor}
          />
        )
      ) : null}

      {seedOpen ? (
        <ConfirmDialog
          title="恢复内置技能"
          description="将重新导入 agent/skills 下的内置技能；已存在的同名技能会跳过，不会覆盖现有内容。"
          confirmLabel="确认恢复"
          pending={seedMutation.isPending}
          error={
            seedMutation.error ? describeError(seedMutation.error, "导入失败，请稍后重试。") : null
          }
          onConfirm={() => seedMutation.mutate()}
          onCancel={() => setSeedOpen(false)}
        />
      ) : null}
    </AppShell>
  );
}
