import { useState } from "react";
import { X } from "lucide-react";
import type { DatasourceInput } from "@datachat/shared";
import type {
  DatasourceSummary,
  OptionFieldSchema,
  PublicDriverDescriptor,
} from "../../lib/api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "../ui/sheet";

export interface DatasourceEditorProps {
  /** null creates a new datasource; password is only sent when non-empty. */
  datasource: DatasourceSummary | null;
  drivers?: PublicDriverDescriptor[];
  saving: boolean;
  error: string | null;
  onSave: (input: DatasourceInput) => void;
  onClose: () => void;
}

type DatasourceType = DatasourceSummary["type"];
type SslMode = DatasourceSummary["sslMode"];

const FALLBACK_DRIVERS: PublicDriverDescriptor[] = [
  {
    sdkVersion: 1,
    id: "mysql",
    label: "MySQL",
    connectionMode: "network",
    defaultPort: 3306,
    supportsSsl: true,
    optionsSchema: [],
    capabilities: { explain: true, readOnlyProbe: true, rowScope: true },
    builtin: true,
  },
  {
    sdkVersion: 1,
    id: "postgres",
    label: "PostgreSQL",
    connectionMode: "network",
    defaultPort: 5432,
    supportsSsl: true,
    optionsSchema: [],
    capabilities: { explain: true, readOnlyProbe: true, rowScope: true },
    builtin: true,
  },
];

interface FormState {
  name: string;
  type: DatasourceType;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  sslMode: SslMode;
  allowWriteAccount: boolean;
  options: Record<string, string | boolean>;
}

function defaultPortFor(type: string, drivers: PublicDriverDescriptor[]): number {
  const driver = drivers.find((d) => d.id === type);
  if (driver?.defaultPort) return driver.defaultPort;
  return type === "postgres" ? 5432 : 3306;
}

function isSecretField(field: OptionFieldSchema): boolean {
  return field.type !== "select" && field.secret === true;
}

function initialOptionsFor(
  driver: PublicDriverDescriptor | undefined,
  existing?: Record<string, string | number | boolean>,
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  if (!driver) return result;
  for (const field of driver.optionsSchema) {
    if (isSecretField(field)) {
      result[field.key] = "";
      continue;
    }
    const existingVal = existing?.[field.key];
    if (existingVal !== undefined) {
      result[field.key] = field.type === "boolean" ? Boolean(existingVal) : String(existingVal);
      continue;
    }
    if (field.defaultValue !== undefined) {
      result[field.key] =
        field.type === "boolean" ? Boolean(field.defaultValue) : String(field.defaultValue);
      continue;
    }
    result[field.key] = field.type === "boolean" ? false : "";
  }
  return result;
}

function initialForm(
  datasource: DatasourceSummary | null,
  drivers: PublicDriverDescriptor[],
): FormState {
  const initialType = datasource?.type ?? drivers[0]?.id ?? "mysql";
  const driver = drivers.find((d) => d.id === initialType);
  return {
    name: datasource?.name ?? "",
    type: initialType,
    host: datasource?.host ?? "",
    port: String(datasource?.port ?? defaultPortFor(initialType, drivers)),
    database: datasource?.database ?? "",
    username: datasource?.username ?? "",
    password: "",
    sslMode: datasource?.sslMode ?? "disable",
    allowWriteAccount: datasource?.allowWriteAccount ?? false,
    options: initialOptionsFor(driver, datasource?.options),
  };
}

const labelClass = "block text-xs font-medium text-muted";

