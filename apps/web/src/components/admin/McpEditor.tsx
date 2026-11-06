import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type {
  AdminMcpServer,
  DatasourceSummary,
  MaskedSecretEntry,
  McpServerInput,
  McpTestResult,
  McpTransport,
} from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { ConfirmDialog } from "./ConfirmDialog";

export interface McpEditorProps {
  /** null creates a new server; testing is only available once saved. */
  server: AdminMcpServer | null;
  datasources: DatasourceSummary[];
  saving: boolean;
  deleting: boolean;
  testing: boolean;
  error: string | null;
  deleteError: string | null;
  testResult: McpTestResult | null;
  testError: string | null;
  onSave: (input: McpServerInput) => void;
  onDelete: () => void;
  onTest: () => void;
  onClose: () => void;
}

/**
 * One key/value row. `existing` marks a value already stored on the server:
 * leaving its value blank keeps the stored secret instead of clearing it.
 */
interface SecretRow {
  key: string;
  value: string;
  existing: boolean;
}

interface FormState {
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  datasourceId: string | null;
  enabled: boolean;
  env: SecretRow[];
  headers: SecretRow[];
}

function blankRow(): SecretRow {
  return { key: "", value: "", existing: false };
}

function rowsFromEntries(entries: MaskedSecretEntry[] | undefined): SecretRow[] {
  const rows = (entries ?? []).map((entry) => ({
    key: entry.key,
    value: "",
    existing: true,
  }));
  return rows.length ? rows : [blankRow()];
}

function initialForm(server: AdminMcpServer | null): FormState {
  return {
    name: server?.name ?? "",
    transport: server?.transport ?? "stdio",
    command: server?.command ?? "",
    argsText: (server?.args ?? []).join("\n"),
    url: server?.url ?? "",
    datasourceId: server?.datasourceId ?? null,
    enabled: server?.enabled ?? true,
    env: server ? rowsFromEntries(server.env) : [blankRow()],
    headers: server ? rowsFromEntries(server.headers) : [blankRow()],
  };
}

/** Keep stored keys when the value is left blank; drop rows the admin removed. */
function serializeSecretRows(rows: SecretRow[]): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    result[key] = row.existing && row.value === "" ? null : row.value;
  }
  return result;
}

function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const labelClass = "block text-xs font-medium text-neutral-600";
const fieldHintClass = "text-[11px] text-neutral-400";

