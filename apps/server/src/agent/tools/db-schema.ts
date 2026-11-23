import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { findDatasource } from "../../db/repositories/datasources.js";
import { findUserById } from "../../db/repositories/users.js";
import { listScopePolicies } from "../../db/repositories/data-scope.js";
import { normalizeTableName } from "../sql/scope.js";
import { userDepartmentScope } from "../../services/data-scope.js";
import {
  SCHEMA_CACHE_TTL_MS,
  loadSchemaEntry,
} from "../../db/repositories/schema-cache.js";
import {
  listConversationFiles,
  listConversationFileTables,
  type FileColumnFormatHint,
} from "../../db/repositories/conversation-files.js";
import {
  authorizeDatasourceAccess,
  authorizeFileConversationAccess,
} from "../../services/query-service.js";
import { refreshDatasourceSchema } from "../../services/schema-refresh.js";
import type { SchemaSnapshot, SchemaTable } from "../datasource/introspect.js";
import {
  errorResult,
  isFileToolContext,
  safeJsonStringify,
  textResult,
  type AgentToolContext,
} from "./context.js";

/** Keep the tool result small enough that one schema call cannot flood the context. */
export const MAX_SCHEMA_BYTES = 8 * 1024;

const schemaParameters = Type.Object({
  search: Type.Optional(
    Type.String({ description: "按表名、表注释或列名做不区分大小写的模糊搜索" }),
  ),
  table: Type.Optional(Type.String({ description: "精确表名；可写 table 或 schema.table" })),
});

export type DbSchemaParams = Static<typeof schemaParameters>;

export interface DbSchemaDetails {
  tableCount: number;
  returned: number;
  truncated: boolean;
  /** True when a stale snapshot was served after a failed background refresh. */
  stale?: boolean;
  code?: string;
  message?: string;
}

interface TableOutput {
  name: string;
  comment: string | null;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    pk: boolean;
    comment: string | null;
  }>;
  fks: Array<{
    name: string;
    columns: string[];
    referencedTable: string;
    referencedColumns: string[];
  }>;
  indexes: Array<{ name: string; unique: boolean; columns: string[] }>;
}

function toOutput(table: SchemaTable): TableOutput {
  const primaryKey = new Set(table.primaryKey);
  return {
    name: table.name,
    comment: table.comment,
    columns: table.columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      pk: primaryKey.has(column.name),
      comment: column.comment,
    })),
    fks: table.foreignKeys.map((fk) => ({
      name: fk.name,
      columns: fk.columns,
      referencedTable: fk.referencedTable,
      referencedColumns: fk.referencedColumns,
    })),
    indexes: table.indexes.map((index) => ({
      name: index.name,
      unique: index.unique,
      columns: index.columns,
    })),
  };
}

function matches(table: SchemaTable, search: string): boolean {
  if (
    table.name.toLowerCase().includes(search) ||
    (table.comment ?? "").toLowerCase().includes(search) ||
    (table.schema?.toLowerCase().includes(search) ?? false)
  ) {
    return true;
  }
  return table.columns.some(
    (column) =>
      column.name.toLowerCase().includes(search) || (column.comment ?? "").toLowerCase().includes(search),
  );
}

function matchesTable(table: SchemaTable, wanted: string): boolean {
  const target = wanted.toLowerCase();
  return (
    table.name.toLowerCase() === target ||
    `${table.schema}.${table.name}`.toLowerCase() === target
  );
}

/**
 * Serialize the schema, dropping trailing tables/columns until the JSON fits.
 * The result always stays valid JSON with an explicit `truncated` flag.
 */
