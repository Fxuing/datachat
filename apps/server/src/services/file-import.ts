import path from "node:path";
import ExcelJS from "exceljs";
import type {
  FileColumnFormatHint,
  FileColumnType,
  FileTableColumn,
} from "../db/repositories/conversation-files.js";

export const FILE_MAX_SIZE_BYTES = 20 * 1024 * 1024;
export const FILE_MAX_FILES_PER_UPLOAD = 5;
export const FILE_MAX_TABLES_PER_CONVERSATION = 10;
export const FILE_MAX_ROWS_PER_CONVERSATION = 200_000;
export const FILE_MAX_COLUMNS_PER_TABLE = 200;
export const FILE_MAX_HEADER_ROW = 20;
export const FILE_SAMPLE_ROWS = 3;

const HEADER_SCAN_LIMIT = 10;
const TYPE_SAMPLE_LIMIT = 1_000;
const MAX_IDENT_LENGTH = 48;
const MAX_SAMPLE_VALUE_LENGTH = 40;
const MAX_PREVIEW_CELL_LENGTH = 120;

export type FileImportErrorCode =
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FILE_TYPE"
  | "EMPTY_FILE"
  | "TOO_MANY_FILES"
  | "TOO_MANY_TABLES"
  | "TOO_MANY_ROWS"
  | "TOO_MANY_COLUMNS"
  | "INVALID_HEADER_ROW"
  | "PARSE_ERROR";

export class FileImportError extends Error {
  constructor(
    readonly code: FileImportErrorCode,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "FileImportError";
  }
}

export interface UploadedFileInput {
  fileName: string;
  buffer: Buffer;
  /** Optional 1-based header row override; omit or pass 0 for auto-detection. */
  headerRow?: number;
}

export interface ParsedTable {
  tableName: string;
  displayName: string;
  sheetName: string | null;
  rowCount: number;
  columns: FileTableColumn[];
  sampleRows: Array<Array<string | number | null>>;
  warnings: string[];
  rows: Array<Array<string | number | null>>;
}

export interface ParsedFileResult {
  fileName: string;
  fileType: "xlsx" | "csv";
  sizeBytes: number;
  headerRow: number;
  detectedHeaderRow: number;
  tableCount: number;
  rowCount: number;
  tables: ParsedTable[];
}

export interface ParseUploadedFilesOptions {
  existingTableNames?: Iterable<string>;
  existingTableCount?: number;
  existingRowCount?: number;
}

export interface ParseUploadedFilesResult {
  files: ParsedFileResult[];
  allTables: ParsedTable[];
  totalTables: number;
  totalRows: number;
}

type RawCellValue = string | number | boolean | Date | null;

interface RawSheetGrid {
  sheetName: string | null;
  /** 0-based rows including blank rows up to the last non-empty row. */
  rows: RawCellValue[][];
  /** Tracks distinct master addresses in early rows so horizontal merged title banners count as 1 value. */
  distinctBannerCounts: number[];
  hasMergedDataCells: boolean;
  formulaErrorCount: number;
}

const GENERIC_SHEET_NAMES = new Set(["sheet", "sheet1", "工作表", "工作表1"]);

function safeBaseName(fileName: string): string {
  const normalized = path.basename(fileName.trim() || "uploaded_file");
  return normalized || "uploaded_file";
}

function fileExtension(fileName: string): string {
  return path.extname(fileName.trim()).toLowerCase();
}

function detectFileType(fileName: string): "xlsx" | "csv" {
  const ext = fileExtension(fileName);
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".csv") return "csv";
  if (ext === ".xls") {
    throw new FileImportError(
      "UNSUPPORTED_FILE_TYPE",
      "暂不支持旧版 .xls 格式，请先在 Excel 中另存为 .xlsx 或 .csv 后上传",
      400,
    );
  }
  throw new FileImportError(
    "UNSUPPORTED_FILE_TYPE",
    `文件「${safeBaseName(fileName)}」格式不支持，仅支持 .xlsx 和 .csv 文件`,
    400,
  );
}

