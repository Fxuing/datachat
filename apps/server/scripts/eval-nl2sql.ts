/**
 * Run the NL2SQL golden set through the real agent runtime.
 *
 * Usage:
 *   pnpm eval:nl2sql -- --dialect both --threshold 0.8
 *   EVAL_API_KEY=... EVAL_MODEL=deepseek-ai/DeepSeek-V3.2 pnpm eval:nl2sql
 *
 * Databases: by default two Testcontainers are started. Set EVAL_MYSQL_URL /
 * EVAL_PG_URL to reuse databases that already contain the fixture.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MySqlContainer } from "@testcontainers/mysql";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool as MysqlPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { migrateDb } from "../src/db/migrate.js";
import { insertUser } from "../src/db/repositories/users.js";
import { insertDatasource } from "../src/db/repositories/datasources.js";
import { saveSchema } from "../src/db/repositories/schema-cache.js";
import { insertLlmProvider } from "../src/db/repositories/llm-providers.js";
import { createConversation } from "../src/db/repositories/conversations.js";
import { createRun, findRun } from "../src/db/repositories/runs.js";
import { listRunEventsAfter } from "../src/db/repositories/run-events.js";
import { deriveSecretKey, encryptSecret } from "../src/agent/datasource/crypto.js";
import { introspectMysql, introspectPostgres } from "../src/agent/datasource/introspect.js";
import { PoolRegistry } from "../src/agent/datasource/pool.js";
import { RuntimeManager } from "../src/agent/runtime.js";
import { hasUsableProvider } from "../src/services/llm-catalog.js";
import { ArtifactStore } from "../src/services/artifacts.js";
import type { Db } from "../src/db/client.js";
import { loadEvalCases } from "../src/eval/cases.js";
import { queryFixture, resetFixture, type Dialect } from "../src/eval/fixture.js";
import { runEvalCases, type EvalAgentOutput, type EvalSummary } from "../src/eval/runner.js";
import { writeEvalReport } from "../src/eval/report.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_REPORT_DIR = path.join(REPO_ROOT, "evals/nl2sql/reports");

interface CliOptions {
  dialects: Dialect[];
  modelId: string;
  caseIds: string[];
  threshold: number;
  timeoutMs: number;
  repeat: number;
  outputDir: string;
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function argValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]!);
  }
  return values;
}

function parseOptions(args: string[]): CliOptions {
  const dialect = argValue(args, "--dialect") ?? "both";
  if (dialect !== "mysql" && dialect !== "postgres" && dialect !== "both") {
    throw new Error(`--dialect 必须是 mysql、postgres 或 both，收到 ${dialect}`);
  }
  const thresholdRaw = Number(argValue(args, "--threshold") ?? 0.8);
  if (!Number.isFinite(thresholdRaw) || thresholdRaw < 0 || thresholdRaw > 1) {
    throw new Error("--threshold 必须在 0 和 1 之间");
  }
  const timeoutRaw = Number(argValue(args, "--timeout") ?? 120);
  if (!Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
    throw new Error("--timeout 必须是正数（秒）");
  }
  const repeatRaw = Number(argValue(args, "--repeat") ?? 1);
  if (!Number.isInteger(repeatRaw) || repeatRaw < 1) {
    throw new Error("--repeat 必须是大于 0 的整数");
  }
  return {
    dialects: dialect === "both" ? ["mysql", "postgres"] : [dialect],
    modelId: argValue(args, "--model") ?? process.env.EVAL_MODEL ?? "siliconflow::deepseek-ai/DeepSeek-V3.2",
    caseIds: argValues(args, "--case"),
    threshold: thresholdRaw,
    timeoutMs: timeoutRaw * 1000,
    repeat: repeatRaw,
    outputDir: path.resolve(argValue(args, "--output") ?? DEFAULT_REPORT_DIR),
  };
}

interface FixtureTarget {
  dialect: Dialect;
  pool: MysqlPool | PgPool;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  stop?: () => Promise<unknown>;
}

function parseDatabaseUrl(dialect: Dialect, raw: string): FixtureTarget {
  const url = new URL(raw);
  return {
    dialect,
    pool:
      dialect === "mysql"
        ? createPool(raw)
        : new PgPool({ connectionString: raw }),
    host: url.hostname,
    port: Number(url.port || (dialect === "mysql" ? 3306 : 5432)),
    database: url.pathname.replace(/^\//, ""),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

async function startFixture(dialect: Dialect): Promise<FixtureTarget> {
  const configured = dialect === "mysql" ? process.env.EVAL_MYSQL_URL : process.env.EVAL_PG_URL;
  if (configured) return parseDatabaseUrl(dialect, configured);

  if (dialect === "mysql") {
    const container = await new MySqlContainer("mysql:8.0").start();
    return {
      dialect,
      pool: createPool({
        host: container.getHost(),
        port: container.getPort(),
        database: container.getDatabase(),
        user: container.getUsername(),
        password: container.getUserPassword(),
      }),
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      username: container.getUsername(),
      password: container.getUserPassword(),
      stop: () => container.stop(),
    };
  }

  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  return {
    dialect,
    pool: new PgPool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
    }),
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    username: container.getUsername(),
    password: container.getPassword(),
    stop: () => container.stop(),
  };
}

function createEvalConfig(dataDir: string): AppConfig {
  return loadConfig({
    ...process.env,
    DATA_DIR: dataDir,
    APP_SECRET: "eval-secret-0123456789abcdef0123456789abcdef",
  });
}

function setupProvider(db: Db, config: AppConfig, modelId: string): string {
  const evalKey = process.env.EVAL_API_KEY;
  if (!evalKey) return modelId;

  const bare = modelId.includes("::") ? modelId.split("::")[1]! : modelId;
  insertLlmProvider(db, {
    id: "eval",
    name: "Eval",
    protocol: "openai-completions",
    baseUrl: (process.env.EVAL_BASE_URL ?? config.siliconflowBaseUrl).replace(/\/+$/, ""),
    apiKeyCipher: encryptSecret(evalKey, deriveSecretKey(config.appSecret)),
    models: [{ id: bare, name: bare, contextWindow: 128_000, maxTokens: 8_192 }],
    enabled: true,
    now: Date.now(),
  });
  return `eval::${bare}`;
}

function createDatasource(
  db: Db,
  config: AppConfig,
  userId: string,
  target: FixtureTarget,
  snapshot: Awaited<ReturnType<typeof introspectMysql>>,
): string {
  const id = randomUUID();
  const now = Date.now();
  insertDatasource(db, {
    id,
    name: `nl2sql-${target.dialect}`,
    type: target.dialect,
    host: target.host,
    port: target.port,
    database: target.database,
    username: target.username,
    passwordCipher: encryptSecret(target.password, deriveSecretKey(config.appSecret)),
    sslMode: "disable",
    readOnlyVerified: 1,
    allowWriteAccount: 0,
    status: "ok",
    lastCheckedAt: now,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  saveSchema(db, id, snapshot);
  return id;
}

function sqlsFromEvents(db: Db, runId: string): string[] {
  const events = listRunEventsAfter(db, runId, 0);
  const sqls: string[] = [];
  for (const event of events) {
    if (event.type !== "sql") continue;
    try {
      const payload = JSON.parse(event.payloadJson) as { sql?: unknown; status?: unknown };
      if (payload.status === "ok" && typeof payload.sql === "string") sqls.push(payload.sql);
    } catch {
      // Ignore malformed rows; the run status still reports the failure.
    }
  }
  return sqls;
}

function createAgentRunner(input: {
  db: Db;
  manager: RuntimeManager;
  userId: string;
  datasourceId: string;
  modelId: string;
  timeoutMs: number;
}) {
  const { db, manager, userId, datasourceId, modelId, timeoutMs } = input;

  return async (item: { id: string; question: string }): Promise<EvalAgentOutput> => {
    const started = Date.now();
    const conversation = createConversation(db, {
      userId,
      datasourceId,
      title: `eval:${item.id}`,
      modelId,
    });
    const runtime = await manager.getOrCreate(conversation, userId);
    const run = createRun(db, {
      conversationId: conversation.id,
      userId,
      modelId,
    });

    let settle: (payload: { status: string; error?: string }) => void = () => undefined;
    const ended = new Promise<{ status: string; error?: string }>((resolve) => {
      settle = resolve;
    });
    const unsubscribe = manager.bus.subscribe(conversation.id, (live) => {
      if (live.runId !== run.id || live.event.type !== "run_end") return;
      settle(live.event.payload as { status: string; error?: string });
    });
    const timer = setTimeout(() => {
      manager.abort(conversation.id, run.id);
      settle({ status: "error", error: `评测超时（${timeoutMs / 1000}s）` });
    }, timeoutMs);

    try {
      runtime.enqueue({
        runId: run.id,
        content: item.question,
        displayContent: item.question,
      });
      const end = await ended;
      const row = findRun(db, run.id);
      const sqls = end.status === "ok" ? sqlsFromEvents(db, run.id) : [];
      if (process.env.EVAL_DEBUG && sqls.length > 1) {
        console.log(`    debug ${item.id}: ${sqls.length} 条 SQL`);
        sqls.forEach((sql, index) => console.log(`      #${index + 1} ${sql.replace(/\s+/g, " ")}`));
      }
      return {
        ...(end.status === "ok" ? { sql: sqls.at(-1) } : {}),
        ...(end.status === "ok" ? {} : { error: end.error ?? `运行状态：${end.status}` }),
        durationMs: Date.now() - started,
        usage: {
          inputTokens: row?.inputTokens ?? undefined,
          outputTokens: row?.outputTokens ?? undefined,
        },
      };
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  };
}

async function evaluateDialect(
  db: Db,
  config: AppConfig,
  userId: string,
  options: CliOptions,
  target: FixtureTarget,
): Promise<EvalSummary> {
  await resetFixture({ dialect: target.dialect, pool: target.pool });
  const snapshot =
    target.dialect === "mysql"
      ? await introspectMysql(target.pool as MysqlPool, target.database)
      : await introspectPostgres(target.pool as PgPool);
  const datasourceId = createDatasource(db, config, userId, target, snapshot);

  const artifacts = new ArtifactStore(db, path.join(config.dataDir, `artifacts-${target.dialect}`));
  await artifacts.init();
  const pools = new PoolRegistry();
  const manager = new RuntimeManager({ db, config, pools, artifacts, maxRuntimes: 4 });

  try {
    const cases = loadEvalCases().filter(
      (item) => options.caseIds.length === 0 || options.caseIds.includes(item.id),
    );
    if (cases.length === 0) throw new Error("没有匹配的金标用例");

    return await runEvalCases({
      dialect: target.dialect,
      cases,
      runAgent: createAgentRunner({
        db,
        manager,
        userId,
        datasourceId,
        modelId: options.modelId,
        timeoutMs: options.timeoutMs,
      }),
      executeSql: (sql, dialect) => queryFixture({ dialect, pool: target.pool }, sql),
      repeat: options.repeat,
      onProgress: (result, index, total) => {
        const mark = result.passed ? "✓" : "✗";
        const suffix = result.passed ? "" : ` (${result.reason}: ${result.error ?? result.generatedSql ?? "结果不一致"})`;
        const seconds = (result.durationMs / 1000).toFixed(1);
        console.log(`  [${index + 1}/${total}] ${mark} ${result.id} ${seconds}s${suffix}`);
      },
    });
  } finally {
    await manager.shutdown();
    await pools.closeAll();
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const dataDir = await mkdtemp(path.join(tmpdir(), "dc-eval-"));
  const config = createEvalConfig(dataDir);
  const handle = createDb(config.dbPath);
  migrateDb(handle.db);
  const userId = randomUUID();
  insertUser(handle.db, {
    id: userId,
    username: "eval",
    passwordHash: "not-used",
    role: "admin",
    createdAt: Date.now(),
  });
  options.modelId = setupProvider(handle.db, config, options.modelId);
  if (!hasUsableProvider(handle.db, config)) {
    throw new Error(
      "没有可用的模型密钥：请设置 EVAL_API_KEY，或在 .env 中配置 SILICONFLOW_API_KEY",
    );
  }

  const targets: FixtureTarget[] = [];
  const summaries: EvalSummary[] = [];
  let exitCode = 0;
  try {
    for (const dialect of options.dialects) {
      const startedAt = Date.now();
      console.log(`\n${dialect}: 启动 fixture…`);
      const target = await startFixture(dialect);
      targets.push(target);
      const summary = await evaluateDialect(handle.db, config, userId, options, target);
      summaries.push(summary);

      const paths = await writeEvalReport(
        {
          meta: {
            modelId: options.modelId,
            threshold: options.threshold,
            startedAt,
            finishedAt: Date.now(),
            note: `${summary.total} 个用例 × ${options.repeat} 次，超时 ${options.timeoutMs / 1000}s`,
          },
          summary,
        },
        options.outputDir,
      );
      console.log(
        `${dialect}: ${summary.passed}/${summary.total} 通过（${(summary.passRate * 100).toFixed(1)}%）`,
      );
      console.log(`  报告：${paths.markdownPath}`);
      if (summary.passRate < options.threshold) exitCode = 1;
    }
  } finally {
    for (const target of targets) {
      await target.pool.end?.();
      await target.stop?.();
    }
    handle.sqlite.close();
    await rm(dataDir, { recursive: true, force: true });
  }

  if (exitCode !== 0) {
    console.error(`\n通过率低于阈值 ${(options.threshold * 100).toFixed(1)}%`);
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
