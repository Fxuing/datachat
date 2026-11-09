import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { DatasourceInput } from "@datachat/shared";
import type { DatasourceSummary } from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export interface DatasourceEditorProps {
  /** null creates a new datasource; password is only sent when non-empty. */
  datasource: DatasourceSummary | null;
  saving: boolean;
  error: string | null;
  onSave: (input: DatasourceInput) => void;
  onClose: () => void;
}

type DatasourceType = DatasourceSummary["type"];
type SslMode = DatasourceSummary["sslMode"];

interface FormState {
  name: string;
  type: DatasourceType;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslMode: SslMode;
}

const DEFAULT_PORTS: Record<DatasourceType, number> = {
  mysql: 3306,
  postgres: 5432,
};

function initialForm(datasource: DatasourceSummary | null): FormState {
  return {
    name: datasource?.name ?? "",
    type: datasource?.type ?? "mysql",
    host: datasource?.host ?? "",
    port: String(datasource?.port ?? DEFAULT_PORTS.mysql),
    database: datasource?.database ?? "",
    username: datasource?.username ?? "",
    password: "",
    sslMode: datasource?.sslMode ?? "disable",
  };
}

const labelClass = "block text-xs font-medium text-muted";
const selectClass =
  "h-10 w-full rounded-md border border-linestrong bg-surface px-3 text-sm text-ink disabled:bg-subtle disabled:text-muted focus-visible:border-linestrong focus-visible:outline-none";

export function DatasourceEditor({
  datasource,
  saving,
  error,
  onSave,
  onClose,
}: DatasourceEditorProps) {
  const [form, setForm] = useState<FormState>(() => initialForm(datasource));
  const [portTouched, setPortTouched] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const editing = datasource !== null;
  const title = editing ? "编辑数据源" : "新建数据源";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const changeType = (type: DatasourceType) => {
    setForm((current) => ({
      ...current,
      type,
      // Never overwrite a port the admin typed themselves.
      port: portTouched ? current.port : String(DEFAULT_PORTS[type]),
    }));
  };

  const submit = () => {
    if (saving) return;
    const name = form.name.trim();
    const host = form.host.trim();
    const database = form.database.trim();
    const username = form.username.trim();
    const port = Number(form.port);

    let message: string | null = null;
    if (!name) message = "请填写数据源名称。";
    else if (!host) message = "请填写主机地址。";
    else if (!Number.isInteger(port) || port < 1 || port > 65535) {
      message = "端口需为 1-65535 的整数。";
    } else if (!database) message = "请填写数据库名。";
    else if (!username) message = "请填写用户名。";
    else if (!editing && !form.password) message = "新建数据源时必须填写密码。";

    if (message) {
      setValidationError(message);
      return;
    }
    setValidationError(null);

    onSave({
      name,
      type: form.type,
      host,
      port,
      database,
      username,
      sslMode: form.sslMode,
      // Editing with a blank password keeps the stored secret.
      ...(form.password ? { password: form.password } : {}),
    });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/30"
      role="presentation"
      onMouseDown={() => {
        if (!saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex h-full w-full max-w-lg flex-col border-l border-line bg-surface shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <Button variant="ghost" size="icon" aria-label="关闭" disabled={saving} onClick={onClose}>
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
              <p role="alert" className="rounded-md border border-danger/20 bg-dangersoft px-3 py-2 text-xs text-danger">
                {error}
              </p>
            ) : null}
            {validationError ? (
              <p role="alert" className="rounded-md border border-warning/25 bg-warningsoft px-3 py-2 text-xs text-warning">
                {validationError}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <label className={labelClass} htmlFor="datasource-name">
                名称
              </label>
              <Input
                id="datasource-name"
                value={form.name}
                placeholder="analytics"
                autoComplete="off"
                onChange={(event) => update("name", event.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="datasource-type">
                  类型
                </label>
                <select
                  id="datasource-type"
                  className={selectClass}
                  value={form.type}
                  disabled={editing}
                  onChange={(event) => changeType(event.target.value as DatasourceType)}
                >
                  <option value="mysql">MySQL</option>
                  <option value="postgres">PostgreSQL</option>
                </select>
                {editing ? (
                  <p className="text-[11px] text-muted">数据源类型创建后不可修改。</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="datasource-ssl">
                  SSL 模式
                </label>
                <select
                  id="datasource-ssl"
                  className={selectClass}
                  value={form.sslMode}
                  onChange={(event) => update("sslMode", event.target.value as SslMode)}
                >
                  <option value="disable">disable</option>
                  <option value="require">require</option>
                  <option value="no-verify">no-verify</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-[1fr_8rem] gap-3">
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="datasource-host">
                  主机
                </label>
                <Input
                  id="datasource-host"
                  value={form.host}
                  placeholder="127.0.0.1"
                  autoComplete="off"
                  onChange={(event) => update("host", event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="datasource-port">
                  端口
                </label>
                <Input
                  id="datasource-port"
                  type="number"
                  min={1}
                  max={65535}
                  inputMode="numeric"
                  value={form.port}
                  onChange={(event) => {
                    setPortTouched(true);
                    update("port", event.target.value);
                  }}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className={labelClass} htmlFor="datasource-database">
                数据库
              </label>
              <Input
                id="datasource-database"
                value={form.database}
                placeholder="app"
                autoComplete="off"
                onChange={(event) => update("database", event.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="datasource-username">
                  用户名
                </label>
                <Input
                  id="datasource-username"
                  value={form.username}
                  placeholder="reader"
                  autoComplete="off"
                  onChange={(event) => update("username", event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="datasource-password">
                  密码
                </label>
                <Input
                  id="datasource-password"
                  type="password"
                  value={form.password}
                  placeholder={editing ? "留空表示不修改" : "必填"}
                  autoComplete="new-password"
                  onChange={(event) => update("password", event.target.value)}
                />
              </div>
            </div>

            {editing ? (
              <p className="text-[11px] text-muted">
                修改主机或端口时必须重新输入密码。
              </p>
            ) : null}

            {form.sslMode === "no-verify" ? (
              <p className="rounded-md border border-warning/25 bg-warningsoft px-3 py-2 text-xs text-warning">
                警告：no-verify 将跳过服务器证书校验，仅建议在可信网络中临时使用。
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
            <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
