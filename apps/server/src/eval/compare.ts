/** A normalized query result: column names are kept for diagnostics, not comparison. */
export interface QueryResultSet {
  columns: string[];
  rows: unknown[][];
}

export type CompareFailureReason = "column_count" | "row_count" | "value_mismatch";

export type CompareResult =
  | { equal: true }
  | {
      equal: false;
      reason: CompareFailureReason;
      detail: string;
      expectedSample?: unknown[][];
      actualSample?: unknown[][];
    };

const NUMERIC_STRING = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const SAMPLE_SIZE = 3;

function round(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Converts driver-specific cells (Date, bigint, Buffer, DECIMAL strings) to JSON-safe values. */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? round(value) : String(value);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && NUMERIC_STRING.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return round(parsed);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeValue(record[key])]),
    );
  }
  return value;
}

export function normalizeRow(row: unknown[]): unknown[] {
  return row.map(normalizeValue);
}

function rowKey(row: unknown[]): string {
  return JSON.stringify(row);
}

function sample(rows: unknown[][]): unknown[][] {
  return rows.slice(0, SAMPLE_SIZE);
}

/**
 * Compares two result sets by shape and values. Column names and SQL text are ignored;
 * unordered comparisons sort rows so dialect-specific ordering does not matter.
 */
export function compareResultSets(
  expected: QueryResultSet,
  actual: QueryResultSet,
  options: { ordered?: boolean } = {},
): CompareResult {
  if (expected.columns.length !== actual.columns.length) {
    return {
      equal: false,
      reason: "column_count",
      detail: `expected ${expected.columns.length} columns, got ${actual.columns.length}`,
      expectedSample: sample(expected.rows),
      actualSample: sample(actual.rows),
    };
  }

  if (expected.rows.length !== actual.rows.length) {
    return {
      equal: false,
      reason: "row_count",
      detail: `expected ${expected.rows.length} rows, got ${actual.rows.length}`,
      expectedSample: sample(expected.rows),
      actualSample: sample(actual.rows),
    };
  }

  const expectedRows = expected.rows.map(normalizeRow);
  const actualRows = actual.rows.map(normalizeRow);

  if (!options.ordered) {
    expectedRows.sort((left, right) => rowKey(left).localeCompare(rowKey(right)));
    actualRows.sort((left, right) => rowKey(left).localeCompare(rowKey(right)));
  }

  for (let index = 0; index < expectedRows.length; index += 1) {
    if (rowKey(expectedRows[index]!) !== rowKey(actualRows[index]!)) {
      return {
        equal: false,
        reason: "value_mismatch",
        detail: options.ordered
          ? `first mismatch at row ${index + 1}`
          : "sorted rows differ",
        expectedSample: sample(expectedRows),
        actualSample: sample(actualRows),
      };
    }
  }

  return { equal: true };
}