/** Decode CSV buffer: strip UTF-8 BOM, try strict UTF-8, then fallback to GB18030. */
export function decodeCsvBuffer(buffer: Buffer): string {
  let slice = buffer;
  if (
    slice.length >= 3 &&
    slice[0] === 0xef &&
    slice[1] === 0xbb &&
    slice[2] === 0xbf
  ) {
    slice = slice.subarray(3);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    return new TextDecoder("gb18030", { fatal: false }).decode(slice);
  }
}

function sniffCsvDelimiter(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  const firstNonEmpty = lines.find((line) => line.trim().length > 0) ?? "";
  if (!firstNonEmpty) return ",";
  if (firstNonEmpty.includes(",")) return ",";
  if (firstNonEmpty.includes("\t")) return "\t";
  if (firstNonEmpty.includes(";")) return ";";
  return ",";
}

/** RFC 4180 compliant CSV parser handling quoted newlines and escaped quotes. */
export function parseCsvText(text: string): RawCellValue[][] {
  const delimiter = sniffCsvDelimiter(text);
  const rows: RawCellValue[][] = [];
  let row: RawCellValue[] = [];
  let field = "";
  let inQuotes = false;
  let fieldQuoted = false;

  const pushField = () => {
    if (!fieldQuoted && field.trim() === "") {
      row.push(null);
    } else if (field === "" && fieldQuoted) {
      row.push("");
    } else {
      row.push(field);
    }
    field = "";
    fieldQuoted = false;
  };

  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      fieldQuoted = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      continue;
    }
    if (ch === "\n") {
      pushRow();
      continue;
    }
    field += ch;
  }

  if (field.length > 0 || fieldQuoted || row.length > 0) {
    pushRow();
  }

  // Drop trailing empty lines that often appear at EOF in CSV exports.
  while (rows.length > 0 && isRowBlank(rows[rows.length - 1]!)) {
    rows.pop();
  }

  return rows;
}

function isRowBlank(row: RawCellValue[]): boolean {
  return row.every((cell) => cell === null || String(cell).trim() === "");
}

function extractRichText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  const record = value as { richText?: Array<{ text?: string }> };
  if (Array.isArray(record.richText)) {
    return record.richText.map((part) => part.text ?? "").join("");
  }
  return String(value);
}

