import type { Db } from "../db/client.js";
import {
  importDepartmentMappings,
  type DepartmentMappingInput,
} from "../db/repositories/data-scope.js";

export interface MappingCsvResult {
  rows: DepartmentMappingInput[];
  errors: string[];
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(text: string): string[][] {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map(splitCsvLine);
}

const HEADER_ALIASES: Record<string, keyof DepartmentMappingInput> = {
  department_id: "departmentId",
  department_code: "departmentCode",
  external_id: "externalId",
  external_code: "externalCode",
  external_org_code: "externalOrgCode",
};

/** Parses the mapping import CSV; unknown headers and empty rows are reported, not thrown. */
export function parseMappingCsv(text: string): MappingCsvResult {
  const errors: string[] = [];
  const table = parseCsv(text).filter((cells) => cells.some((cell) => cell !== ""));
  if (table.length === 0) return { rows: [], errors: ["文件为空"] };

  const header = (table[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const indexes = new Map<keyof DepartmentMappingInput, number>();
  header.forEach((name, index) => {
    const key = HEADER_ALIASES[name];
    if (key) indexes.set(key, index);
  });
  if (!indexes.has("departmentId") && !indexes.has("departmentCode")) {
    return { rows: [], errors: ["缺少 department_id 或 department_code 列"] };
  }

  const rows: DepartmentMappingInput[] = [];
  table.slice(1).forEach((cells, index) => {
    const label = `第 ${index + 2} 行`;
    const row: DepartmentMappingInput = {};
    for (const [key, column] of indexes) {
      const value = cells[column]?.trim();
      if (value) row[key] = value;
    }
    if (!row.departmentId && !row.departmentCode) {
      errors.push(`${label}: 缺少部门`);
      return;
    }
    if (!row.externalId && !row.externalCode && !row.externalOrgCode) {
      errors.push(`${label}: 至少填写一个外部值`);
      return;
    }
    rows.push(row);
  });
  return { rows, errors };
}

/** Parses and imports in one step; parse errors and row errors are merged. */
export function importMappingsFromCsv(
  db: Db,
  datasourceId: string,
  text: string,
): { inserted: number; updated: number; errors: string[] } {
  const parsed = parseMappingCsv(text);
  const result = importDepartmentMappings(db, datasourceId, parsed.rows);
  return { ...result, errors: [...parsed.errors, ...result.errors] };
}
