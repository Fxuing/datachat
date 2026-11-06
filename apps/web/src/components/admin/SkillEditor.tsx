import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { AdminSkillDetail, DatasourceSummary, SkillInput, SkillScope } from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ConfirmDialog } from "./ConfirmDialog";

export interface SkillEditorProps {
  /** null creates a new skill. */
  skill: AdminSkillDetail | null;
  datasources: DatasourceSummary[];
  saving: boolean;
  deleting: boolean;
  error: string | null;
  deleteError: string | null;
  onSave: (input: SkillInput) => void;
  onDelete: () => void;
  onClose: () => void;
}

interface FormState {
  name: string;
  description: string;
  scope: SkillScope;
  datasourceId: string | null;
  enabled: boolean;
  content: string;
}

function initialForm(skill: AdminSkillDetail | null): FormState {
  return {
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    scope: skill?.scope ?? "global",
    datasourceId: skill?.datasourceId ?? null,
    enabled: skill?.enabled ?? true,
    content: skill?.content ?? "",
  };
}

const labelClass = "block text-xs font-medium text-neutral-600";

export function SkillEditor({
  skill,
  datasources,
  saving,
  deleting,
  error,
  deleteError,
  onSave,
  onDelete,
  onClose,
}: SkillEditorProps) {
  const [form, setForm] = useState<FormState>(() => initialForm(skill));
  const [baseline] = useState<FormState>(() => initialForm(skill));
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const busy = saving || deleting;

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (discardOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      if (dirty) setDiscardOpen(true);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, dirty, discardOpen, onClose]);

  const close = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  const update = <K extends keyof FormState,>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const changeScope = (scope: SkillScope) => {
    setForm((current) => ({
      ...current,
      scope,
      // A global skill must not keep a datasource id; switching to datasource
      // keeps the current selection when one was already chosen.
      datasourceId: scope === "global" ? null : current.datasourceId,
    }));
  };

  const submit = () => {
    if (busy) return;
    onSave({
      name: form.name.trim(),
      description: form.description.trim(),
      content: form.content,
      scope: form.scope,
      datasourceId: form.scope === "global" ? null : form.datasourceId,
      enabled: form.enabled,
    });
  };

  const title = skill ? "编辑技能" : "新建技能";

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex justify-end bg-neutral-900/20"
        role="presentation"
        onMouseDown={close}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="flex h-full w-full max-w-xl flex-col border-l border-neutral-200 bg-white shadow-xl"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 px-4">
            <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
            <Button variant="ghost" size="icon" aria-label="关闭" onClick={close}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {error ? (
                <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                  {error}
                </p>
              ) : null}

              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="skill-name">
                  名称
                </label>
                <Input
                  id="skill-name"
                  value={form.name}
                  placeholder="sales-rules"
                  autoComplete="off"
                  onChange={(event) => update("name", event.target.value)}
                />
                <p className="text-[11px] text-neutral-400">
                  2-64 位小写字母、数字或短横线，且以字母或数字开头；同一范围内唯一。
                </p>
              </div>

              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="skill-description">
                  描述
                </label>
                <Input
                  id="skill-description"
                  value={form.description}
                  placeholder="一句话说明技能用途（最多 500 字）"
                  onChange={(event) => update("description", event.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className={labelClass} htmlFor="skill-scope">
                    范围
                  </label>
                  <select
                    id="skill-scope"
                    className="h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:border-neutral-500 focus-visible:outline-none"
                    value={form.scope}
                    onChange={(event) => changeScope(event.target.value as SkillScope)}
                  >
                    <option value="global">全局</option>
                    <option value="datasource">数据源</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className={labelClass} htmlFor="skill-datasource">
                    数据源
                  </label>
                  <select
                    id="skill-datasource"
                    className="h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 disabled:bg-neutral-100 disabled:text-neutral-400 focus-visible:border-neutral-500 focus-visible:outline-none"
                    value={form.datasourceId ?? ""}
                    disabled={form.scope !== "datasource"}
                    onChange={(event) => update("datasourceId", event.target.value || null)}
                  >
                    <option value="">{form.scope === "datasource" ? "请选择数据源" : "全局技能"}</option>
                    {datasources.map((datasource) => (
                      <option key={datasource.id} value={datasource.id}>
                        {datasource.name}（{datasource.type === "mysql" ? "MySQL" : "PostgreSQL"}）
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="flex w-fit items-center gap-2 text-sm text-neutral-700">
                <input
                  id="skill-enabled"
                  type="checkbox"
                  className="h-4 w-4 rounded border-neutral-300"
                  checked={form.enabled}
                  onChange={(event) => update("enabled", event.target.checked)}
                />
                启用
              </label>

              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="skill-content">
                  内容（SKILL.md）
                </label>
                <Textarea
                  id="skill-content"
                  rows={12}
                  spellCheck={false}
                  className="font-mono text-xs leading-relaxed"
                  placeholder={"技能的 Markdown 正文。可直接写正文，保存时会自动补齐 frontmatter。"}
                  value={form.content}
                  onChange={(event) => update("content", event.target.value)}
                />
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 p-3">
              <div>
                {skill ? (
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => setDeleteOpen(true)}>
                    删除
                  </Button>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={busy} onClick={close}>
                  取消
                </Button>
                <Button type="submit" size="sm" disabled={busy}>
                  {saving ? "保存中…" : "保存"}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>

      {deleteOpen ? (
        <ConfirmDialog
          title="删除技能"
          description={`确定删除“${skill?.name ?? ""}”？此操作不可恢复。`}
          confirmLabel="确认删除"
          variant="danger"
          pending={deleting}
          error={deleteError}
          onConfirm={onDelete}
          onCancel={() => setDeleteOpen(false)}
        />
      ) : null}

      {discardOpen ? (
        <ConfirmDialog
          title="放弃未保存的修改？"
          description="关闭后本次修改不会保留。"
          confirmLabel="放弃修改"
          cancelLabel="继续编辑"
          variant="danger"
          onConfirm={onClose}
          onCancel={() => setDiscardOpen(false)}
        />
      ) : null}
    </>
  );
}
