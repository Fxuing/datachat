import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { AdminShell } from "../../components/admin/AdminShell";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { PageSpinner } from "../../components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import {
  deleteScopeMapping,
  disableScope,
  enableScope,
  fetchMe,
  getDataScope,
  getScopeColumns,
  getScopeDenials,
  getScopeDiagnostics,
  importScopeMappings,
  listAdminUsers,
  listDatasources,
  previewScope,
  putScopePolicies,
  refreshDatasourceSchema,
  type ScopePolicyInput,
  type ScopePolicyMode,
  type ScopeRuleInput,
  type ScopeRuleOperator,
  type ScopeValueMode,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import { cn } from "../../lib/utils";

const VALUE_MODE_LABELS: Record<ScopeValueMode, string> = {
  literal: "固定值",
  department_id: "部门 ID（本系统）",
  department_code: "部门编码（本系统）",
  external_id: "外部组织 ID",
  external_code: "外部组织编码",
  external_org_code: "外部组织 code",
  user_id: "当前用户 ID",
  username: "当前用户名",
  role: "当前用户角色",
};

const OPERATOR_LABELS: Record<ScopeRuleOperator, string> = {
  eq: "等于",
  in: "属于（IN）",
  not_in: "不属于（NOT IN）",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
};

function splitValues(raw: string): string[] {
  return raw
    .split(/[,，、]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function ruleSummary(rule: ScopeRuleInput): string {
  const values =
    (rule.valueMode ?? "literal") === "literal"
      ? `（${(rule.literalValues ?? []).join("、") || "未填"}）`
      : "";
  return `${rule.columnName || "未选字段"} ${OPERATOR_LABELS[rule.operator ?? "eq"]} ${
    VALUE_MODE_LABELS[rule.valueMode ?? "literal"]
  }${values}${rule.nullVisible ? " · 空值可见" : ""}`;
}

const MODE_LABELS: Record<ScopePolicyMode, string> = {
  scoped: "按条件过滤",
  public: "所有人可见",
  denied: "拒绝访问",
};

const labelClass = "block text-xs font-medium text-muted";

interface DraftPolicy extends ScopePolicyInput {
  tableName: string;
  rules: ScopeRuleInput[];
}

interface ScopeRulesDialogProps {
  tableName: string;
  columns: { name: string; type: string; comment: string | null }[];
  initialRules: ScopeRuleInput[];
  onClose: () => void;
  onSave: (rules: ScopeRuleInput[]) => void;
}

const COMPARISON_OPERATORS = new Set<ScopeRuleOperator>(["gt", "gte", "lt", "lte"]);
const MULTI_VALUE_MODES = new Set<ScopeValueMode>([
  "department_id",
  "department_code",
  "external_id",
  "external_code",
  "external_org_code",
]);

interface EditableRule extends ScopeRuleInput {
  /** Raw text keeps trailing commas/spaces intact while typing multiple literals. */
  rawLiteral: string;
}

function toEditableRule(rule: ScopeRuleInput): EditableRule {
  return {
    ...rule,
    rawLiteral: (rule.literalValues ?? []).join(", "),
  };
}

function ScopeRulesDialog({ tableName, columns, initialRules, onClose, onSave }: ScopeRulesDialogProps) {
  const [rules, setRules] = useState<EditableRule[]>(
    initialRules.length > 0
      ? initialRules.map(toEditableRule)
      : [
          {
            columnName: columns[0]?.name ?? "",
            operator: "in",
            valueMode: "department_id",
            nullVisible: false,
            rawLiteral: "",
          },
        ],
  );
  const patchRule = (index: number, patch: Partial<EditableRule>) =>
    setRules((current) => current.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  const invalid = rules.some((rule) => {
    if (!rule.columnName) return true;
    const operator = rule.operator ?? "eq";
    const valueMode = rule.valueMode ?? "literal";
    const count = (rule.literalValues ?? []).length;
    if (COMPARISON_OPERATORS.has(operator)) {
      return valueMode !== "literal" || count !== 1;
    }
    if (operator === "eq") {
      if (MULTI_VALUE_MODES.has(valueMode)) return true;
      if (valueMode === "literal") return count !== 1;
      return false;
    }
    return valueMode === "literal" && count === 0;
  });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>过滤条件 · {tableName}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-y-auto px-4 py-3">
          <p className="text-[11px] text-muted">
            多个条件按 AND 组合；固定值对所有用户（包括管理员）生效，部门/用户类取值随当前登录人变化。
          </p>
          {rules.map((rule, index) => {
            const valueMode = rule.valueMode ?? "literal";
            return (
              <div key={index} className="rounded-md border border-line p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-muted">条件 {index + 1}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px] text-danger"
                    aria-label={`删除条件 ${index + 1}`}
                    onClick={() => setRules((current) => current.filter((_, i) => i !== index))}
                  >
                    删除
                  </Button>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <label className="text-[11px] text-muted">
                    字段
                    <Select
                      value={rule.columnName}
                      onValueChange={(value) => patchRule(index, { columnName: value })}
                    >
                      <SelectTrigger className="mt-0.5 h-7" aria-label={`字段 ${index + 1}`}>
                        <SelectValue placeholder="选择列" />
                      </SelectTrigger>
                      <SelectContent>
                        {columns.map((column) => (
                          <SelectItem key={column.name} value={column.name}>
                            {column.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="text-[11px] text-muted">
                    操作
                    <Select
                      value={rule.operator ?? "eq"}
                      onValueChange={(value) =>
                        patchRule(index, { operator: value as ScopeRuleOperator })
                      }
                    >
                      <SelectTrigger className="mt-0.5 h-7" aria-label={`操作 ${index + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(OPERATOR_LABELS) as ScopeRuleOperator[]).map((operator) => (
                          <SelectItem key={operator} value={operator}>
                            {OPERATOR_LABELS[operator]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="text-[11px] text-muted">
                    取值
                    <Select
                      value={valueMode}
                      onValueChange={(value) =>
                        patchRule(index, { valueMode: value as ScopeValueMode })
                      }
                    >
                      <SelectTrigger className="mt-0.5 h-7" aria-label={`取值 ${index + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(VALUE_MODE_LABELS) as ScopeValueMode[]).map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {VALUE_MODE_LABELS[mode]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  {valueMode === "literal" ? (
                    <label className="text-[11px] text-muted">
                      固定值
                      <Input
                        className="mt-0.5 h-7 text-xs"
                        aria-label={`固定值 ${index + 1}`}
                        placeholder="多个值用逗号分隔"
                        value={rule.rawLiteral}
                        onChange={(event) => {
                          const rawLiteral = event.target.value;
                          patchRule(index, { rawLiteral, literalValues: splitValues(rawLiteral) });
                        }}
                      />
                    </label>
                  ) : (
                    <div className="text-[11px] text-muted">
                      预览
                      <p className="mt-1 truncate text-ink">
                        {VALUE_MODE_LABELS[valueMode]}
                      </p>
                    </div>
                  )}
                </div>
                <label className="mt-1 flex items-center gap-1 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-brand"
                    aria-label={`允许空值 ${index + 1}`}
                    checked={rule.nullVisible ?? false}
                    onChange={(event) => patchRule(index, { nullVisible: event.target.checked })}
                  />
                  字段为空的行也可见
                </label>
              </div>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setRules((current) => [
                ...current,
                {
                  columnName: columns[0]?.name ?? "",
                  operator: "in",
                  valueMode: "department_id",
                  nullVisible: false,
                  rawLiteral: "",
                },
              ])
            }
          >
            添加条件
          </Button>
        </div>
        <DialogFooter>
          {invalid ? (
            <span className="mr-auto text-[11px] text-warning">
              比较操作仅支持单个固定值；部门/组织类取值或多个固定值请使用 IN / NOT IN
            </span>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={invalid || rules.length === 0}
            onClick={() =>
              onSave(
                rules.map(({ rawLiteral: _raw, ...rest }) => rest),
              )
            }
          >
            保存条件
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DatasourceScopePage() {
  const { datasourceId } = useParams<{ datasourceId: string }>();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, DraftPolicy>>({});
  const [tableFilter, setTableFilter] = useState("");
  const [csv, setCsv] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [previewSql, setPreviewSql] = useState("select * from ");
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [editing, setEditing] = useState<{ table: string; rules: ScopeRuleInput[] } | null>(null);
  const [confirmMode, setConfirmMode] = useState<"enable" | "disable" | null>(null);

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const datasourcesQuery = useQuery({ queryKey: queryKeys.datasources, queryFn: listDatasources });
  const scopeQuery = useQuery({
    queryKey: queryKeys.dataScope(datasourceId ?? ""),
    queryFn: () => getDataScope(datasourceId as string),
    enabled: Boolean(datasourceId),
  });
  const columnsQuery = useQuery({
    queryKey: queryKeys.scopeColumns(datasourceId ?? ""),
    queryFn: () => getScopeColumns(datasourceId as string),
    enabled: Boolean(datasourceId),
    retry: false,
  });
  const usersQuery = useQuery({ queryKey: queryKeys.adminUsers, queryFn: listAdminUsers });

  const scope = scopeQuery.data;
  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data]);

  useEffect(() => {
    if (!scope) return;
    // Merge instead of replacing: a background refetch must not discard edits.
    setDraft((prev) => {
      const next: Record<string, DraftPolicy> = { ...prev };
      for (const policy of scope.policies) {
        next[policy.tableName] ??= {
          tableName: policy.tableName,
          mode: policy.mode,
          rules: policy.rules,
          enabled: policy.enabled,
        };
      }
      for (const table of columnsQuery.data?.tables ?? []) {
        next[table.name] ??= { tableName: table.name, mode: "public", rules: [] };
      }
      return next;
    });
  }, [scope, columnsQuery.data]);

  useEffect(() => {
    const first = users[0];
    if (!selectedUserId && first) setSelectedUserId(first.id);
  }, [selectedUserId, users]);

  const diagnosticsQuery = useQuery({
    queryKey: queryKeys.scopeDiagnostics(datasourceId ?? "", selectedUserId),
    queryFn: () => getScopeDiagnostics(datasourceId as string, selectedUserId),
    enabled: Boolean(datasourceId && selectedUserId),
  });
  const denialsQuery = useQuery({
    queryKey: queryKeys.scopeDenials(datasourceId ?? ""),
    queryFn: () => getScopeDenials(datasourceId as string),
    enabled: Boolean(datasourceId),
  });

  const datasource = datasourcesQuery.data?.datasources.find((row) => row.id === datasourceId);
  const tableNames = useMemo(
    () => (columnsQuery.data?.tables ?? []).map((table) => table.name),
    [columnsQuery.data],
  );
  const allTableNames = useMemo(
    () => (tableNames.length > 0 ? tableNames : Object.keys(draft)),
    [draft, tableNames],
  );
  const visibleTableNames = useMemo(() => {
    const needle = tableFilter.trim().toLowerCase();
    if (!needle) return allTableNames;
    return allTableNames.filter((name) => name.toLowerCase().includes(needle));
  }, [allTableNames, tableFilter]);
  const scopeCounts = useMemo(() => {
    let scoped = 0;
    let denied = 0;
    let publicCount = 0;
    for (const name of allTableNames) {
      const mode = draft[name]?.mode ?? "public";
      if (mode === "scoped") scoped += 1;
      else if (mode === "denied") denied += 1;
      else publicCount += 1;
    }
    return { scoped, denied, public: publicCount };
  }, [allTableNames, draft]);

  const dirty = useMemo(() => {
    if (!scope) return false;
    const current = JSON.stringify(
      (scope.policies ?? []).map((row) => ({
        tableName: row.tableName,
        mode: row.mode,
        rules: row.rules.map((rule) => ({
          columnName: rule.columnName,
          operator: rule.operator,
          valueMode: rule.valueMode,
          literalValues: rule.literalValues,
          nullVisible: rule.nullVisible,
        })),
      })),
    );
    const next = JSON.stringify(
      Object.values(draft)
        .filter((row) => row.enabled !== false)
        .sort((a, b) => a.tableName.localeCompare(b.tableName))
        .map((row) => ({
          tableName: row.tableName,
          mode: row.mode,
          rules: (row.rules ?? []).map((rule) => ({
            columnName: rule.columnName,
            operator: rule.operator ?? "eq",
            valueMode: rule.valueMode ?? "literal",
            literalValues: rule.literalValues ?? [],
            nullVisible: rule.nullVisible ?? false,
          })),
        })),
    );
    return current !== next;
  }, [draft, scope]);

  const savePolicies = useMutation({
    mutationFn: () =>
      putScopePolicies(
        datasourceId as string,
        Object.values(draft).map((row) => ({
          tableName: row.tableName,
          mode: row.mode,
          ...(row.mode === "scoped"
            ? {
                rules: row.rules.map((rule) => ({
                  columnName: rule.columnName,
                  operator: rule.operator,
                  valueMode: rule.valueMode,
                  literalValues: rule.literalValues ?? [],
                  nullVisible: rule.nullVisible ?? false,
                })),
              }
            : { rules: [] }),
        })),
      ),
    onSuccess: (result) => {
      setBanner({ tone: "ok", text: `已保存 ${result.policies.length} 条表策略` });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataScope(datasourceId ?? "") });
    },
    onError: (error) => setBanner({ tone: "error", text: describeApiError(error, "保存策略失败") }),
  });

  const importMappings = useMutation({
    mutationFn: () => importScopeMappings(datasourceId as string, { csv }),
    onSuccess: (result) => {
      setBanner({
        tone: result.errors.length > 0 ? "error" : "ok",
        text: `映射导入完成：新增 ${result.inserted}、更新 ${result.updated}${result.errors.length ? `，${result.errors.length} 行失败：${result.errors[0]}` : ""}`,
      });
      setCsv("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataScope(datasourceId ?? "") });
    },
    onError: (error) => setBanner({ tone: "error", text: describeApiError(error, "导入映射失败") }),
  });

  const deleteMapping = useMutation({
    mutationFn: (departmentId: string) => deleteScopeMapping(datasourceId as string, departmentId),
    onSuccess: () => {
      setBanner({ tone: "ok", text: "已删除组织映射" });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataScope(datasourceId ?? "") });
    },
    onError: (error) => setBanner({ tone: "error", text: describeApiError(error, "删除映射失败") }),
  });

  const refreshSchema = useMutation({
    mutationFn: () => refreshDatasourceSchema(datasourceId as string),
    onSuccess: (result) => {
      setBanner({ tone: "ok", text: `表结构已刷新，共 ${result.tableCount} 张表` });
      void queryClient.invalidateQueries({ queryKey: queryKeys.scopeColumns(datasourceId ?? "") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataScope(datasourceId ?? "") });
    },
    onError: (error) => setBanner({ tone: "error", text: describeApiError(error, "刷新表结构失败") }),
  });

  const preview = useMutation({
    mutationFn: () => previewScope(datasourceId as string, selectedUserId, previewSql),
    onError: (error) => setBanner({ tone: "error", text: describeApiError(error, "预览失败") }),
  });

  const enable = useMutation({
    mutationFn: () => enableScope(datasourceId as string),
    onSuccess: (result) => {
      setConfirmMode(null);
      setBanner({ tone: "ok", text: `已启用受控模式，撤销分享 ${result.revokedShares} 个` });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataScope(datasourceId ?? "") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.datasources });
    },
    onError: (error) => {
      setConfirmMode(null);
      setBanner({ tone: "error", text: describeApiError(error, "启用失败") });
    },
  });

  const disable = useMutation({
    mutationFn: () => disableScope(datasourceId as string),
    onSuccess: () => {
      setConfirmMode(null);
      setBanner({ tone: "ok", text: "已关闭受控模式，行级过滤不再生效" });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dataScope(datasourceId ?? "") });
      void queryClient.invalidateQueries({ queryKey: queryKeys.datasources });
    },
    onError: (error) => {
      setConfirmMode(null);
      setBanner({ tone: "error", text: describeApiError(error, "关闭失败") });
    },
  });

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;
  if (scopeQuery.isPending) {
    return (
      <AdminShell user={user}>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <PageSpinner label="加载数据权限…" />
        </div>
      </AdminShell>
    );
  }

  const unclassified = scope?.coverage.policies?.unclassified ?? [];

  const fillRemaining = (mode: "public" | "denied") => {
    setDraft((current) => {
      const next = { ...current };
      for (const name of allTableNames) {
        const row = next[name] ?? { tableName: name, mode: "public" as ScopePolicyMode, rules: [] };
        if (row.mode === "scoped") continue;
        next[name] = { ...row, tableName: name, mode };
      }
      return next;
    });
  };
  const unmapped = scope?.coverage.departments?.unmappedIds ?? [];
  const columnsFor = (tableName: string) =>
    columnsQuery.data?.tables.find((table) => table.name === tableName)?.columns ?? [];

  const update = (tableName: string, patch: Partial<DraftPolicy>) =>
    setDraft((current) => ({
      ...current,
      [tableName]: {
        ...(current[tableName] ?? { tableName, mode: "public", rules: [] }),
        ...patch,
        tableName,
      },
    }));

  return (
    <AdminShell user={user}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-ink">
                行级数据权限{datasource ? ` · ${datasource.name}` : ""}
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-muted">
                启用后，查询会被改写成按配置条件过滤的派生表；未分类的表一律拒绝，历史结果按生成时的数据范围快照判断可见性。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px]",
                  scope?.mode === "enabled"
                    ? "bg-successsoft text-success"
                    : "bg-subtle text-muted",
                )}
              >
                {scope?.mode === "enabled" ? "已启用" : "未启用"}
              </span>
              {scope?.mode === "enabled" ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  disabled={disable.isPending}
                  onClick={() => setConfirmMode("disable")}
                >
                  <ShieldOff className="h-3.5 w-3.5" />
                  关闭
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="gap-1"
                  disabled={enable.isPending}
                  onClick={() => setConfirmMode("enable")}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  启用
                </Button>
              )}
            </div>
          </div>

          {banner ? (
            <p
              role="alert"
              className={cn(
                "rounded-md px-3 py-2 text-xs",
                banner.tone === "ok" ? "bg-successsoft text-success" : "bg-dangersoft text-danger",
              )}
            >
              {banner.text}
            </p>
          ) : null}

          <section className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">1. 表分类</h2>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!columnsQuery.data?.autoMatched.length}
                  onClick={() =>
                    setDraft((current) => {
                      const next = { ...current };
                      for (const policy of columnsQuery.data?.autoMatched ?? []) {
                        next[policy.tableName] = {
                          tableName: policy.tableName,
                          mode: "scoped",
                          rules: policy.rules ?? [],
                        };
                      }
                      return next;
                    })
                  }
                >
                  套用候选列
                </Button>
                <Button size="sm" disabled={!dirty || savePolicies.isPending} onClick={() => savePolicies.mutate()}>
                  {savePolicies.isPending ? "保存中…" : "保存分类"}
                </Button>
              </div>
            </div>
            {columnsQuery.isError ? (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/30 bg-warningsoft px-3 py-2 text-xs text-warning">
                <span>
                  {describeApiError(columnsQuery.error, "数据源表结构尚未缓存，请先刷新表结构后再分类")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1"
                  disabled={refreshSchema.isPending}
                  onClick={() => refreshSchema.mutate()}
                >
                  <RefreshCw className={cn("h-3 w-3", refreshSchema.isPending && "animate-spin")} />
                  {refreshSchema.isPending ? "刷新中…" : "刷新表结构"}
                </Button>
              </div>
            ) : unclassified.length > 0 ? (
              <p className="mt-2 flex items-center gap-1 text-[11px] text-warning">
                <AlertTriangle className="h-3 w-3" />
                未分类 {unclassified.length} 张：{[...unclassified].slice(0, 5).join("、")}
                {unclassified.length > 5 ? ` 等` : ""}（未配置的表启用时会被拒绝）
              </p>
            ) : (
              <p className="mt-2 flex items-center gap-1 text-[11px] text-success">
                <CheckCircle2 className="h-3 w-3" />
                所有已缓存表均已分类：按条件过滤 {scopeCounts.scoped} 张 · 拒绝 {scopeCounts.denied} 张 · 所有人可见 {scopeCounts.public} 张
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                value={tableFilter}
                onChange={(event) => setTableFilter(event.target.value)}
                placeholder="按表名筛选"
                aria-label="筛选表"
                className="h-7 w-52 text-xs"
              />
              {tableFilter ? (
                <span className="text-[11px] text-muted">
                  {visibleTableNames.length} / {allTableNames.length} 张
                </span>
              ) : null}
              <div className="ml-auto flex flex-wrap items-center gap-1">
                <span className="mr-1 text-[11px] text-muted">其余表批量设为</span>
                <Button variant="outline" size="sm" onClick={() => fillRemaining("public")}>
                  所有人可见
                </Button>
                <Button variant="outline" size="sm" onClick={() => fillRemaining("denied")}>
                  拒绝
                </Button>
              </div>
            </div>
            <p className="mt-1 text-[11px] text-muted">
              已设为“按条件过滤”的表不会被批量操作覆盖。400+ 张表建议先把其余表批量设为拒绝，再只对需要的表编辑条件。
            </p>
            <p className="mt-2 text-[11px] text-muted">
              模式决定整张表能不能查：所有人可见 = 不加限制，按条件过滤 = 附加行条件，拒绝访问 = 整表不可查。条件在「编辑条件」里配置，多条按 AND 组合。
            </p>
            <div className="mt-1 max-h-96 overflow-y-auto overflow-x-auto rounded-md border border-line">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 z-10 bg-subtle text-muted">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">表</th>
                    <th className="px-2 py-1.5 font-medium">模式</th>
                    <th className="px-2 py-1.5 font-medium">条件</th>
                    <th className="px-2 py-1.5 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTableNames.map((tableName) => {
                    const row =
                      draft[tableName] ?? { tableName, mode: "public" as ScopePolicyMode, rules: [] };
                    const columns = columnsFor(tableName);
                    return (
                      <tr key={tableName} className="border-t border-line">
                        <td className="px-2 py-1.5 font-medium text-ink">{tableName}</td>
                        <td className="px-2 py-1.5">
                          <Select
                            value={row.mode}
                            onValueChange={(value) => {
                              const mode = value as ScopePolicyMode;
                              update(tableName, {
                                mode,
                                rules:
                                  mode === "scoped"
                                    ? (row.rules ?? []).length > 0
                                      ? (row.rules ?? [])
                                      : columns[0]
                                        ? [
                                            {
                                              columnName: columns[0].name,
                                              operator: "in",
                                              valueMode: "department_id",
                                              nullVisible: false,
                                            },
                                          ]
                                        : []
                                    : [],
                              });
                            }}
                          >
                            <SelectTrigger className="h-7 w-32" aria-label={`${tableName} 模式`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(MODE_LABELS) as ScopePolicyMode[]).map((mode) => (
                                <SelectItem key={mode} value={mode}>
                                  {MODE_LABELS[mode]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-2 py-1.5 text-muted">
                          {row.mode === "scoped" ? (
                            (row.rules ?? []).length > 0 ? (
                              <span className="block max-w-[22rem] truncate" title={(row.rules ?? []).map(ruleSummary).join(" 且 ")}>
                                {(row.rules ?? []).map(ruleSummary).join(" 且 ")}
                              </span>
                            ) : (
                              <span className="text-warning">未设置条件</span>
                            )
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {row.mode === "scoped" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7"
                              onClick={() => setEditing({ table: tableName, rules: row.rules ?? [] })}
                            >
                              编辑条件
                            </Button>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <h2 className="text-sm font-semibold text-ink">2. 部门组织映射</h2>
            <p className="mt-1 text-[11px] text-muted">
              使用「外部组织」取值时必须为每个部门配置映射；未映射的部门查询会整条失败。
              已映射 {scope?.coverage.departments?.mapped ?? 0} 个，未映射 {unmapped.length} 个
              {(scope?.coverage.departments?.unmappedDepartments ?? []).length > 0
                ? `（${(scope?.coverage.departments?.unmappedDepartments ?? [])
                    .slice(0, 5)
                    .map((row) => row.name)
                    .join("、")}${
                    (scope?.coverage.departments?.unmappedDepartments ?? []).length > 5 ? " 等" : ""
                  }）`
                : ""}
              。
            </p>
            <div className="mt-2 grid gap-3 md:grid-cols-2">
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="w-full text-left text-xs">
                  <thead className="bg-subtle text-muted">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">部门</th>
                      <th className="px-2 py-1.5 font-medium">外部 ID</th>
                      <th className="px-2 py-1.5 font-medium">外部编码</th>
                      <th className="px-2 py-1.5 font-medium">外部组织 code</th>
                      <th className="px-2 py-1.5 font-medium">来源</th>
                      <th className="px-2 py-1.5 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(scope?.mappings ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-2 py-4 text-center text-muted">
                          还没有映射
                        </td>
                      </tr>
                    ) : (
                      scope?.mappings.map((mapping) => (
                        <tr key={mapping.id} className="border-t border-line">
                          <td className="px-2 py-1.5">{mapping.departmentName}</td>
                          <td className="px-2 py-1.5">{mapping.externalId ?? "—"}</td>
                          <td className="px-2 py-1.5">{mapping.externalCode ?? "—"}</td>
                          <td className="px-2 py-1.5">{mapping.externalOrgCode ?? "—"}</td>
                          <td className="px-2 py-1.5 text-muted">
                            {mapping.source === "import" ? "导入" : "手工"}
                          </td>
                          <td className="px-2 py-1.5">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0 text-danger hover:bg-dangersoft hover:text-danger"
                                  aria-label={`删除 ${mapping.departmentName} 的映射`}
                                  disabled={deleteMapping.isPending}
                                  onClick={() => deleteMapping.mutate(mapping.departmentId)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top">删除映射</TooltipContent>
                            </Tooltip>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="space-y-1.5">
                <label className={labelClass} htmlFor="scope-csv">
                  CSV 导入（department_code, external_id, external_code, external_org_code）
                </label>
                <Textarea
                  id="scope-csv"
                  rows={5}
                  value={csv}
                  placeholder={"department_code,external_id,external_code\nsales,S-1,SC"}
                  onChange={(event) => setCsv(event.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={csv.trim() === "" || importMappings.isPending}
                  onClick={() => importMappings.mutate()}
                >
                  {importMappings.isPending ? "导入中…" : "导入映射"}
                </Button>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <h2 className="text-sm font-semibold text-ink">3. 诊断与预览</h2>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label className={labelClass} htmlFor="scope-user">
                  用户
                </label>
                <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                  <SelectTrigger id="scope-user" className="h-8 w-52">
                    <SelectValue placeholder="选择用户" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {row.displayName ?? row.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className={labelClass} htmlFor="scope-sql">
                  预览 SQL
                </label>
                <Input
                  id="scope-sql"
                  className="h-8 w-80"
                  value={previewSql}
                  onChange={(event) => setPreviewSql(event.target.value)}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedUserId || previewSql.trim() === "" || preview.isPending}
                onClick={() => preview.mutate()}
              >
                {preview.isPending ? "生成中…" : "预览改写"}
              </Button>
            </div>
            {preview.data ? (
              <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-subtle p-2 text-[11px] text-ink">
                {preview.data.sql}
                {"\n"}
                params: {JSON.stringify(preview.data.params)}
              </pre>
            ) : null}
            {diagnosticsQuery.data ? (
              <div className="mt-3 space-y-1 text-xs">
                <p className="text-muted">
                  部门：{diagnosticsQuery.data.departments.map((row) => row.name).join("、") || "无"} ·
                  数据源访问：{diagnosticsQuery.data.canAccessDatasource ? "有" : "无"}
                </p>
                <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line">
                  {diagnosticsQuery.data.tables.map((row) => (
                    <li key={row.table} className="flex items-center justify-between px-2 py-1.5">
                      <span className="text-ink">{row.table}</span>
                      <span className="text-muted">
                        {row.decision === "scoped"
                          ? `按 ${(row.rules ?? [])
                              .map((rule) => `${rule.column} ${OPERATOR_LABELS[rule.operator]}`)
                              .join(" 且 ")} 过滤`
                          : row.decision === "admin_all"
                            ? "管理员全量"
                            : row.decision === "public"
                              ? "所有人可见"
                              : row.decision === "denied"
                                ? "拒绝"
                                : row.decision === "unconfigured"
                                  ? "未分类（将拒绝）"
                                  : "未加入部门"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <section className="rounded-xl border border-line bg-surface p-4 shadow-card">
            <h2 className="text-sm font-semibold text-ink">4. 拒绝记录</h2>
            <ul className="mt-2 max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line text-xs">
              {(denialsQuery.data?.denials ?? []).length === 0 ? (
                <li className="px-2 py-4 text-center text-muted">暂无被拒绝的查询</li>
              ) : (
                denialsQuery.data?.denials.map((row) => (
                  <li key={row.id} className="px-2 py-1.5">
                    <span className="text-ink">{row.username ?? "未知用户"}</span>
                    <span className="ml-2 text-muted">{row.scopeReason}</span>
                    <p className="mt-0.5 truncate text-[11px] text-muted">{row.sqlText}</p>
                  </li>
                ))
              )}
            </ul>
          </section>
          {editing ? (
            <ScopeRulesDialog
              key={editing.table}
              tableName={editing.table}
              columns={columnsFor(editing.table)}
              initialRules={editing.rules}
              onClose={() => setEditing(null)}
              onSave={(rules) => {
                update(editing.table, { rules });
                setEditing(null);
              }}
            />
          ) : null}
          {confirmMode ? (
            <ConfirmDialog
              title={confirmMode === "enable" ? "启用行级数据权限" : "关闭行级数据权限"}
              description={
                confirmMode === "enable"
                  ? `启用后，未分类的表一律拒绝访问，并会立即撤销该数据源下所有公开分享链接。${
                      dirty ? "注意：当前有未保存的表分类修改，启用将按已保存的策略生效，建议先保存分类。" : ""
                    }`
                  : "关闭后，该数据源的行级过滤将不再生效，有访问权的用户可查询全表数据。确定关闭？"
              }
              confirmLabel={confirmMode === "enable" ? "确认启用" : "确认关闭"}
              variant={confirmMode === "disable" ? "danger" : "primary"}
              pending={enable.isPending || disable.isPending}
              onCancel={() => setConfirmMode(null)}
              onConfirm={() => {
                if (confirmMode === "enable") enable.mutate();
                else disable.mutate();
              }}
            />
          ) : null}
        </div>
      </div>
    </AdminShell>
  );
}
