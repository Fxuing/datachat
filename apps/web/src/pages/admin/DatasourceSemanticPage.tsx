import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  BookOpen,
  Code2,
  GitFork,
  MessageSquareWarning,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { AdminShell } from "../../components/admin/AdminShell";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { SemanticFeedbackPanel } from "../../components/admin/SemanticFeedbackPanel";
import {
  SqlExampleDialog,
  type SqlExamplePrefill,
} from "../../components/admin/SqlExampleDialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { PageSpinner } from "../../components/ui/spinner";
import { Textarea } from "../../components/ui/textarea";
import {
  createSemanticMetric,
  createSemanticRelation,
  createSqlExample,
  deleteSemanticMetric,
  deleteSemanticRelation,
  deleteSqlExample,
  fetchMe,
  getSemanticLayer,
  previewSemanticRecall,
  updateSemanticMetric,
  updateSemanticRelation,
  updateSqlExample,
  type DatasourceFeedbackItem,
  type SemanticJoinType,
  type SemanticMetric,
  type SemanticMetricInput,
  type SemanticRelation,
  type SemanticRelationInput,
  type SemanticSchemaTableOption,
  type SqlExample,
  type SqlExampleInput,
} from "../../lib/api";
import { describeApiError } from "../../lib/errors";
import { queryKeys } from "../../lib/query";
import {
  extractMetricDraftFromSql,
  type ExtractedMetricDraft,
} from "../../lib/sql-metric-extract";
import { cn } from "../../lib/utils";

type Tab = "metrics" | "relations" | "examples" | "feedback";

function exampleSourceLabel(source: SqlExample["source"]): { label: string; className: string } {
  if (source === "feedback_fix") {
    return { label: "纠错沉淀", className: "bg-warningsoft text-warning" };
  }
  if (source === "feedback_up") {
    return { label: "点赞沉淀", className: "bg-successsoft text-success" };
  }
  return { label: "人工录入", className: "bg-subtle text-inksoft" };
}

