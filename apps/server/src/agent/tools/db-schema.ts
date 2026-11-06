import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadSchema } from "../../db/repositories/schema-cache.js";
import { authorizeDatasourceAccess } from "../../services/query-service.js";
import type { SchemaSnapshot, SchemaTable } from "../datasource/introspect.js";
import { errorResult, safeJsonStringify, textResult, type AgentToolContext } from "./context.js";

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

export function createDbSchemaTool(ctx: AgentToolContext): ToolDefinition<typeof schemaParameters, DbSchemaDetails> {
  return {
    name: "db_schema",
    label: "查看表结构",
    description:
      "读取当前数据源的已缓存表结构。可用 search 搜索表名/列名，或用 table 精确查看一张表；未传参数时返回全部表。写 SQL 前先调用它。",
    parameters: schemaParameters,
    async execute(_toolCallId, params) {
      const denied = authorizeDatasourceAccess(ctx.db, ctx.userId, ctx.datasourceId);
      if (denied) {
        return errorResult<DbSchemaDetails>("DATASOURCE_FORBIDDEN", denied, {
          tableCount: 0,
          returned: 0,
          truncated: false,
          code: "DATASOURCE_FORBIDDEN",
          message: denied,
        });
      }
      const snapshot = loadSchema(ctx.db, ctx.datasourceId);
      if (!snapshot) {
        return errorResult(
          "SCHEMA_NOT_CACHED",
          "当前数据源还没有表结构缓存，请先在数据源页面刷新表结构",
          { tableCount: 0, returned: 0, truncated: false },
        );
      }
      const { tables, total } = selectTables(snapshot, params);
      const { text, truncated } = renderTables(tables);
      return textResult(text, {
        tableCount: total,
        returned: tables.length,
        truncated,
      });
    },
  };
}
