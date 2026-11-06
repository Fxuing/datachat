import type { Pool as MysqlPool } from "mysql2/promise";
import type { Pool as PgPool } from "pg";

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string | null;
}

export interface SchemaIndex {
  name: string;
  unique: boolean;
  columns: string[];
}

export interface SchemaForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

export interface SchemaTable {
  schema: string;
  name: string;
  comment: string | null;
  /** Approximate row count from table statistics; null when the engine has no estimate. */
  rowEstimate: number | null;
  columns: SchemaColumn[];
  primaryKey: string[];
  indexes: SchemaIndex[];
  foreignKeys: SchemaForeignKey[];
}

export interface SchemaSnapshot {
  tables: SchemaTable[];
  refreshedAt: number;
}

export interface MysqlTableRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_COMMENT: string | null;
  TABLE_ROWS: number | string | null;
}

export interface MysqlColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  COLUMN_COMMENT: string | null;
}

export interface MysqlIndexRow {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: number | string;
  COLUMN_NAME: string;
}

export interface MysqlForeignKeyRow {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
}

export interface MysqlIntrospectionRows {
  tableRows: MysqlTableRow[];
  columnRows: MysqlColumnRow[];
  indexRows: MysqlIndexRow[];
  fkRows: MysqlForeignKeyRow[];
}

export interface PostgresTableRow {
  schema: string;
  name: string;
  comment: string | null;
  row_estimate: number | string | null;
}

export interface PostgresColumnRow {
  schema: string;
  name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  comment: string | null;
}

export interface PostgresPrimaryKeyRow {
  schema: string;
  name: string;
  column_name: string;
}

export interface PostgresForeignKeyRow {
  schema: string;
  name: string;
  constraint_name: string;
  column_name: string;
  referenced_table: string;
  referenced_column: string;
}

export interface PostgresIndexRow {
  schema: string;
  name: string;
  index_name: string;
  is_unique: boolean;
  column_name: string;
}

export interface PostgresIntrospectionRows {
  tableRows: PostgresTableRow[];
  columnRows: PostgresColumnRow[];
  primaryKeyRows: PostgresPrimaryKeyRow[];
  foreignKeyRows: PostgresForeignKeyRow[];
  indexRows: PostgresIndexRow[];
}

function toEstimate(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

export function buildMysqlSnapshot(
  rows: MysqlIntrospectionRows,
  refreshedAt: number = Date.now(),
): SchemaSnapshot {
  const tables = new Map<string, SchemaTable>();
  for (const row of rows.tableRows) {
    tables.set(row.TABLE_NAME, {
      schema: row.TABLE_SCHEMA,
      name: row.TABLE_NAME,
      comment: row.TABLE_COMMENT || null,
      rowEstimate: toEstimate(row.TABLE_ROWS),
      columns: [],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    });
  }
  for (const row of rows.columnRows) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    table.columns.push({
      name: row.COLUMN_NAME,
      type: row.COLUMN_TYPE,
      nullable: row.IS_NULLABLE === "YES",
      defaultValue: row.COLUMN_DEFAULT ?? null,
      comment: row.COLUMN_COMMENT || null,
    });
  }
  for (const row of rows.indexRows) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    let index = table.indexes.find((item) => item.name === row.INDEX_NAME);
    if (!index) {
      index = { name: row.INDEX_NAME, unique: Number(row.NON_UNIQUE) === 0, columns: [] };
      table.indexes.push(index);
    }
    index.columns.push(row.COLUMN_NAME);
    if (row.INDEX_NAME === "PRIMARY") table.primaryKey.push(row.COLUMN_NAME);
  }
  for (const row of rows.fkRows) {
    const table = tables.get(row.TABLE_NAME);
    if (!table) continue;
    let fk = table.foreignKeys.find((item) => item.name === row.CONSTRAINT_NAME);
    if (!fk) {
      fk = {
        name: row.CONSTRAINT_NAME,
        columns: [],
        referencedTable: row.REFERENCED_TABLE_NAME,
        referencedColumns: [],
      };
      table.foreignKeys.push(fk);
    }
    fk.columns.push(row.COLUMN_NAME);
    fk.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
  }
  return { tables: [...tables.values()], refreshedAt };
}