function renderTables(tables: TableOutput[]): { text: string; truncated: boolean } {
  let truncated = false;
  let text = safeJsonStringify({ tables, truncated });
  while (Buffer.byteLength(text, "utf8") > MAX_SCHEMA_BYTES) {
    truncated = true;
    const last = tables.at(-1);
    if (tables.length > 1) {
      tables.pop();
    } else if (last && last.columns.length > 0) {
      last.columns.pop();
    } else if (last && last.indexes.length > 0) {
      last.indexes.pop();
    } else if (last && last.fks.length > 0) {
      last.fks.pop();
    } else {
      break;
    }
    text = safeJsonStringify({ tables, truncated });
  }
  return { text, truncated };
}

function selectTables(
  snapshot: SchemaSnapshot,
  params: DbSchemaParams,
): { tables: TableOutput[]; total: number } {
  let selected = snapshot.tables;
  if (params.table) {
    selected = selected.filter((table) => matchesTable(table, params.table!));
  }
  if (params.search) {
    const search = params.search.trim().toLowerCase();
    if (search) selected = selected.filter((table) => matches(table, search));
  }
  return { tables: selected.map(toOutput), total: snapshot.tables.length };
}

const FORMAT_HINT_DESCRIPTIONS: Record<FileColumnFormatHint, string> = {
  percent: "原格式为百分比，已存为小数",
  currency: "已去掉货币符号和千分位并转为数值",
  thousands: "已去掉千分位分隔符并转为数值",
};

function buildFileSnapshot(ctx: AgentToolContext): SchemaSnapshot {
  const files = listConversationFiles(ctx.db, ctx.conversationId);
  const fileNames = new Map(files.map((file) => [file.id, file.fileName]));
  const fileTables = listConversationFileTables(ctx.db, ctx.conversationId);

  const tables: SchemaTable[] = fileTables.map((table) => {
    const fileName = fileNames.get(table.fileId);
    const commentParts = [
      fileName ? `来源文件：${fileName}` : null,
      table.sheetName ? `工作表：${table.sheetName}` : null,
      `共 ${table.rowCount} 行`,
      table.warnings.length > 0 ? `提示：${table.warnings.join("；")}` : null,
    ].filter((part): part is string => Boolean(part));

    return {
      schema: "main",
      name: table.tableName,
      comment: commentParts.join("；"),
      rowEstimate: table.rowCount,
      columns: table.columns.map((column) => {
        const colNotes = [
          column.originalName !== column.name ? `原列名：${column.originalName}` : null,
          column.formatHint ? FORMAT_HINT_DESCRIPTIONS[column.formatHint] : null,
          column.sampleValues.length > 0 ? `示例：${column.sampleValues.join(" / ")}` : null,
        ].filter((part): part is string => Boolean(part));
        return {
          name: column.name,
          type: column.type,
          nullable: column.nullable,
          defaultValue: null,
          comment: colNotes.length > 0 ? colNotes.join("；") : null,
        };
      }),
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    };
  });

  return { tables, refreshedAt: Date.now() };
}