function extractExcelCellValue(
  rawValue: ExcelJS.CellValue,
  counters: { formulaErrors: number },
): RawCellValue {
  if (rawValue === null || rawValue === undefined) return null;
  if (
    typeof rawValue === "string" ||
    typeof rawValue === "number" ||
    typeof rawValue === "boolean" ||
    rawValue instanceof Date
  ) {
    return rawValue;
  }
  if (typeof rawValue !== "object") return String(rawValue);

  const obj = rawValue as unknown as Record<string, unknown>;
  if (Array.isArray(obj.richText)) {
    return (obj.richText as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
  }
  if ("error" in obj) {
    counters.formulaErrors += 1;
    return null;
  }
  if ("result" in obj || "formula" in obj || "sharedFormula" in obj) {
    const result = obj.result as ExcelJS.CellValue | undefined;
    if (result === undefined) return null;
    return extractExcelCellValue(result, counters);
  }
  if ("text" in obj || "hyperlink" in obj) {
    const text = obj.text !== undefined ? extractRichText(obj.text) : "";
    if (text.trim()) return text;
    return typeof obj.hyperlink === "string" ? obj.hyperlink : null;
  }
  return String(rawValue);
}

async function parseXlsxGrids(buffer: Buffer, fileName: string): Promise<RawSheetGrid[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    const arrayBuffer = Uint8Array.from(buffer).buffer;
    await workbook.xlsx.load(arrayBuffer);
  } catch (error) {
    throw new FileImportError(
      "PARSE_ERROR",
      `文件「${fileName}」无法作为有效的 .xlsx 解析：${error instanceof Error ? error.message : String(error)}`,
      400,
    );
  }

  const grids: RawSheetGrid[] = [];
  for (const worksheet of workbook.worksheets) {
    if (worksheet.state === "hidden" || worksheet.state === "veryHidden") continue;
    const rowCount = worksheet.rowCount;
    const colCount = worksheet.columnCount;
    if (rowCount <= 0 || colCount <= 0) continue;

    const counters = { formulaErrors: 0 };
    const rows: RawCellValue[][] = [];
    const distinctBannerCounts: number[] = [];
    let hasMergedDataCells = false;
    let lastNonEmptyRowIndex = -1;

    for (let r = 1; r <= rowCount; r += 1) {
      const wsRow = worksheet.getRow(r);
      const rowValues: RawCellValue[] = new Array(colCount).fill(null);
      const distinctMasterAddresses = new Set<string>();
      let rowHasValue = false;

      for (let c = 1; c <= colCount; c += 1) {
        const cell = wsRow.getCell(c);
        const isSlaveMerge = Boolean(cell.isMerged && cell.master && cell.address !== cell.master.address);
        const targetCell = isSlaveMerge ? cell.master : cell;
        const val = extractExcelCellValue(targetCell.value, counters);
        const normalized = typeof val === "string" && val.trim() === "" ? null : val;
        rowValues[c - 1] = normalized;
        if (normalized !== null) {
          rowHasValue = true;
          distinctMasterAddresses.add(targetCell.address);
          if (isSlaveMerge) {
            hasMergedDataCells = true;
          }
        }
      }

      // Trim trailing nulls on each row so sparse formatting columns do not inflate width.
      let lastNonNull = rowValues.length - 1;
      while (lastNonNull >= 0 && rowValues[lastNonNull] === null) {
        lastNonNull -= 1;
      }
      const trimmedRow = lastNonNull >= 0 ? rowValues.slice(0, lastNonNull + 1) : [];
      rows.push(trimmedRow);
      distinctBannerCounts.push(distinctMasterAddresses.size);
      if (rowHasValue) lastNonEmptyRowIndex = rows.length - 1;
    }

    if (lastNonEmptyRowIndex < 0) continue;
    grids.push({
      sheetName: worksheet.name,
      rows: rows.slice(0, lastNonEmptyRowIndex + 1),
      distinctBannerCounts: distinctBannerCounts.slice(0, lastNonEmptyRowIndex + 1),
      hasMergedDataCells,
      formulaErrorCount: counters.formulaErrors,
    });
  }

  return grids;
}

function normalizeTextCell(value: RawCellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatUtcDate(value);
  return String(value).trim();
}

function detectHeaderRowIndex(grid: RawSheetGrid): number {
  const { rows, distinctBannerCounts } = grid;
  const limit = Math.min(HEADER_SCAN_LIMIT, rows.length);
  let maxCols = 0;
  for (let i = 0; i < limit; i += 1) {
    maxCols = Math.max(maxCols, rows[i]?.length ?? 0);
  }
  const minRequired = maxCols <= 1 ? 1 : Math.max(2, Math.ceil(maxCols * 0.5));

  for (let i = 0; i < limit; i += 1) {
    const row = rows[i] ?? [];
    if (isRowBlank(row)) continue;
    if (distinctBannerCounts[i]! === 1 && maxCols > 1) {
      // Single merged cell spanning across a wide table is almost always a report title banner.
      continue;
    }
    const nonEmptyTexts = row
      .map((cell) => normalizeTextCell(cell))
      .filter((text) => text.length > 0);
    const uniqueCount = new Set(nonEmptyTexts).size;
    if (uniqueCount >= minRequired) {
      return i;
    }
  }

  // Fallback: first non-blank row.
  const firstNonBlank = rows.findIndex((row) => !isRowBlank(row));
  return firstNonBlank >= 0 ? firstNonBlank : 0;
}

