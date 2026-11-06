import { PassThrough, Readable } from "node:stream";
import ExcelJS from "exceljs";
import type { ColumnInfo } from "./artifacts.js";

/** Export limits keep a single download bounded (HTTP 413 above this). */
export const EXPORT_MAX_ROWS = 100_000;

const WIDTH_SAMPLE_ROWS = 200;
const MIN_COLUMN_WIDTH = 10;
const MAX_COLUMN_WIDTH = 60;
const BOM = "\uFEFF";

/**
 * Spreadsheet apps treat a leading `= + - @`, tab or CR as a formula trigger, so a
 * string cell must be prefixed with a literal `'` to stay text. Typed values
 * (numbers, dates, booleans, bigints) are written unchanged.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function escapeFormula(text: string): string {
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}

/** RFC4180: quote when the value contains a delimiter, quote or line break. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  let text: string;
  if (typeof value === "object") {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  if (typeof value === "string") text = escapeFormula(text);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64").slice(0, MAX_COLUMN_WIDTH);
  }
  if (typeof value === "object") {
    try {
      return (JSON.stringify(value) ?? "").slice(0, MAX_COLUMN_WIDTH);
    } catch {
      return "";
    }
  }
  return String(value).slice(0, MAX_COLUMN_WIDTH);
}

function xlsxCell(value: unknown, column: ColumnInfo | undefined): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  // Write dates as ISO text so the value is not reinterpreted through an Excel
  // serial-date format on the receiving side.
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    // Driver decimals arrive as strings; a column the executor typed as numeric
    // must stay numeric in Excel instead of turning into text.
    if (column?.type === "number" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return value;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Close an async source when the consumer (HTTP response) disconnects early. */
async function closeSource(rows: AsyncIterable<unknown[]>): Promise<void> {
  const closeable = rows as AsyncIterable<unknown[]> & {
    return?: () => Promise<IteratorResult<unknown[]>>;
  };
  if (typeof closeable.return === "function") {
    try {
      await closeable.return();
    } catch {
      // The source is already finished; there is nothing left to release.
    }
  }
}

async function* withClosedSource(rows: AsyncIterable<unknown[]>): AsyncGenerator<unknown[]> {
  try {
    for await (const row of rows) yield row;
  } finally {
    await closeSource(rows);
  }
}

/** Close the row source if the consumer destroys the readable before the end. */
function closeOnDestroy(stream: Readable, rows: AsyncIterable<unknown[]>): void {
  stream.once("close", () => {
    void closeSource(rows);
  });
}

/** UTF-8 BOM + RFC4180 CSV, streamed row by row. */
export function csvStream(
  columns: ColumnInfo[],
  rows: AsyncIterable<unknown[]> | AsyncGenerator<unknown[], void, void>,
): Readable {
  const stream = Readable.from(
    (async function* csv(): AsyncGenerator<string> {
      try {
        yield `${BOM}${columns.map((column) => csvCell(column.name)).join(",")}\r\n`;
        for await (const row of rows) {
          yield `${row.map(csvCell).join(",")}\r\n`;
        }
      } finally {
        await closeSource(rows);
      }
    })(),
  );
  closeOnDestroy(stream, rows);
  return stream;
}

/** Streaming XLSX workbook with a bold/frozen header and sampled column widths. */
export function xlsxStream(
  columns: ColumnInfo[],
  rows: AsyncIterable<unknown[]> | AsyncGenerator<unknown[], void, void>,
): Readable {
  const output = new PassThrough();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useStyles: true,
    useSharedStrings: false,
  });
  void writeWorkbook(workbook, columns, withClosedSource(rows)).catch((error: unknown) => {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  closeOnDestroy(output, rows);
  return output;
}

async function writeWorkbook(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  columns: ColumnInfo[],
  rows: AsyncIterable<unknown[]>,
): Promise<void> {
  const sheet = workbook.addWorksheet("结果", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const iterator = rows[Symbol.asyncIterator]();
  try {
    // Sample the first N rows so widths are known before any row is committed;
    // the streaming writer cannot revisit column metadata afterwards.
    const sampled: unknown[][] = [];
    while (sampled.length < WIDTH_SAMPLE_ROWS) {
      const next = await iterator.next();
      if (next.done) break;
      sampled.push(next.value);
    }

    const widths = columns.map((column, index) => {
      let width = column.name.length;
      for (const row of sampled) {
        width = Math.max(width, cellText(row[index]).length);
      }
      return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width + 2));
    });
    sheet.columns = widths.map((width) => ({ width }));

    const header = sheet.addRow(columns.map((column) => column.name));
    header.font = { bold: true };
    header.commit();

    const addRow = (row: unknown[]): void => {
      sheet
        .addRow(row.map((value, index) => xlsxCell(value, columns[index])))
        .commit();
    };
    for (const row of sampled) addRow(row);
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      addRow(next.value);
    }
    await workbook.commit();
  } finally {
    await closeSource(rows);
  }
}