export function buildPostgresSnapshot(
  rows: PostgresIntrospectionRows,
  refreshedAt: number = Date.now(),
): SchemaSnapshot {
  const tables = new Map<string, SchemaTable>();
  for (const row of rows.tableRows) {
    tables.set(`${row.schema}.${row.name}`, {
      schema: row.schema,
      name: row.name,
      comment: row.comment ?? null,
      rowEstimate: toEstimate(row.row_estimate),
      columns: [],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
    });
  }
  for (const row of rows.columnRows) {
    const table = tables.get(`${row.schema}.${row.name}`);
    if (!table) continue;
    table.columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
      defaultValue: row.column_default,
      comment: row.comment ?? null,
    });
  }
  for (const row of rows.primaryKeyRows) {
    tables.get(`${row.schema}.${row.name}`)?.primaryKey.push(row.column_name);
  }
  for (const row of rows.foreignKeyRows) {
    const table = tables.get(`${row.schema}.${row.name}`);
    if (!table) continue;
    let fk = table.foreignKeys.find((item) => item.name === row.constraint_name);
    if (!fk) {
      fk = {
        name: row.constraint_name,
        columns: [],
        referencedTable: row.referenced_table,
        referencedColumns: [],
      };
      table.foreignKeys.push(fk);
    }
    fk.columns.push(row.column_name);
    fk.referencedColumns.push(row.referenced_column);
  }
  for (const row of rows.indexRows) {
    const table = tables.get(`${row.schema}.${row.name}`);
    if (!table) continue;
    let index = table.indexes.find((item) => item.name === row.index_name);
    if (!index) {
      index = { name: row.index_name, unique: Boolean(row.is_unique), columns: [] };
      table.indexes.push(index);
    }
    index.columns.push(row.column_name);
  }
  return { tables: [...tables.values()], refreshedAt };
}

export async function introspectMysql(
  pool: MysqlPool,
  database: string,
): Promise<SchemaSnapshot> {
  const [tableRows] = await pool.query(
    `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_COMMENT, TABLE_ROWS FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_NAME`,
    [database],
  );
  const [columnRows] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [database],
  );
  const [indexRows] = await pool.query(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [database],
  );
  const [fkRows] = await pool.query(
    `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [database],
  );

  return buildMysqlSnapshot({
    tableRows: tableRows as unknown as MysqlTableRow[],
    columnRows: columnRows as unknown as MysqlColumnRow[],
    indexRows: indexRows as unknown as MysqlIndexRow[],
    fkRows: fkRows as unknown as MysqlForeignKeyRow[],
  });
}

export async function introspectPostgres(pool: PgPool): Promise<SchemaSnapshot> {
  const tableResult = await pool.query(`
    SELECT n.nspname AS schema, c.relname AS name, obj_description(c.oid) AS comment,
           CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS row_estimate
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','v','m','p')
      AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
    ORDER BY n.nspname, c.relname
  `);
  const columnResult = await pool.query(`
    SELECT table_schema AS schema, table_name AS name, column_name AS column_name,
           data_type AS data_type, is_nullable AS is_nullable, column_default AS column_default,
           col_description((quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass, ordinal_position) AS comment
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog','information_schema')
    ORDER BY table_schema, table_name, ordinal_position
  `);
  const pkResult = await pool.query(`
    SELECT n.nspname AS schema, t.relname AS name, a.attname AS column_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE c.contype = 'p'
      AND n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY n.nspname, t.relname, k.ord
  `);
  const fkResult = await pool.query(`
    SELECT n.nspname AS schema, t.relname AS name, c.conname AS constraint_name,
           a.attname AS column_name, ft.relname AS referenced_table,
           fa.attname AS referenced_column
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    JOIN pg_class ft ON ft.oid = c.confrelid
    JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
    JOIN pg_attribute fa ON fa.attrelid = ft.oid AND fa.attnum = fk.attnum
    WHERE c.contype = 'f'
      AND n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY n.nspname, t.relname, c.conname, k.ord
  `);
  const indexResult = await pool.query(`
    SELECT n.nspname AS schema, t.relname AS name, i.relname AS index_name, ix.indisunique AS is_unique,
           COALESCE(a.attname, pg_get_indexdef(ix.indexrelid, k.ord::int, true)) AS column_name
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0
    WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY n.nspname, t.relname, i.relname, k.ord
  `);

  return buildPostgresSnapshot({
    tableRows: tableResult.rows as PostgresTableRow[],
    columnRows: columnResult.rows as PostgresColumnRow[],
    primaryKeyRows: pkResult.rows as PostgresPrimaryKeyRow[],
    foreignKeyRows: fkResult.rows as PostgresForeignKeyRow[],
    indexRows: indexResult.rows as PostgresIndexRow[],
  });
}