export function DatasourceEditor({
  datasource,
  drivers,
  saving,
  error,
  onSave,
  onClose,
}: DatasourceEditorProps) {
  const availableDrivers = drivers && drivers.length > 0 ? drivers : FALLBACK_DRIVERS;
  const [form, setForm] = useState<FormState>(() => initialForm(datasource, availableDrivers));
  const [portTouched, setPortTouched] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const editing = datasource !== null;
  const title = editing ? "编辑数据源" : "新建数据源";
  const selectedDriver = availableDrivers.find((d) => d.id === form.type);
  const secretKeys = new Set(datasource?.secretOptionKeys ?? []);
  const supportsSsl = selectedDriver?.supportsSsl !== false;
  const optionFields = selectedDriver?.optionsSchema ?? [];

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const updateOption = (key: string, value: string | boolean) => {
    setForm((current) => ({
      ...current,
      options: { ...current.options, [key]: value },
    }));
  };

  const changeType = (type: DatasourceType) => {
    const nextDriver = availableDrivers.find((d) => d.id === type);
    setForm((current) => ({
      ...current,
      type,
      // Never overwrite a port the admin typed themselves.
      port: portTouched ? current.port : String(defaultPortFor(type, availableDrivers)),
      sslMode: nextDriver?.supportsSsl === false ? "disable" : current.sslMode,
      options: initialOptionsFor(nextDriver),
    }));
  };

  const buildSubmittedOptions = ():
    | { ok: true; options?: Record<string, string | number | boolean> }
    | { ok: false; message: string } => {
    if (optionFields.length === 0) return { ok: true };
    const out: Record<string, string | number | boolean> = {};
    for (const field of optionFields) {
      const raw = form.options[field.key];
      if (field.type === "boolean") {
        out[field.key] = Boolean(raw);
        continue;
      }
      const str = typeof raw === "string" ? raw.trim() : "";
      if (isSecretField(field)) {
        if (!str) {
          if (field.required && !(editing && secretKeys.has(field.key))) {
            return { ok: false, message: `请填写「${field.label}」。` };
          }
          continue;
        }
        out[field.key] = str;
        continue;
      }
      if (!str) {
        if (field.required) {
          return { ok: false, message: `请填写「${field.label}」。` };
        }
        continue;
      }
      if (field.type === "number") {
        const num = Number(str);
        if (!Number.isFinite(num)) {
          return { ok: false, message: `「${field.label}」必须是有效数字。` };
        }
        out[field.key] = num;
      } else {
        out[field.key] = str;
      }
    }
    return { ok: true, options: out };
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

    const parsedOptions = message ? null : buildSubmittedOptions();
    if (!message && parsedOptions && !parsedOptions.ok) {
      message = parsedOptions.message;
    }

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
      sslMode: supportsSsl ? form.sslMode : "disable",
      allowWriteAccount: form.allowWriteAccount,
      // Editing with a blank password keeps the stored secret.
      ...(form.password ? { password: form.password } : {}),
      ...(parsedOptions && parsedOptions.ok && parsedOptions.options
        ? { options: parsedOptions.options }
        : {}),
    });
  };

  const renderOptionField = (field: OptionFieldSchema) => {
    const inputId = `datasource-opt-${field.key}`;
    const value = form.options[field.key];
    if (field.type === "boolean") {
      return (
        <label
          key={field.key}
          htmlFor={inputId}
          className="flex items-start gap-2.5 rounded-md border border-line bg-subtle/40 px-3 py-2"
        >
          <input
            id={inputId}
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[rgb(var(--brand))]"
            checked={Boolean(value)}
            onChange={(event) => updateOption(field.key, event.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-ink">{field.label}</span>
            {field.description ? (
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                {field.description}
              </span>
            ) : null}
          </span>
        </label>
      );
    }

    if (field.type === "select") {
      const currentValue = typeof value === "string" ? value : "";
      return (
        <div key={field.key} className="space-y-1.5">
          <label className={labelClass} htmlFor={inputId}>
            {field.label}
            {field.required ? <span className="ml-0.5 text-danger">*</span> : null}
          </label>
          <Select
            value={currentValue}
            onValueChange={(next) => updateOption(field.key, next)}
          >
            <SelectTrigger id={inputId}>
              <SelectValue placeholder="请选择" />
            </SelectTrigger>
            <SelectContent>
              {field.options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {field.description ? <p className="text-[11px] text-muted">{field.description}</p> : null}
        </div>
      );
    }

    const isStoredSecret = Boolean(field.secret && editing && secretKeys.has(field.key));
    return (
      <div key={field.key} className="space-y-1.5">
        <label className={labelClass} htmlFor={inputId}>
          {field.label}
          {field.required ? <span className="ml-0.5 text-danger">*</span> : null}
        </label>
        <Input
          id={inputId}
          type={field.secret ? "password" : field.type === "number" ? "number" : "text"}
          value={typeof value === "string" ? value : ""}
          placeholder={
            isStoredSecret
              ? "已配置，留空保持不变"
              : field.placeholder ?? (field.required ? "必填" : "")
          }
          autoComplete={field.secret ? "new-password" : "off"}
          onChange={(event) => updateOption(field.key, event.target.value)}
        />
        {field.description ? <p className="text-[11px] text-muted">{field.description}</p> : null}
      </div>
    );
  };

  return (
    <Sheet open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <SheetContent
        hideClose
        className="max-w-lg"
        onInteractOutside={(event) => { if (saving) event.preventDefault(); }}
      >
        <SheetHeader className="h-14 flex-row items-center justify-between gap-3 px-4 py-0">
          <SheetTitle className="text-sm">{title}</SheetTitle>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" aria-label="关闭" disabled={saving}>
              <X className="h-4 w-4" />
            </Button>
          </SheetClose>
        </SheetHeader>

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
            {editing && datasource.driverAvailable === false ? (
              <p className="rounded-md border border-warning/25 bg-warningsoft px-3 py-2 text-xs text-warning">
                该数据源对应的驱动插件（{datasource.type}）当前未加载，无法测试或查询；如需继续使用请在服务端配置 DATASOURCE_PLUGINS。
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

            <div className={supportsSsl ? "grid grid-cols-2 gap-3" : "space-y-1.5"}>
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="datasource-type">
                  类型
                </label>
                <Select
                  value={form.type}
                  onValueChange={(value) => changeType(value)}
                  disabled={editing}
                >
                  <SelectTrigger id="datasource-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableDrivers.map((driver) => (
                      <SelectItem key={driver.id} value={driver.id}>
                        {driver.label}
                        {!driver.builtin ? "（插件）" : ""}
                      </SelectItem>
                    ))}
                    {!selectedDriver ? (
                      <SelectItem value={form.type}>
                        {datasource?.driverLabel ?? form.type}（未安装）
                      </SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
                {editing ? (
                  <p className="text-[11px] text-muted">数据源类型创建后不可修改。</p>
                ) : null}
              </div>

              {supportsSsl ? (
                <div className="space-y-1.5">
                  <label className={labelClass} htmlFor="datasource-ssl">
                    SSL 模式
                  </label>
                  <Select
                    value={form.sslMode}
                    onValueChange={(value) => update("sslMode", value as SslMode)}
                  >
                    <SelectTrigger id="datasource-ssl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="disable">disable</SelectItem>
                      <SelectItem value="require">require</SelectItem>
                      <SelectItem value="no-verify">no-verify</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
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

            {optionFields.length > 0 ? (
              <div className="space-y-3 rounded-lg border border-line bg-subtle/30 p-3">
                <p className="text-xs font-medium text-ink">
                  {selectedDriver?.label} 扩展参数
                </p>
                {optionFields.map(renderOptionField)}
              </div>
            ) : null}

            <label className="flex items-start gap-2.5 rounded-md border border-line bg-subtle/50 px-3 py-2.5">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[rgb(var(--brand))]"
                checked={form.allowWriteAccount}
                onChange={(event) => update("allowWriteAccount", event.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-ink">允许使用有写权限的账号</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">
                  例如 root。查询仍被 SQL 守卫和连接层强制只读，只是不再提示改用只读账号。
                </span>
              </span>
            </label>

            {supportsSsl && form.sslMode === "no-verify" ? (
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
      </SheetContent>
    </Sheet>
  );
}
