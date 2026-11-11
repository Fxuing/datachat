import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EvalCase {
  id: string;
  question: string;
  mysql: string;
  postgres: string;
  ordered: boolean;
  tags: string[];
}

const defaultCasesPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../evals/nl2sql/cases.json",
);

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`金标用例缺少有效的 ${field}`);
  }
  return value;
}

/**
 * Validate and normalize golden cases. Kept independent from file IO so the
 * runner and tests can feed cases programmatically.
 */
export function parseEvalCases(input: unknown): EvalCase[] {
  if (!Array.isArray(input)) {
    throw new Error("金标用例必须是数组");
  }

  const seen = new Set<string>();
  return input.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`第 ${index + 1} 条金标用例不是对象`);
    }
    const record = raw as Record<string, unknown>;
    const id = requireString(record.id, "id");
    if (seen.has(id)) {
      throw new Error(`金标用例 id 重复：${id}`);
    }
    seen.add(id);

    const ordered = record.ordered === undefined ? false : record.ordered;
    if (typeof ordered !== "boolean") {
      throw new Error(`金标用例 ${id} 的 ordered 必须是布尔值`);
    }

    const tags = record.tags === undefined ? [] : record.tags;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
      throw new Error(`金标用例 ${id} 的 tags 必须是字符串数组`);
    }

    const mysql = requireString(record.mysql, "mysql");
    const postgres = requireString(record.postgres, "postgres");
    if (ordered) {
      for (const [dialect, sql] of [
        ["mysql", mysql],
        ["postgres", postgres],
      ] as const) {
        if (!/\border\s+by\b/i.test(sql)) {
          throw new Error(`金标用例 ${id} 标记了 ordered，但 ${dialect} SQL 缺少 ORDER BY`);
        }
      }
    }

    return {
      id,
      question: requireString(record.question, "question"),
      mysql,
      postgres,
      ordered,
      tags,
    };
  });
}

export function loadEvalCases(path = defaultCasesPath): EvalCase[] {
  return parseEvalCases(JSON.parse(readFileSync(path, "utf8")));
}