function SecretRowsEditor({
  label,
  hint,
  rows,
  onChange,
}: {
  label: string;
  hint: string;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className={labelClass}>{label}</span>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              aria-label={`${label}键 ${index + 1}`}
              className="h-9 flex-1 font-mono text-xs"
              placeholder="KEY"
              value={row.key}
              disabled={row.existing}
              onChange={(event) =>
                onChange(
                  rows.map((current, currentIndex) =>
                    currentIndex === index ? { ...current, key: event.target.value } : current,
                  ),
                )
              }
            />
            <Input
              aria-label={`${label}值 ${index + 1}`}
              type="password"
              autoComplete="new-password"
              className="h-9 flex-1 font-mono text-xs"
              placeholder={row.existing ? "已设置，留空保持不变" : "值"}
              value={row.value}
              onChange={(event) =>
                onChange(
                  rows.map((current, currentIndex) =>
                    currentIndex === index ? { ...current, value: event.target.value } : current,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`删除${label} ${index + 1}`}
              onClick={() => onChange(rows.filter((_, currentIndex) => currentIndex !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1"
        onClick={() => onChange([...rows, blankRow()])}
      >
        <Plus className="h-3 w-3" />
        添加{label}
      </Button>
      <p className={fieldHintClass}>{hint}</p>
    </div>
  );
}

export function McpEditor({
  server,
  datasources,
  saving,
  deleting,
  testing,
  error,
  deleteError,
  testResult,
  testError,
  onSave,
  onDelete,
  onTest,
  onClose,
}: McpEditorProps) {
  const [form, setForm] = useState<FormState>(() => initialForm(server));
  const [baseline] = useState<FormState>(() => initialForm(server));
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

  const stdio = form.transport === "stdio";

  const submit = () => {
    if (busy) return;
    onSave({
      name: form.name.trim(),
      transport: form.transport,
      enabled: form.enabled,
      datasourceId: form.datasourceId,
      ...(stdio
        ? {
            command: form.command.trim(),
            args: parseArgsText(form.argsText),
            env: serializeSecretRows(form.env),
            url: null,
          }
        : {
            url: form.url.trim(),
            headers: serializeSecretRows(form.headers),
            command: null,
            args: [],
          }),
    });
  };

  const title = server ? "编辑 MCP 服务器" : "新建 MCP 服务器";

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
                <p
                  role="alert"
                  className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600"
                >
                  {error}
                </p>
              ) : null}

              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="mcp-name">
                  名称
                </label>
                <Input
                  id="mcp-name"
                  value={form.name}
                  placeholder="github-tools"
                  autoComplete="off"
                  onChange={(event) => update("name", event.target.value)}
                />
                <p className={fieldHintClass}>
                  2-64 位小写字母、数字、下划线或短横线，且以字母或数字开头；全局唯一。
                </p>
              </div>

              <div className="space-y-1.5">
                <span className={labelClass}>传输方式</span>
                <div role="group" aria-label="传输方式" className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={stdio ? "primary" : "outline"}
                    aria-pressed={stdio}
                    onClick={() => update("transport", "stdio")}
                  >
                    stdio（本地命令）
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={stdio ? "outline" : "primary"}
                    aria-pressed={!stdio}
                    onClick={() => update("transport", "http")}
                  >
                    HTTP（远程地址）
                  </Button>
                </div>
              </div>

              {stdio ? (
                <>
                  <div className="space-y-1.5">
                    <label className={labelClass} htmlFor="mcp-command">
                      命令
                    </label>
                    <Input
                      id="mcp-command"
                      value={form.command}
                      placeholder="npx"
                      autoComplete="off"
                      className="font-mono text-xs"
                      onChange={(event) => update("command", event.target.value)}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className={labelClass} htmlFor="mcp-args">
                      参数（每行一个）
                    </label>
                    <Textarea
                      id="mcp-args"
                      rows={4}
                      spellCheck={false}
                      className="font-mono text-xs leading-relaxed"
                      placeholder={"-y\n@modelcontextprotocol/server-github"}
                      value={form.argsText}
                      onChange={(event) => update("argsText", event.target.value)}
                    />
                    <p className={fieldHintClass}>密钥请放 env/headers，不要放 URL/args。</p>
                  </div>

                  <SecretRowsEditor
                    label="环境变量"
                    hint="最多 30 个；值以密文保存，编辑时留空表示保持原值。"
                    rows={form.env}
                    onChange={(rows) => update("env", rows)}
                  />
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <label className={labelClass} htmlFor="mcp-url">
                      URL
                    </label>
                    <Input
                      id="mcp-url"
                      value={form.url}
                      placeholder="https://mcp.example.com/mcp"
                      autoComplete="off"
                      className="font-mono text-xs"
                      onChange={(event) => update("url", event.target.value)}
                    />
                    <p className={fieldHintClass}>仅支持 http(s) 地址。密钥请放 env/headers，不要放 URL/args。</p>
                  </div>

                  <SecretRowsEditor
                    label="请求头"
                    hint="最多 30 个；值以密文保存，编辑时留空表示保持原值。"
                    rows={form.headers}
                    onChange={(rows) => update("headers", rows)}
                  />
                </>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className={labelClass} htmlFor="mcp-datasource">
                    数据源
                  </label>
                  <select
                    id="mcp-datasource"
                    className="h-10 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:border-neutral-500 focus-visible:outline-none"
                    value={form.datasourceId ?? ""}
                    onChange={(event) => update("datasourceId", event.target.value || null)}
                  >
                    <option value="">全局（所有数据源）</option>
                    {datasources.map((datasource) => (
                      <option key={datasource.id} value={datasource.id}>
                        {datasource.name}（{datasource.type === "mysql" ? "MySQL" : "PostgreSQL"}）
                      </option>
                    ))}
                  </select>
                </div>

                <label className="mt-6 flex w-fit items-center gap-2 text-sm text-neutral-700">
                  <input
                    id="mcp-enabled"
                    type="checkbox"
                    className="h-4 w-4 rounded border-neutral-300"
                    checked={form.enabled}
                    onChange={(event) => update("enabled", event.target.checked)}
                  />
                  启用
                </label>
              </div>

              <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-neutral-600">连接测试</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!server || testing || busy}
                    title={server ? undefined : "保存后可测试连接"}
                    onClick={onTest}
                  >
                    {testing ? "测试中…" : "测试连接"}
                  </Button>
                </div>

                {!server ? (
                  <p className={fieldHintClass}>保存后可测试连接。</p>
                ) : null}

                {testing ? (
                  <p role="status" className="text-xs text-neutral-500">
                    正在调用 tools/list 获取工具列表…
                  </p>
                ) : null}

                {testError ? (
                  <p role="alert" className="text-xs text-red-600">
                    {testError}
                  </p>
                ) : null}

                {testResult ? (
                  testResult.ok ? (
                    <div className="space-y-1 text-xs text-neutral-600">
                      <p role="status">
                        连接成功，发现 {testResult.tools.length} 个工具
                        {testResult.serverInfo
                          ? `（${testResult.serverInfo.name} ${testResult.serverInfo.version}）`
                          : ""}
                        。
                      </p>
                      {testResult.tools.length ? (
                        <ul className="space-y-0.5">
                          {testResult.tools.slice(0, 5).map((tool) => (
                            <li key={tool.name} className="truncate">
                              <span className="font-mono text-[11px] text-neutral-700">
                                {tool.name}
                              </span>
                              {tool.description ? (
                                <span className="ml-1 text-[11px] text-neutral-400">
                                  — {tool.description}
                                </span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className={fieldHintClass}>该服务器没有提供工具。</p>
                      )}
                      {testResult.tools.length > 5 ? (
                        <p className={fieldHintClass}>仅显示前 5 个。</p>
                      ) : null}
                    </div>
                  ) : (
                    <p role="alert" className="text-xs text-red-600">
                      连接失败：{testResult.error ?? "未知错误"}
                    </p>
                  )
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 p-3">
              <div>
                {server ? (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => setDeleteOpen(true)}
                  >
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
          title="删除 MCP 服务器"
          description={`确定删除“${server?.name ?? ""}”？此操作不可恢复，之后的对话将不再使用它。`}
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
