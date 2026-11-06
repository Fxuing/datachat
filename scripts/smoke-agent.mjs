#!/usr/bin/env node
/**
 * Manual smoke test: does each whitelisted SiliconFlow model emit a valid
 * `db_query` tool call? Run with `node scripts/smoke-agent.mjs`.
 *
 * Never prints the API key. Exits 0 with a clear message when no key is set.
 */
import { loadEnv, readModelWhitelist } from "./load-env.mjs";

const TOOL_NAME = "db_query";
const PROMPT = "统计 users 表一共有多少行。必须调用 db_query 工具完成查询，不要直接回答。";
const TIMEOUT_MS = 90_000;

loadEnv();

const apiKey = process.env.SILICONFLOW_API_KEY?.trim();
if (!apiKey) {
  console.log("跳过模型工具调用冒烟：未设置 SILICONFLOW_API_KEY（可在 .env 或环境变量中提供）。");
  process.exit(0);
}

const baseUrl = (process.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn/v1").replace(
  /\/+$/,
  "",
);
const endpoint = `${baseUrl}/chat/completions`;
const models = readModelWhitelist();

const tool = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description: "在只读数据源上执行一条 SQL 查询",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "要执行的只读 SQL" },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  },
};

function describeFailure(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return "响应缺少 choices[0]";
  if (choice.finish_reason !== "tool_calls") {
    return `finish_reason=${choice.finish_reason}（期望 tool_calls）`;
  }
  const call = choice.message?.tool_calls?.[0];
  if (!call) return "finish_reason 为 tool_calls 但没有 tool_calls";
  if (call.function?.name !== TOOL_NAME) {
    return `工具名=${call.function?.name}（期望 ${TOOL_NAME}）`;
  }
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return `工具参数不是合法 JSON: ${String(call.function.arguments).slice(0, 80)}`;
  }
  if (typeof args.sql !== "string" || args.sql.trim() === "") {
    return "工具参数缺少非空 sql 字符串";
  }
  return null;
}

async function smoke(model) {
  const startedAt = Date.now();
  const row = { model, ok: false, finish: "-", tool: "-", sql: "-", ms: 0, error: "" };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是数据助手，需要查询数据时必须调用 db_query 工具。" },
          { role: "user", content: PROMPT },
        ],
        tools: [tool],
        tool_choice: "auto",
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    row.ms = Date.now() - startedAt;
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 200);
      row.error = `HTTP ${response.status}: ${detail}`;
      return row;
    }
    const payload = await response.json();
    const choice = payload?.choices?.[0];
    row.finish = choice?.finish_reason ?? "missing";
    row.tool = choice?.message?.tool_calls?.[0]?.function?.name ?? "-";
    const args = choice?.message?.tool_calls?.[0]?.function?.arguments;
    if (typeof args === "string") row.sql = args.replace(/\s+/g, " ").slice(0, 60);
    const failure = describeFailure(payload);
    row.ok = failure === null;
    if (failure) row.error = failure;
    return row;
  } catch (error) {
    row.ms = Date.now() - startedAt;
    const code = error?.cause?.code ? ` (${error.cause.code})` : "";
    row.error = `${error instanceof Error ? error.message : String(error)}${code}`;
    return row;
  }
}

const rows = [];
for (const model of models) {
  const row = await smoke(model);
  rows.push(row);
  console.log(`${row.ok ? "✓" : "✗"} ${model}${row.ok ? "" : ` — ${row.error}`}`);
}

const ok = rows.filter((row) => row.ok).length;
console.log("");
console.table(
  rows.map((row) => ({
    model: row.model,
    ok: row.ok ? "yes" : "no",
    finish_reason: row.finish,
    tool: row.tool,
    arguments: row.sql,
    ms: row.ms,
  })),
);
console.log(`${ok}/${rows.length} 个模型返回了合法的 ${TOOL_NAME} 工具调用。`);

if (ok !== rows.length) {
  console.error("模型工具调用冒烟失败；在修复前不要向 agent/models.json 增加新模型。");
  process.exit(1);
}