export function sanitizeIdentifier(
  raw: string,
  fallbackPrefix: "t" | "c",
  index?: number,
): string {
  const cleaned = raw
    .trim()
    .replace(/[^\u4e00-\u9fffA-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  let candidate = cleaned;
  if (!candidate) {
    candidate = index !== undefined ? `${fallbackPrefix}_${index}` : `${fallbackPrefix}_1`;
  }
  if (/^\d/.test(candidate) || candidate.toLowerCase().startsWith("sqlite_")) {
    candidate = `${fallbackPrefix}_${candidate}`;
  }
  if (candidate.length > MAX_IDENT_LENGTH) {
    candidate = candidate.slice(0, MAX_IDENT_LENGTH).replace(/_+$/g, "") || `${fallbackPrefix}_1`;
  }
  return candidate;
}

function allocateUniqueName(
  desired: string,
  usedLower: Set<string>,
  prefix: "t" | "c",
): string {
  const base = sanitizeIdentifier(desired, prefix);
  let candidate = base;
  let suffix = 2;
  while (usedLower.has(candidate.toLowerCase())) {
    const tag = `_${suffix}`;
    const stem = base.slice(0, Math.max(1, MAX_IDENT_LENGTH - tag.length));
    candidate = `${stem}${tag}`;
    suffix += 1;
  }
  usedLower.add(candidate.toLowerCase());
  return candidate;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ExcelJS returns serial dates as UTC Date objects; always read UTC fields to avoid off-by-one-day shifts. */
function formatUtcDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const hh = date.getUTCHours();
  const mm = date.getUTCMinutes();
  const ss = date.getUTCSeconds();
  if (hh === 0 && mm === 0 && ss === 0) {
    return `${y}-${m}-${d}`;
  }
  return `${y}-${m}-${d} ${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

interface NormalizedDateMatch {
  kind: "DATE" | "DATETIME";
  iso: string;
}

function tryParseDateString(raw: string): NormalizedDateMatch | null {
  const text = raw.trim();
  if (!text) return null;

  // Match YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD, YYYY年M月D日 with optional HH:mm[:ss]
  const match = text.match(
    /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return null;

  if (match[4] === undefined) {
    return { kind: "DATE", iso: `${year}-${pad2(month)}-${pad2(day)}` };
  }
  const hh = Number(match[4]);
  const mm = Number(match[5]);
  const ss = Number(match[6] ?? "0");
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null;
  return {
    kind: "DATETIME",
    iso: `${year}-${pad2(month)}-${pad2(day)} ${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`,
  };
}

interface ParsedNumberMatch {
  value: number;
  isInteger: boolean;
  hint?: FileColumnFormatHint;
}

function tryParseNumericString(raw: string): ParsedNumberMatch | null {
  const text = raw.trim();
  if (!text) return null;

  // Preserve leading-zero codes (e.g. 00123, 010) and long numeric IDs (15+ digits) as TEXT.
  const unsignedDigits = text.replace(/^[+-]/, "");
  if (/^0\d+$/.test(unsignedDigits)) return null;
  if (/^\d{15,}$/.test(unsignedDigits)) return null;

  // Plain integer/decimal
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    const num = Number(text);
    if (!Number.isFinite(num)) return null;
    const isInt = !text.includes(".") && Number.isSafeInteger(num);
    if (!isInt && /^\d+$/.test(unsignedDigits)) {
      // Integer exceeding JS safe integer range must stay TEXT.
      return null;
    }
    return { value: num, isInteger: isInt };
  }

  // Thousands separated number: 1,234 or 1,234.56
  if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) {
    const cleaned = text.replace(/,/g, "");
    const num = Number(cleaned);
    if (!Number.isFinite(num)) return null;
    const isInt = !cleaned.includes(".") && Number.isSafeInteger(num);
    return { value: num, isInteger: isInt, hint: "thousands" };
  }

  // Currency prefix: ¥1,234.50 / ￥100 / -$99.5
  const currencyMatch = text.match(
    /^([+-]?)\s*[¥￥$]\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)$/,
  );
  if (currencyMatch) {
    const cleaned = `${currencyMatch[1]}${currencyMatch[2]!.replace(/,/g, "")}`;
    const num = Number(cleaned);
    if (!Number.isFinite(num)) return null;
    const isInt = !cleaned.includes(".") && Number.isSafeInteger(num);
    return { value: num, isInteger: isInt, hint: "currency" };
  }

  // Percentage: 12.5% -> 0.125
  const percentMatch = text.match(/^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)%$/);
  if (percentMatch) {
    const num = Number(percentMatch[1]!.replace(/,/g, ""));
    if (!Number.isFinite(num)) return null;
    const ratio = Number((num / 100).toPrecision(12));
    return { value: ratio, isInteger: false, hint: "percent" };
  }

  return null;
}

function rawCellToFallbackText(value: RawCellValue): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return formatUtcDate(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : String(value);
}

interface ColumnAnalysis {
  type: FileColumnType;
  nullable: boolean;
  formatHint?: FileColumnFormatHint;
  sampleValues: string[];
  normalizedValues: Array<string | number | null>;
}

function collectNormalizedSamples(
  values: Array<string | number | null>,
): string[] {
  const sampleValues: string[] = [];
  const seen = new Set<string>();
  for (const val of values) {
    if (val === null || val === undefined) continue;
    const text = String(val).trim();
    if (!text) continue;
    const clipped =
      text.length > MAX_SAMPLE_VALUE_LENGTH
        ? `${text.slice(0, MAX_SAMPLE_VALUE_LENGTH - 1)}…`
        : text;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    sampleValues.push(clipped);
    if (sampleValues.length >= 3) break;
  }
  return sampleValues;
}

function analyzeColumn(rawRows: RawCellValue[][], colIndex: number): ColumnAnalysis {
  let nullable = false;
  let nonNullCount = 0;
  let allIntegers = true;
  let allNumeric = true;
  let allDates = true;
  let hasDateTime = false;
  let hasCurrency = false;
  let hasPercent = false;
  let hasThousands = false;

  const numericCandidates = new Array<number | null>(rawRows.length).fill(null);
  const dateCandidates = new Array<string | null>(rawRows.length).fill(null);
  const textFallbacks = new Array<string | null>(rawRows.length).fill(null);

  for (let r = 0; r < rawRows.length; r += 1) {
    const raw = rawRows[r]?.[colIndex] ?? null;
    const textVal = rawCellToFallbackText(raw);
    textFallbacks[r] = textVal;

    if (textVal === null) {
      nullable = true;
      continue;
    }

    nonNullCount += 1;

    // Only continue strict type inference when at least one type hypothesis is still alive
    // (within the sample window for initial decision, and for remaining rows to prevent silent loss).
    if (r >= TYPE_SAMPLE_LIMIT && !allNumeric && !allDates) {
      continue;
    }

    if (raw instanceof Date) {
      allNumeric = false;
      allIntegers = false;
      const iso = formatUtcDate(raw);
      if (iso.includes(" ")) hasDateTime = true;
      dateCandidates[r] = iso;
      continue;
    }

    if (typeof raw === "number") {
      allDates = false;
      if (!Number.isFinite(raw)) {
        allNumeric = false;
        allIntegers = false;
      } else {
        numericCandidates[r] = raw;
        if (!Number.isSafeInteger(raw)) allIntegers = false;
      }
      continue;
    }

    if (typeof raw === "boolean") {
      allDates = false;
      numericCandidates[r] = raw ? 1 : 0;
      continue;
    }

    const str = String(raw).trim();
    if (allDates) {
      const parsedDate = tryParseDateString(str);
      if (parsedDate) {
        if (parsedDate.kind === "DATETIME") hasDateTime = true;
        dateCandidates[r] = parsedDate.iso;
      } else {
        allDates = false;
      }
    }

    if (allNumeric) {
      const parsedNum = tryParseNumericString(str);
      if (parsedNum) {
        numericCandidates[r] = parsedNum.value;
        if (!parsedNum.isInteger) allIntegers = false;
        if (parsedNum.hint === "currency") hasCurrency = true;
        else if (parsedNum.hint === "percent") hasPercent = true;
        else if (parsedNum.hint === "thousands") hasThousands = true;
      } else {
        allNumeric = false;
        allIntegers = false;
      }
    }
  }

  if (nonNullCount === 0) {
    return {
      type: "TEXT",
      nullable: true,
      sampleValues: [],
      normalizedValues: textFallbacks,
    };
  }

  if (allDates) {
    const type: FileColumnType = hasDateTime ? "DATETIME" : "DATE";
    const normalizedValues = dateCandidates.map((val) => {
      if (val === null) return null;
      return hasDateTime && !val.includes(" ") ? `${val} 00:00:00` : val;
    });
    return {
      type,
      nullable,
      sampleValues: collectNormalizedSamples(normalizedValues),
      normalizedValues,
    };
  }

  if (allNumeric) {
    const type: FileColumnType = allIntegers && !hasPercent ? "INTEGER" : "REAL";
    const formatHint: FileColumnFormatHint | undefined = hasPercent
      ? "percent"
      : hasCurrency
        ? "currency"
        : hasThousands
          ? "thousands"
          : undefined;
    return {
      type,
      nullable,
      ...(formatHint ? { formatHint } : {}),
      sampleValues: collectNormalizedSamples(numericCandidates),
      normalizedValues: numericCandidates,
    };
  }

  return {
    type: "TEXT",
    nullable,
    sampleValues: collectNormalizedSamples(textFallbacks),
    normalizedValues: textFallbacks,
  };
}

function truncatePreviewCell(value: string | number | null): string | number | null {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_PREVIEW_CELL_LENGTH) return value;
  return `${value.slice(0, MAX_PREVIEW_CELL_LENGTH - 1)}…`;
}

function buildTableFromGrid(input: {
  grid: RawSheetGrid;
  fileStem: string;
  multiSheet: boolean;
  requestedHeaderRow?: number;
  usedTableNames: Set<string>;
}): { table: ParsedTable; headerRow: number; detectedHeaderRow: number } {
  const { grid, fileStem, multiSheet, requestedHeaderRow, usedTableNames } = input;
  const detectedIndex = detectHeaderRowIndex(grid);
  const detectedHeaderRow = detectedIndex + 1;

  let headerIndex = detectedIndex;
  if (requestedHeaderRow !== undefined && requestedHeaderRow > 0) {
    if (requestedHeaderRow > FILE_MAX_HEADER_ROW) {
      throw new FileImportError(
        "INVALID_HEADER_ROW",
        `表头行不能超过第 ${FILE_MAX_HEADER_ROW} 行`,
        400,
      );
    }
    if (requestedHeaderRow > grid.rows.length) {
      throw new FileImportError(
        "INVALID_HEADER_ROW",
        `指定的第 ${requestedHeaderRow} 行超出工作表总行数（${grid.rows.length} 行）`,
        400,
      );
    }
    headerIndex = requestedHeaderRow - 1;
  }

  const headerRawRow = grid.rows[headerIndex] ?? [];
  const dataRawRows = grid.rows.slice(headerIndex + 1).filter((row) => !isRowBlank(row));

  // Determine the effective column width across header + data rows, ignoring trailing blank columns.
  let rawWidth = headerRawRow.length;
  for (const row of dataRawRows) {
    rawWidth = Math.max(rawWidth, row.length);
  }
  while (rawWidth > 0) {
    const colIdx = rawWidth - 1;
    const headerText = normalizeTextCell(headerRawRow[colIdx] ?? null);
    const hasData = dataRawRows.some((row) => normalizeTextCell(row[colIdx] ?? null) !== "");
    if (headerText !== "" || hasData) break;
    rawWidth -= 1;
  }

  if (rawWidth === 0) {
    throw new FileImportError(
      "EMPTY_FILE",
      grid.sheetName ? `工作表「${grid.sheetName}」没有可用列` : "文件没有可用列",
      400,
    );
  }
  if (rawWidth > FILE_MAX_COLUMNS_PER_TABLE) {
    throw new FileImportError(
      "TOO_MANY_COLUMNS",
      `单表最多支持 ${FILE_MAX_COLUMNS_PER_TABLE} 列，当前共有 ${rawWidth} 列`,
      400,
    );
  }

  const usedColNames = new Set<string>();
  const columnMetaBase: Array<{ name: string; originalName: string }> = [];
  let renamedHeaders = 0;
  for (let c = 0; c < rawWidth; c += 1) {
    const rawText = normalizeTextCell(headerRawRow[c] ?? null);
    const originalName = rawText || `col_${c + 1}`;
    const desired = rawText ? sanitizeIdentifier(rawText, "c", c + 1) : `col_${c + 1}`;
    const uniqueName = allocateUniqueName(desired, usedColNames, "c");
    if (uniqueName !== originalName) renamedHeaders += 1;
    columnMetaBase.push({ name: uniqueName, originalName });
  }

  const analyses = columnMetaBase.map((_, c) => analyzeColumn(dataRawRows, c));
  const columns: FileTableColumn[] = columnMetaBase.map((meta, c) => {
    const analysis = analyses[c]!;
    return {
      name: meta.name,
      originalName: meta.originalName,
      type: analysis.type,
      nullable: analysis.nullable,
      ...(analysis.formatHint ? { formatHint: analysis.formatHint } : {}),
      sampleValues: analysis.sampleValues,
    };
  });

  const rows: Array<Array<string | number | null>> = [];
  for (let r = 0; r < dataRawRows.length; r += 1) {
    const row = new Array<string | number | null>(rawWidth);
    for (let c = 0; c < rawWidth; c += 1) {
      row[c] = analyses[c]!.normalizedValues[r] ?? null;
    }
    rows.push(row);
  }

  const sampleRows = rows
    .slice(0, FILE_SAMPLE_ROWS)
    .map((row) => row.map((cell) => truncatePreviewCell(cell)));

  const warnings: string[] = [];
  if (headerIndex > 0 && !(requestedHeaderRow && requestedHeaderRow > 0)) {
    warnings.push(`自动跳过前 ${headerIndex} 行标题/空行，将第 ${headerIndex + 1} 行识别为表头`);
  }
  if (grid.hasMergedDataCells) {
    warnings.push("检测到合并单元格，已按主单元格值填充");
  }
  if (grid.formulaErrorCount > 0) {
    warnings.push(`检测到 ${grid.formulaErrorCount} 个公式错误单元格，已按空值处理`);
  }
  if (renamedHeaders > 0) {
    warnings.push(`部分列名已自动规范化或去重（共 ${renamedHeaders} 列）`);
  }

  let desiredTableName = fileStem;
  let displayName = fileStem;
  if (grid.sheetName) {
    const genericSheet = GENERIC_SHEET_NAMES.has(grid.sheetName.trim().toLowerCase());
    if (multiSheet) {
      desiredTableName = `${fileStem}_${grid.sheetName}`;
      displayName = `${fileStem} - ${grid.sheetName}`;
    } else if (!genericSheet) {
      desiredTableName = grid.sheetName;
      displayName = grid.sheetName;
    }
  }
  const tableName = allocateUniqueName(desiredTableName, usedTableNames, "t");

  return {
    table: {
      tableName,
      displayName,
      sheetName: grid.sheetName,
      rowCount: rows.length,
      columns,
      sampleRows,
      warnings,
      rows,
    },
    headerRow: headerIndex + 1,
    detectedHeaderRow,
  };
}

export async function parseUploadedFiles(
  inputs: UploadedFileInput[],
  options: ParseUploadedFilesOptions = {},
): Promise<ParseUploadedFilesResult> {
  if (inputs.length === 0) {
    throw new FileImportError("EMPTY_FILE", "请至少选择一个 Excel 或 CSV 文件", 400);
  }
  if (inputs.length > FILE_MAX_FILES_PER_UPLOAD) {
    throw new FileImportError(
      "TOO_MANY_FILES",
      `单次最多上传 ${FILE_MAX_FILES_PER_UPLOAD} 个文件`,
      400,
    );
  }

  const usedTableNames = new Set<string>(
    Array.from(options.existingTableNames ?? [], (name) => name.toLowerCase()),
  );
  const existingTableCount = options.existingTableCount ?? 0;
  const existingRowCount = options.existingRowCount ?? 0;

  const parsedFiles: ParsedFileResult[] = [];
  const allTables: ParsedTable[] = [];
  let newTableCount = 0;
  let newRowCount = 0;

  for (const input of inputs) {
    const fileName = safeBaseName(input.fileName);
    const fileType = detectFileType(fileName);
    if (input.buffer.length === 0) {
      throw new FileImportError("EMPTY_FILE", `文件「${fileName}」为空`, 400);
    }
    if (input.buffer.length > FILE_MAX_SIZE_BYTES) {
      throw new FileImportError(
        "FILE_TOO_LARGE",
        `文件「${fileName}」超过单个文件 20 MB 上限`,
        413,
      );
    }

    let grids: RawSheetGrid[];
    if (fileType === "csv") {
      const text = decodeCsvBuffer(input.buffer);
      const rows = parseCsvText(text);
      grids =
        rows.length === 0
          ? []
          : [
              {
                sheetName: null,
                rows,
                distinctBannerCounts: rows.map(
                  (r) =>
                    new Set(
                      r.map((cell) => normalizeTextCell(cell)).filter((v) => v.length > 0),
                    ).size,
                ),
                hasMergedDataCells: false,
                formulaErrorCount: 0,
              },
            ];
    } else {
      grids = await parseXlsxGrids(input.buffer, fileName);
    }

    if (grids.length === 0) {
      throw new FileImportError("EMPTY_FILE", `文件「${fileName}」中没有包含数据的表格`, 400);
    }

    const fileStem = path.basename(fileName, fileExtension(fileName));
    const multiSheet = grids.length > 1;
    const fileTables: ParsedTable[] = [];
    let fileHeaderRow = 1;
    let fileDetectedHeaderRow = 1;
    let fileTotalRows = 0;

    for (let i = 0; i < grids.length; i += 1) {
      newTableCount += 1;
      if (existingTableCount + newTableCount > FILE_MAX_TABLES_PER_CONVERSATION) {
        throw new FileImportError(
          "TOO_MANY_TABLES",
          `单个会话最多支持 ${FILE_MAX_TABLES_PER_CONVERSATION} 张表`,
          400,
        );
      }

      const built = buildTableFromGrid({
        grid: grids[i]!,
        fileStem,
        multiSheet,
        requestedHeaderRow: i === 0 ? input.headerRow : undefined,
        usedTableNames,
      });

      newRowCount += built.table.rowCount;
      if (existingRowCount + newRowCount > FILE_MAX_ROWS_PER_CONVERSATION) {
        throw new FileImportError(
          "TOO_MANY_ROWS",
          `单个会话总数据行数不能超过 ${FILE_MAX_ROWS_PER_CONVERSATION.toLocaleString("en-US")} 行`,
          400,
        );
      }

      if (i === 0) {
        fileHeaderRow = built.headerRow;
        fileDetectedHeaderRow = built.detectedHeaderRow;
      }
      fileTotalRows += built.table.rowCount;
      fileTables.push(built.table);
      allTables.push(built.table);
    }

    parsedFiles.push({
      fileName,
      fileType,
      sizeBytes: input.buffer.length,
      headerRow: fileHeaderRow,
      detectedHeaderRow: fileDetectedHeaderRow,
      tableCount: fileTables.length,
      rowCount: fileTotalRows,
      tables: fileTables,
    });
  }

  return {
    files: parsedFiles,
    allTables,
    totalTables: newTableCount,
    totalRows: newRowCount,
  };
}