export function createDbSchemaTool(ctx: AgentToolContext): ToolDefinition<typeof schemaParameters, DbSchemaDetails> {
  return {
    name: "db_schema",
    label: "查看表结构",
    description:
      "读取当前数据源的表结构（缓存缺失或过期时自动刷新）。可用 search 搜索表名/列名，或用 table 精确查看一张表；未传参数时返回全部表。写 SQL 前先调用它。",
    parameters: schemaParameters,
    async execute(_toolCallId, params) {
      if (isFileToolContext(ctx)) {
        const denied = authorizeFileConversationAccess(ctx.db, ctx.userId, ctx.conversationId);
        if (denied) {
          return errorResult<DbSchemaDetails>("CONVERSATION_FORBIDDEN", denied, {
            tableCount: 0,
            returned: 0,
            truncated: false,
            code: "CONVERSATION_FORBIDDEN",
            message: denied,
          });
        }
        const snapshot = buildFileSnapshot(ctx);
        if (snapshot.tables.length === 0) {
          return errorResult<DbSchemaDetails>(
            "SCHEMA_UNAVAILABLE",
            "当前会话还没有导入可用的数据表，请先上传 Excel 或 CSV 文件。",
            { tableCount: 0, returned: 0, truncated: false, code: "SCHEMA_UNAVAILABLE" },
          );
        }
        const { tables, total } = selectTables(snapshot, params);
        const { text, truncated } = renderTables(tables);
        return textResult(text, {
          tableCount: total,
          returned: tables.length,
          truncated,
        });
      }

      const datasourceId = ctx.datasourceId!;
      const denied = authorizeDatasourceAccess(ctx.db, ctx.userId, datasourceId);
      if (denied) {
        return errorResult<DbSchemaDetails>("DATASOURCE_FORBIDDEN", denied, {
          tableCount: 0,
          returned: 0,
          truncated: false,
          code: "DATASOURCE_FORBIDDEN",
          message: denied,
        });
      }

      const entry = loadSchemaEntry(ctx.db, datasourceId);
      let snapshot = entry?.snapshot ?? null;
      let stale = false;
      const expired = entry ? Date.now() - entry.refreshedAt > SCHEMA_CACHE_TTL_MS : true;
      if (!snapshot || expired) {
        const datasource = findDatasource(ctx.db, datasourceId);
        if (!datasource) {
          return errorResult<DbSchemaDetails>("SCHEMA_UNAVAILABLE", "数据源不存在", {
            tableCount: 0,
            returned: 0,
            truncated: false,
            code: "SCHEMA_UNAVAILABLE",
          });
        }
        try {
          snapshot = await refreshDatasourceSchema(ctx, datasource);
        } catch (error) {
          if (!snapshot) {
            const message =
              error instanceof Error ? error.message : "读取表结构失败，请检查数据源连接";
            return errorResult<DbSchemaDetails>(
              "SCHEMA_UNAVAILABLE",
              `读取表结构失败：${message}。请检查数据源连接或联系管理员。`,
              {
                tableCount: 0,
                returned: 0,
                truncated: false,
                code: "SCHEMA_UNAVAILABLE",
                message,
              },
            );
          }
          stale = true;
        }
      }

      if (!snapshot) {
        return errorResult<DbSchemaDetails>(
          "SCHEMA_UNAVAILABLE",
          "当前数据源没有可用的表结构，请检查数据源连接或联系管理员。",
          { tableCount: 0, returned: 0, truncated: false, code: "SCHEMA_UNAVAILABLE" },
        );
      }

      // Scope hides the existence of tables this viewer could never query.
      let visibleSnapshot = snapshot;
      const datasource = findDatasource(ctx.db, datasourceId);
      const enforceScope =
        datasource?.dataScopeMode === "enabled" &&
        (Boolean(ctx.scopeDepartmentOverride) || findUserById(ctx.db, ctx.userId)?.role !== "admin");
      if (enforceScope) {
        const effectiveSize = ctx.scopeDepartmentOverride
          ? ctx.scopeDepartmentOverride.effectiveIds.length
          : userDepartmentScope(ctx.db, ctx.userId).size;
        if (effectiveSize === 0) {
          const message = "当前数据源已启用部门数据权限，但你还没有加入任何部门";
          return errorResult<DbSchemaDetails>("DATA_SCOPE_NO_DEPARTMENT", message, {
            tableCount: 0,
            returned: 0,
            truncated: false,
            code: "DATA_SCOPE_NO_DEPARTMENT",
            message,
          });
        }
        const allowed = new Set(
          listScopePolicies(ctx.db, datasourceId)
            .filter((policy) => policy.enabled && policy.mode !== "denied")
            .map((policy) => normalizeTableName(policy.tableName)),
        );
        visibleSnapshot = {
          ...snapshot,
          tables: snapshot.tables.filter((table) => allowed.has(normalizeTableName(table.name))),
        };
      }

      const { tables, total } = selectTables(visibleSnapshot, params);
      const { text, truncated } = renderTables(tables);
      return textResult(text, {
        tableCount: total,
        returned: tables.length,
        truncated,
        ...(stale ? { stale: true } : {}),
      });
    },
  };
}