function splitCommaOrLine(raw: string): string[] {
  return raw
    .split(/[\n,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function MetricEditorDialog({
  metric,
  prefill,
  tables,
  saving,
  error,
  onSave,
  onClose,
}: {
  metric: SemanticMetric | null;
  prefill?: ExtractedMetricDraft | null;
  tables: SemanticSchemaTableOption[];
  saving: boolean;
  error: string | null;
  onSave: (input: SemanticMetricInput) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(metric?.name ?? prefill?.name ?? "");
  const [synonymsText, setSynonymsText] = useState((metric?.synonyms ?? []).join("、"));
  const [sqlExpression, setSqlExpression] = useState(
    metric?.sqlExpression ?? prefill?.sqlExpression ?? "",
  );
  const [tableName, setTableName] = useState(metric?.tableName ?? prefill?.tableName ?? "");
  const [filtersText, setFiltersText] = useState(
    (metric?.defaultFilters ?? prefill?.defaultFilters ?? []).join("\n"),
  );
  const [timeColumn, setTimeColumn] = useState(metric?.timeColumn ?? prefill?.timeColumn ?? "");
  const [unit, setUnit] = useState(metric?.unit ?? "");
  const [description, setDescription] = useState(metric?.description ?? prefill?.description ?? "");
  const [activeCandidateIdx, setActiveCandidateIdx] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  const candidates = !metric ? (prefill?.candidates ?? []) : [];

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setLocalError("请输入指标名称");
      return;
    }
    if (!sqlExpression.trim()) {
      setLocalError("请输入 SQL 计算公式");
      return;
    }
    setLocalError(null);
    onSave({
      name: name.trim(),
      synonyms: splitCommaOrLine(synonymsText),
      sqlExpression: sqlExpression.trim(),
      tableName: tableName.trim() || null,
      defaultFilters: splitLines(filtersText),
      timeColumn: timeColumn.trim() || null,
      unit: unit.trim() || null,
      description: description.trim() || null,
      ...(!metric && prefill?.sourceRunId ? { sourceRunId: prefill.sourceRunId } : {}),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader className="px-5 py-3.5">
          <DialogTitle>
            {metric ? "编辑指标口径" : prefill?.sourceRunId ? "从问答沉淀指标口径" : "新建指标口径"}
          </DialogTitle>
          <DialogDescription>
            {prefill?.sourceRunId
              ? "已自动从该轮 SQL 解析出公式、主表、过滤条件与时间字段，核对微调后即可保存。"
              : "定义标准指标公式与默认过滤条件，模型在分析该数据源时会自动按口径生成 SQL。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          <div className="max-h-[70vh] space-y-3 overflow-y-auto px-5 py-4">
            {localError || error ? (
              <p role="alert" className="rounded-md border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger">
                {localError ?? error}
              </p>
            ) : null}

            {candidates.length > 1 ? (
              <div className="space-y-1.5 rounded-lg border border-brand/20 bg-brandsoft/40 p-2.5">
                <p className="text-[11px] font-medium text-brandtext">
                  检测到该 SQL 包含 {candidates.length} 个聚合指标，点击可快速切换预填：
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {candidates.map((cand, idx) => (
                    <button
                      key={`${cand.name}-${idx}`}
                      type="button"
                      onClick={() => {
                        setActiveCandidateIdx(idx);
                        setName(cand.name);
                        setSqlExpression(cand.sqlExpression);
                      }}
                      className={cn(
                        "rounded-md border px-2 py-1 text-xs transition-colors",
                        activeCandidateIdx === idx
                          ? "border-brand bg-brand text-white"
                          : "border-line bg-surface text-inksoft hover:bg-subtle",
                      )}
                    >
                      {cand.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {!metric && prefill?.sourceSql ? (
              <details className="rounded-lg border border-line bg-subtle/50 px-3 py-2">
                <summary className="cursor-pointer text-[11px] font-medium text-muted">
                  查看来源 SQL（参考）
                </summary>
                <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-relaxed text-inksoft whitespace-pre-wrap">
                  {prefill.sourceSql}
                </pre>
              </details>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="metric-name" className="text-xs font-medium text-inksoft">
                  指标名称 *
                </label>
                <Input
                  id="metric-name"
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：GMV"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="metric-unit" className="text-xs font-medium text-inksoft">
                  单位（可选）
                </label>
                <Input
                  id="metric-unit"
                  value={unit}
                  maxLength={50}
                  onChange={(e) => setUnit(e.target.value)}
                  placeholder="例如：元 / % / 单"
                />
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor="metric-synonyms" className="text-xs font-medium text-inksoft">
                同义词 / 业务别名（逗号或顿号分隔）
              </label>
              <Input
                id="metric-synonyms"
                value={synonymsText}
                onChange={(e) => setSynonymsText(e.target.value)}
                placeholder="例如：成交总额、交易额、总营收"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="metric-sql" className="text-xs font-medium text-inksoft">
                SQL 计算表达式 *
              </label>
              <Textarea
                id="metric-sql"
                rows={2}
                value={sqlExpression}
                onChange={(e) => setSqlExpression(e.target.value)}
                placeholder="例如：SUM(orders.pay_amount)"
                className="font-mono text-xs"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="metric-table" className="text-xs font-medium text-inksoft">
                  主表名（可选）
                </label>
                <Input
                  id="metric-table"
                  list="semantic-table-options"
                  value={tableName}
                  maxLength={200}
                  onChange={(e) => setTableName(e.target.value)}
                  placeholder="例如：orders"
                />
                <datalist id="semantic-table-options">
                  {tables.map((t) => (
                    <option key={t.name} value={t.name} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1">
                <label htmlFor="metric-time" className="text-xs font-medium text-inksoft">
                  默认时间字段（可选）
                </label>
                <Input
                  id="metric-time"
                  value={timeColumn}
                  maxLength={200}
                  onChange={(e) => setTimeColumn(e.target.value)}
                  placeholder="例如：orders.paid_at"
                />
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor="metric-filters" className="text-xs font-medium text-inksoft">
                默认过滤条件（每行一条 WHERE 表达式）
              </label>
              <Textarea
                id="metric-filters"
                rows={2}
                value={filtersText}
                onChange={(e) => setFiltersText(e.target.value)}
                placeholder={"orders.status IN ('paid', 'completed')\norders.is_test = 0"}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="metric-desc" className="text-xs font-medium text-inksoft">
                口径说明（可选）
              </label>
              <Textarea
                id="metric-desc"
                rows={2}
                value={description}
                maxLength={500}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="补充业务口径注意事项、排除场景或去重规则"
              />
            </div>
          </div>
          <DialogFooter className="px-5 py-3">
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RelationEditorDialog({
  relation,
  tables,
  saving,
  error,
  onSave,
  onClose,
}: {
  relation: SemanticRelation | null;
  tables: SemanticSchemaTableOption[];
  saving: boolean;
  error: string | null;
  onSave: (input: SemanticRelationInput) => void;
  onClose: () => void;
}) {
  const [leftTable, setLeftTable] = useState(relation?.leftTable ?? "");
  const [leftColumn, setLeftColumn] = useState(relation?.leftColumn ?? "");
  const [rightTable, setRightTable] = useState(relation?.rightTable ?? "");
  const [rightColumn, setRightColumn] = useState(relation?.rightColumn ?? "");
  const [joinType, setJoinType] = useState<SemanticJoinType>(relation?.joinType ?? "left");
  const [description, setDescription] = useState(relation?.description ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const leftCols = useMemo(
    () => tables.find((t) => t.name === leftTable)?.columns ?? [],
    [tables, leftTable],
  );
  const rightCols = useMemo(
    () => tables.find((t) => t.name === rightTable)?.columns ?? [],
    [tables, rightTable],
  );

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!leftTable.trim() || !leftColumn.trim() || !rightTable.trim() || !rightColumn.trim()) {
      setLocalError("请完整填写左右表名和关联列名");
      return;
    }
    setLocalError(null);
    onSave({
      leftTable: leftTable.trim(),
      leftColumn: leftColumn.trim(),
      rightTable: rightTable.trim(),
      rightColumn: rightColumn.trim(),
      joinType,
      description: description.trim() || null,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{relation ? "编辑标准表关联" : "新建标准表关联"}</DialogTitle>
          <DialogDescription>
            声明推荐的多表 JOIN 路径，避免模型在无外键库上猜错关联字段。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 px-4 py-3">
          {localError || error ? (
            <p role="alert" className="rounded-md border border-danger/25 bg-dangersoft px-3 py-2 text-xs text-danger">
              {localError ?? error}
            </p>
          ) : null}
          <datalist id="rel-tables">
            {tables.map((t) => (
              <option key={t.name} value={t.name} />
            ))}
          </datalist>
          <datalist id="rel-left-cols">
            {leftCols.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <datalist id="rel-right-cols">
            {rightCols.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="rel-left-table" className="text-xs font-medium text-inksoft">
                左表 *
              </label>
              <Input
                id="rel-left-table"
                list="rel-tables"
                value={leftTable}
                onChange={(e) => setLeftTable(e.target.value)}
                placeholder="例如：orders"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="rel-left-col" className="text-xs font-medium text-inksoft">
                左表字段 *
              </label>
              <Input
                id="rel-left-col"
                list="rel-left-cols"
                value={leftColumn}
                onChange={(e) => setLeftColumn(e.target.value)}
                placeholder="例如：customer_id"
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="rel-right-table" className="text-xs font-medium text-inksoft">
                右表 *
              </label>
              <Input
                id="rel-right-table"
                list="rel-tables"
                value={rightTable}
                onChange={(e) => setRightTable(e.target.value)}
                placeholder="例如：customers"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="rel-right-col" className="text-xs font-medium text-inksoft">
                右表字段 *
              </label>
              <Input
                id="rel-right-col"
                list="rel-right-cols"
                value={rightColumn}
                onChange={(e) => setRightColumn(e.target.value)}
                placeholder="例如：id"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="rel-join-type" className="text-xs font-medium text-inksoft">
              默认 JOIN 类型
            </label>
            <Select value={joinType} onValueChange={(v) => setJoinType(v as SemanticJoinType)}>
              <SelectTrigger id="rel-join-type" className="h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="left">LEFT JOIN</SelectItem>
                <SelectItem value="inner">INNER JOIN</SelectItem>
                <SelectItem value="right">RIGHT JOIN</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label htmlFor="rel-desc" className="text-xs font-medium text-inksoft">
              关联说明（可选）
            </label>
            <Input
              id="rel-desc"
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例如：订单关联下单客户，多对一"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function DatasourceSemanticPage() {
  const { datasourceId } = useParams<{ datasourceId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<Tab>("metrics");
  const [metricModal, setMetricModal] = useState<{
    mode: "new" | "edit";
    item: SemanticMetric | null;
    prefill?: ExtractedMetricDraft;
  } | null>(null);
  const [relationModal, setRelationModal] = useState<{
    mode: "new" | "edit";
    item: SemanticRelation | null;
  } | null>(null);
  const [exampleModal, setExampleModal] = useState<{
    mode: "new" | "edit";
    item: SqlExample | null;
    prefill?: SqlExamplePrefill;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: "metric"; item: SemanticMetric }
    | { kind: "relation"; item: SemanticRelation }
    | { kind: "example"; item: SqlExample }
    | null
  >(null);
  const [previewQuery, setPreviewQuery] = useState("");
  const [previewResult, setPreviewResult] = useState<string | null>(null);

  const meQuery = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const semanticQuery = useQuery({
    queryKey: queryKeys.semanticLayer(datasourceId ?? ""),
    queryFn: () => getSemanticLayer(datasourceId as string),
    enabled: Boolean(datasourceId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.semanticLayer(datasourceId ?? "") });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.semanticFeedbackAll(datasourceId ?? ""),
    });
  };

  const saveMetricMutation = useMutation({
    mutationFn: (vars: { id: string | null; input: SemanticMetricInput }) =>
      vars.id
        ? updateSemanticMetric(datasourceId as string, vars.id, vars.input)
        : createSemanticMetric(datasourceId as string, vars.input),
    onSuccess: () => {
      setMetricModal(null);
      invalidate();
    },
  });

  const toggleMetricMutation = useMutation({
    mutationFn: (metric: SemanticMetric) =>
      updateSemanticMetric(datasourceId as string, metric.id, { enabled: !metric.enabled }),
    onSuccess: invalidate,
  });

  const saveRelationMutation = useMutation({
    mutationFn: (vars: { id: string | null; input: SemanticRelationInput }) =>
      vars.id
        ? updateSemanticRelation(datasourceId as string, vars.id, vars.input)
        : createSemanticRelation(datasourceId as string, vars.input),
    onSuccess: () => {
      setRelationModal(null);
      invalidate();
    },
  });

  const toggleRelationMutation = useMutation({
    mutationFn: (relation: SemanticRelation) =>
      updateSemanticRelation(datasourceId as string, relation.id, { enabled: !relation.enabled }),
    onSuccess: invalidate,
  });

  const saveExampleMutation = useMutation({
    mutationFn: (vars: { id: string | null; input: SqlExampleInput }) =>
      vars.id
        ? updateSqlExample(datasourceId as string, vars.id, vars.input)
        : createSqlExample(datasourceId as string, vars.input),
    onSuccess: () => {
      setExampleModal(null);
      invalidate();
    },
  });

  const toggleExampleMutation = useMutation({
    mutationFn: (example: SqlExample) =>
      updateSqlExample(datasourceId as string, example.id, { enabled: !example.enabled }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (target: NonNullable<typeof deleteTarget>) =>
      target.kind === "metric"
        ? deleteSemanticMetric(datasourceId as string, target.item.id)
        : target.kind === "relation"
          ? deleteSemanticRelation(datasourceId as string, target.item.id)
          : deleteSqlExample(datasourceId as string, target.item.id),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
    },
  });

  const previewMutation = useMutation({
    mutationFn: (q: string) => previewSemanticRecall(datasourceId as string, q),
    onSuccess: (data) => {
      setPreviewResult(data.text || "（当前问题未命中任何已启用的指标、表关联或 SQL 示例）");
    },
  });

  const user = meQuery.data?.user;
  if (!user) return <PageSpinner />;

  const data = semanticQuery.data;
  const metrics = data?.metrics ?? [];
  const relations = data?.relations ?? [];
  const examples = data?.examples ?? [];
  const feedbackSummary = data?.feedbackSummary;
  const tables = data?.tables ?? [];

  const promoteFeedbackToExample = (item: DatasourceFeedbackItem) => {
    const latestSql =
      [...item.sqlQueries].reverse().find((q) => q.status === "ok")?.sql ??
      item.sqlQueries[item.sqlQueries.length - 1]?.sql ??
      "";
    saveExampleMutation.reset();
    setExampleModal({
      mode: "new",
      item: null,
      prefill: {
        question: item.prompt,
        sqlText: latestSql,
        notes: item.comment ?? undefined,
        source: item.rating === -1 ? "feedback_fix" : "feedback_up",
        sourceRunId: item.runId,
      },
    });
  };

  const promoteFeedbackToMetric = (item: DatasourceFeedbackItem) => {
    const latestSql =
      [...item.sqlQueries].reverse().find((q) => q.status === "ok")?.sql ??
      item.sqlQueries[item.sqlQueries.length - 1]?.sql ??
      "";
    const draft = extractMetricDraftFromSql({
      sql: latestSql,
      prompt: item.prompt,
      comment: item.comment,
      sourceRunId: item.runId,
    });
    saveMetricMutation.reset();
    setMetricModal({
      mode: "new",
      item: null,
      prefill: draft,
    });
  };

  return (
    <AdminShell user={user}>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-5xl space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="sm" onClick={() => navigate("/admin/datasources")}>
                <ArrowLeft className="h-3.5 w-3.5" />
                返回数据源
              </Button>
              <div>
                <h1 className="text-lg font-semibold text-ink">
                  指标与语义层{data ? ` · ${data.datasource.name}` : ""}
                </h1>
                <p className="text-xs text-muted">
                  配置业务指标口径、标准表关联与 Few-Shot SQL 示例，并将用户点赞/点踩反馈沉淀为可持续演进的查询知识库。
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {tab === "metrics" ? (
                <Button
                  size="sm"
                  onClick={() => {
                    saveMetricMutation.reset();
                    setMetricModal({ mode: "new", item: null });
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  新建指标
                </Button>
              ) : tab === "relations" ? (
                <Button
                  size="sm"
                  onClick={() => {
                    saveRelationMutation.reset();
                    setRelationModal({ mode: "new", item: null });
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  新建表关联
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    saveExampleMutation.reset();
                    setExampleModal({ mode: "new", item: null });
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  新建 SQL 示例
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1 border-b border-line">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "metrics"}
              onClick={() => setTab("metrics")}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === "metrics"
                  ? "border-brand text-brandtext"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              <BookOpen className="h-3.5 w-3.5" />
              业务指标口径 ({metrics.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "relations"}
              onClick={() => setTab("relations")}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === "relations"
                  ? "border-brand text-brandtext"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              <GitFork className="h-3.5 w-3.5" />
              标准表关联 ({relations.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "examples"}
              onClick={() => setTab("examples")}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === "examples"
                  ? "border-brand text-brandtext"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              <Code2 className="h-3.5 w-3.5" />
              SQL 示例库 ({examples.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "feedback"}
              onClick={() => setTab("feedback")}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === "feedback"
                  ? "border-brand text-brandtext"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              <MessageSquareWarning className="h-3.5 w-3.5" />
              问答反馈沉淀
              {(feedbackSummary?.pendingNegative ?? 0) > 0 ? (
                <span className="rounded-full bg-danger px-1.5 py-0.2 text-[10px] font-semibold text-white">
                  {feedbackSummary!.pendingNegative}
                </span>
              ) : null}
            </button>
          </div>

          {semanticQuery.isPending ? (
            <PageSpinner label="加载语义层配置…" />
          ) : semanticQuery.isError ? (
            <div role="alert" className="rounded-lg border border-danger/25 bg-dangersoft p-4 text-xs text-danger">
              {describeApiError(semanticQuery.error, "加载语义层失败，请稍后重试。")}
            </div>
          ) : tab === "metrics" ? (
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              {metrics.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                  <BookOpen className="h-8 w-8 text-muted/60" />
                  <p className="text-sm font-medium text-ink">还没有配置业务指标口径</p>
                  <p className="max-w-md text-xs text-muted">
                    把容易算错口径的核心指标（如 GMV、净收入、复购率、有效客户数）录入这里，模型会优先遵循这里的公式和过滤条件。
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-line">
                  {metrics.map((metric) => (
                    <div
                      key={metric.id}
                      className={cn(
                        "flex flex-wrap items-start justify-between gap-3 px-4 py-3.5",
                        !metric.enabled && "opacity-60",
                      )}
                    >
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-ink">{metric.name}</span>
                          {metric.unit ? (
                            <span className="rounded bg-subtle px-1.5 py-0.5 text-[10px] text-muted">
                              单位：{metric.unit}
                            </span>
                          ) : null}
                          {!metric.enabled ? (
                            <span className="rounded bg-line px-1.5 py-0.5 text-[10px] text-muted">
                              已停用
                            </span>
                          ) : null}
                          {metric.synonyms.map((syn) => (
                            <span
                              key={syn}
                              className="rounded-full bg-brandsoft px-2 py-0.5 text-[10px] text-brandtext"
                            >
                              {syn}
                            </span>
                          ))}
                        </div>
                        <p className="font-mono text-xs text-inksoft">
                          公式：{metric.sqlExpression}
                        </p>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                          {metric.tableName ? <span>主表：{metric.tableName}</span> : null}
                          {metric.timeColumn ? <span>时间字段：{metric.timeColumn}</span> : null}
                          {metric.defaultFilters.length > 0 ? (
                            <span className="font-mono">
                              默认过滤：{metric.defaultFilters.join(" AND ")}
                            </span>
                          ) : null}
                        </div>
                        {metric.description ? (
                          <p className="text-xs text-muted">{metric.description}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toggleMetricMutation.mutate(metric)}
                        >
                          {metric.enabled ? "停用" : "启用"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            saveMetricMutation.reset();
                            setMetricModal({ mode: "edit", item: metric });
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger hover:bg-dangersoft hover:text-danger"
                          onClick={() => setDeleteTarget({ kind: "metric", item: metric })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : tab === "relations" ? (
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              {relations.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                  <GitFork className="h-8 w-8 text-muted/60" />
                  <p className="text-sm font-medium text-ink">还没有配置标准表关联</p>
                  <p className="max-w-md text-xs text-muted">
                    对于没有物理外键的业务表，在这里声明标准 JOIN 路径，避免多表查询时猜错关联键。
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-line">
                  {relations.map((rel) => (
                    <div
                      key={rel.id}
                      className={cn(
                        "flex flex-wrap items-center justify-between gap-3 px-4 py-3",
                        !rel.enabled && "opacity-60",
                      )}
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-ink">
                          <span>
                            {rel.leftTable}.{rel.leftColumn}
                          </span>
                          <span className="rounded bg-brandsoft px-1.5 py-0.5 text-[10px] font-semibold text-brandtext">
                            {rel.joinType.toUpperCase()} JOIN
                          </span>
                          <span>
                            {rel.rightTable}.{rel.rightColumn}
                          </span>
                          {!rel.enabled ? (
                            <span className="rounded bg-line px-1.5 py-0.5 font-sans text-[10px] text-muted">
                              已停用
                            </span>
                          ) : null}
                        </div>
                        {rel.description ? (
                          <p className="text-xs text-muted">{rel.description}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => toggleRelationMutation.mutate(rel)}
                        >
                          {rel.enabled ? "停用" : "启用"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            saveRelationMutation.reset();
                            setRelationModal({ mode: "edit", item: rel });
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger hover:bg-dangersoft hover:text-danger"
                          onClick={() => setDeleteTarget({ kind: "relation", item: rel })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : tab === "examples" ? (
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              {examples.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
                  <Code2 className="h-8 w-8 text-muted/60" />
                  <p className="text-sm font-medium text-ink">还没有沉淀 Few-Shot SQL 示例</p>
                  <p className="max-w-md text-xs text-muted">
                    录入高频复杂查询的标准 SQL，或从「问答反馈沉淀」一键将点赞/纠错结果沉淀到这里，模型遇到相似问题时会自动参考。
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-line">
                  {examples.map((ex) => {
                    const badge = exampleSourceLabel(ex.source);
                    return (
                      <div
                        key={ex.id}
                        className={cn(
                          "flex flex-wrap items-start justify-between gap-3 px-4 py-3.5",
                          !ex.enabled && "opacity-60",
                        )}
                      >
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-ink">{ex.question}</span>
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                                badge.className,
                              )}
                            >
                              {badge.label}
                            </span>
                            {!ex.enabled ? (
                              <span className="rounded bg-line px-1.5 py-0.5 text-[10px] text-muted">
                                已停用
                              </span>
                            ) : null}
                            <span className="text-[11px] text-muted">已命中 {ex.useCount} 次</span>
                          </div>
                          <pre className="overflow-x-auto rounded-lg border border-line bg-subtle/50 p-2.5 font-mono text-[11px] leading-relaxed text-inksoft whitespace-pre-wrap">
                            {ex.sqlText}
                          </pre>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                            {ex.tables.map((t) => (
                              <span
                                key={t}
                                className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-inksoft"
                              >
                                {t}
                              </span>
                            ))}
                            {ex.notes ? <span className="text-xs text-muted">· {ex.notes}</span> : null}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => toggleExampleMutation.mutate(ex)}
                          >
                            {ex.enabled ? "停用" : "启用"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              saveExampleMutation.reset();
                              setExampleModal({ mode: "edit", item: ex });
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            编辑
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-danger hover:bg-dangersoft hover:text-danger"
                            onClick={() => setDeleteTarget({ kind: "example", item: ex })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            删除
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <SemanticFeedbackPanel
              datasourceId={datasourceId as string}
              onPromoteToExample={promoteFeedbackToExample}
              onPromoteToMetric={promoteFeedbackToMetric}
            />
          )}

          {/* Recall test preview */}
          <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand" />
              <h2 className="text-sm font-medium text-ink">召回效果测试</h2>
            </div>
            <p className="text-xs text-muted">
              输入一条真实用户提问，预览模型在生成 SQL 前实际会收到的语义层上下文块。
            </p>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (previewQuery.trim()) previewMutation.mutate(previewQuery.trim());
              }}
            >
              <Input
                aria-label="测试提问"
                value={previewQuery}
                onChange={(e) => setPreviewQuery(e.target.value)}
                placeholder="例如：统计上月华东各渠道成交总额"
                className="min-w-0 flex-1"
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!previewQuery.trim() || previewMutation.isPending}
              >
                {previewMutation.isPending ? "测试中…" : "测试召回"}
              </Button>
            </form>
            {previewResult !== null ? (
              <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-subtle/60 p-3 font-mono text-[11px] leading-relaxed text-inksoft whitespace-pre-wrap">
                {previewResult}
              </pre>
            ) : null}
          </div>
        </div>
      </div>

      {metricModal ? (
        <MetricEditorDialog
          metric={metricModal.item}
          prefill={metricModal.prefill}
          tables={tables}
          saving={saveMetricMutation.isPending}
          error={
            saveMetricMutation.error
              ? describeApiError(saveMetricMutation.error, "保存指标失败")
              : null
          }
          onSave={(input) =>
            saveMetricMutation.mutate({ id: metricModal.item?.id ?? null, input })
          }
          onClose={() => setMetricModal(null)}
        />
      ) : null}

      {relationModal ? (
        <RelationEditorDialog
          relation={relationModal.item}
          tables={tables}
          saving={saveRelationMutation.isPending}
          error={
            saveRelationMutation.error
              ? describeApiError(saveRelationMutation.error, "保存表关联失败")
              : null
          }
          onSave={(input) =>
            saveRelationMutation.mutate({ id: relationModal.item?.id ?? null, input })
          }
          onClose={() => setRelationModal(null)}
        />
      ) : null}

      {exampleModal ? (
        <SqlExampleDialog
          example={exampleModal.item}
          prefill={exampleModal.prefill}
          saving={saveExampleMutation.isPending}
          error={
            saveExampleMutation.error
              ? describeApiError(saveExampleMutation.error, "保存 SQL 示例失败")
              : null
          }
          onSave={(input) =>
            saveExampleMutation.mutate({ id: exampleModal.item?.id ?? null, input })
          }
          onClose={() => setExampleModal(null)}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={
            deleteTarget.kind === "metric"
              ? "删除指标口径"
              : deleteTarget.kind === "relation"
                ? "删除表关联"
                : "删除 SQL 示例"
          }
          description={
            deleteTarget.kind === "metric"
              ? `确定删除指标「${deleteTarget.item.name}」吗？`
              : deleteTarget.kind === "relation"
                ? `确定删除表关联「${deleteTarget.item.leftTable}.${deleteTarget.item.leftColumn} → ${deleteTarget.item.rightTable}.${deleteTarget.item.rightColumn}」吗？`
                : `确定删除 SQL 示例「${deleteTarget.item.question}」吗？`
          }
          confirmLabel="删除"
          variant="danger"
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      ) : null}
    </AdminShell>
  );
}
