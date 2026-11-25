import { PassThrough, Readable } from "node:stream";
import ExcelJS from "exceljs";
import { EXCEL_MAX_FILENAME_LENGTH, EXCEL_MAX_SHEET_NAME_LENGTH } from "@datachat/shared";
import type { ColumnInfo } from "./artifacts.js";

/** Export limits keep a single download bounded (HTTP 413 above this). */
export const EXPORT_MAX_ROWS = 100_000;

export interface XlsxSheetInput {
  name: string;
  columns: ColumnInfo[];
  rows: AsyncIterable<unknown[]> | AsyncGenerator<unknown[], void, void>;
}

const WIDTH_SAMPLE_ROWS = 200;
const MIN_COLUMN_WIDTH = 10;
const MAX_COLUMN_WIDTH = 60;
const BOM = "\uFEFF";

function stripControlChars(text: string): string {
  let result = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code !== 127) result += ch;
  }
  return result;
}

/** Sanitize a business filename stem (without extension) for HTTP Content-Disposition & display. */
export function sanitizeExcelFilename(
  raw: string,
  fallback = "datachat-export",
): string {
  const withoutControls = stripControlChars(raw)
    .trim()
    .replace(/\.xlsx?$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[ .-]+|[ .-]+$/g, "")
    .slice(0, EXCEL_MAX_FILENAME_LENGTH)
    .replace(/^[ .-]+|[ .-]+$/g, "");
  return withoutControls || fallback;
}

/**
 * Sanitize an Excel worksheet title: strip forbidden characters (`\ / ? * [ ] :` and
 * control characters), trim leading/trailing single quotes (reserved by Excel), and
 * cap at Excel's 31-character tab limit.
 */
export function sanitizeWorksheetName(raw: string, fallback: string): string {
  const cleaned = stripControlChars(raw)
    .replace(/[[\]:*?/\\]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^['_ ]+|['_ ]+$/g, "")
    .slice(0, EXCEL_MAX_SHEET_NAME_LENGTH)
    .trim()
    .replace(/^['_ ]+|['_ ]+$/g, "");
  return cleaned || fallback;
}

/** Sanitize and deduplicate worksheet names case-insensitively within Excel's 31-char limit. */
export function dedupeWorksheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, index) => {
    const base = sanitizeWorksheetName(raw, `Sheet${index + 1}`);
    if (!used.has(base.toLowerCase())) {
      used.add(base.toLowerCase());
      return base;
    }
    let counter = 2;
    for (;;) {
      const suffix = ` (${counter})`;
      const maxStem = Math.max(1, EXCEL_MAX_SHEET_NAME_LENGTH - suffix.length);
      const stem = base.slice(0, maxStem).trimEnd().replace(/'+$/g, "") || "Sheet";
      const candidate = `${stem}${suffix}`;
      const lower = candidate.toLowerCase();
      if (!used.has(lower)) {
        used.add(lower);
        return candidate;
      }
      counter += 1;
    }
  });
}

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

/** Streaming multi-sheet XLSX workbook with bold/frozen headers and sampled column widths. */
export function multiSheetXlsxStream(sheets: readonly XlsxSheetInput[]): Readable {
  if (sheets.length === 0) {
    throw new Error("multiSheetXlsxStream requires at least one sheet");
  }
  const output = new PassThrough();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useStyles: true,
    useSharedStrings: false,
  });
  const closeAll = (): void => {
    for (const sheet of sheets) {
      void closeSource(sheet.rows);
    }
  };
  output.once("close", closeAll);
  void writeMultiSheetWorkbook(workbook, sheets)
    .catch((error: unknown) => {
      output.destroy(error instanceof Error ? error : new Error(String(error)));
    })
    .finally(closeAll);
  return output;
}

/** Streaming XLSX workbook with a bold/frozen header and sampled column widths. */
export function xlsxStream(
  columns: ColumnInfo[],
  rows: AsyncIterable<unknown[]> | AsyncGenerator<unknown[], void, void>,
): Readable {
  return multiSheetXlsxStream([{ name: "结果", columns, rows }]);
}

async function writeMultiSheetWorkbook(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  sheets: readonly XlsxSheetInput[],
): Promise<void> {
  const sheetNames = dedupeWorksheetNames(sheets.map((sheet) => sheet.name));
  try {
    for (let index = 0; index < sheets.length; index += 1) {
      const sheetInput = sheets[index]!;
      await writeWorksheet(
        workbook,
        sheetNames[index]!,
        sheetInput.columns,
        withClosedSource(sheetInput.rows),
      );
    }
    await workbook.commit();
  } finally {
    await Promise.all(sheets.map((sheet) => closeSource(sheet.rows)));
  }
}

async function writeWorksheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  sheetName: string,
  columns: ColumnInfo[],
  rows: AsyncIterable<unknown[]>,
): Promise<void> {
  const sheet = workbook.addWorksheet(sheetName, {
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
    sheet.commit();
  } finally {
    await closeSource(rows);
  }
}
