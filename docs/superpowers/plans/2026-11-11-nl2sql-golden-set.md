# NL2SQL 金标集与回归评分 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 用固定 fixture + 15 条单轮问题 + 真实 Agent 链路，自动评分 NL2SQL 结果集并输出可对比报告。

**Architecture:** `evals/nl2sql` 存放 fixture 与用例；`apps/server/src/eval` 提供纯函数（用例加载、结果比较、报告）与 Testcontainers/现有库适配；`apps/server/scripts/eval-nl2sql.ts` 组装临时应用库、LLM provider、RuntimeManager，逐条新建会话运行并抓取 `sql` 事件。

**Tech Stack:** Node 22、TypeScript ESM、Vitest、Testcontainers、mysql2、pg、Pi SDK RuntimeManager、zod。

**Spec:** `docs/superpowers/specs/2026-11-11-nl2sql-golden-set-design.md`

---

### Task 1: 结果比较模块

**Files:**
- Create: `apps/server/src/eval/compare.ts`
- Test: `apps/server/test/eval-compare.test.ts`

- [x] **Step 1: 写失败测试**：无序行序不同应通过；有序应失败；数字字符串 `"120.00"` 与 `120` 等价；`null` 保持；列数/行数不同失败；重复行按多重集比较；第一条差异位置。

```ts
expect(compareResultSets(
  { columns: ["a"], rows: [[2], [1]] },
  { columns: ["x"], rows: [[1], [2]] },
  {},
)).toEqual({ equal: true });
```

- [x] **Step 2: 实现**

```ts
export interface QueryResultSet { columns: string[]; rows: unknown[][] }
export type CompareFailureReason = "column_count" | "row_count" | "value_mismatch";
export type CompareResult =
  | { equal: true }
  | { equal: false; reason: CompareFailureReason; detail: string; expectedSample?: unknown[][]; actualSample?: unknown[][] };

export function normalizeValue(value: unknown): unknown;
export function compareResultSets(
  expected: QueryResultSet,
  actual: QueryResultSet,
  options?: { ordered?: boolean },
): CompareResult;
```

规则：Date→ISO；bigint→number；Buffer→base64；布尔→0/1；数字字符串→number 并保留 6 位小数；行按 JSON 排序后比较（无序）。

- [x] **Step 3: 跑测试** `pnpm vitest run apps/server/test/eval-compare.test.ts`。
- [x] **Step 4: Commit** `feat(eval): compare query result sets`。

### Task 2: 用例加载与 fixture

**Files:**
- Create: `evals/nl2sql/cases.json`
- Create: `evals/nl2sql/fixtures/mysql.sql`
- Create: `evals/nl2sql/fixtures/postgres.sql`
- Create: `apps/server/src/eval/cases.ts`
- Test: `apps/server/test/eval-cases.test.ts`

- [x] **Step 1: 写 fixture**：5 表（customers/products/orders/order_items），11 客户（1 个无订单）、8 产品、20 订单、31 明细；数据完全一致，日期均在 2025 年。
- [x] **Step 2: 写 15 条用例**（id / question / mysql / postgres / ordered / tags）：
  1. `customer-count` 客户总数
  2. `customers-by-city` 各城市客户数降序
  3. `completed-order-total` 已完成订单总金额
  4. `monthly-orders-2025` 2025 每月订单数（ordered）
  5. `top-products-revenue` 销售额最高 3 个产品
  6. `orders-per-customer-including-zero` 每个客户下单次数（含 0，ordered false）
  7. `top-city-average-order` 客单价最高城市
  8. `cancellation-rate` 取消率（4 位小数）
  9. `widget-a-customers` 买过 Widget A 的客户姓名（去重、按姓名排序，ordered）
  10. `units-by-category` 各品类销量降序
  11. `q1-2025-category-revenue` 2025 Q1 各品类销售额
  12. `orders-above-average` 金额高于平均订单金额的订单（金额降序）
  13. `top-customer-orders-2025` 2025 下单次数最多的客户
  14. `customer-total-spend-including-zero` 每个客户总消费（含 0，按金额降序）
  15. `december-2025-revenue` 2025 年 12 月销售额
- [x] **Step 3: 写失败测试**：15 条、id 唯一、两种方言 SQL 非空、`ordered` 用例两种 SQL 都含 `order by`。
- [x] **Step 4: 实现 `loadEvalCases`**：zod 校验；默认路径 `evals/nl2sql/cases.json`；支持 `EVAL_CASES_PATH` 覆盖。
- [x] **Step 5: 跑测试** `pnpm vitest run apps/server/test/eval-cases.test.ts`。
- [x] **Step 6: Commit** `feat(eval): add golden set fixture and cases`。

### Task 3: Fixture 连接与集成测试

**Files:**
- Create: `apps/server/src/eval/fixture.ts`
- Test: `apps/server/test/eval-fixture.integration.test.ts`

- [x] **Step 1: 定义接口**

```ts
export type EvalDialect = "mysql" | "postgres";
export interface FixtureConnection {
  dialect: EvalDialect;
  host: string; port: number; database: string; username: string; password: string;
  query(sql: string): Promise<QueryResultSet>;
  close(): Promise<void>;
}
export async function startFixture(dialect: EvalDialect): Promise<FixtureConnection>;
```

- [x] **Step 2: 实现**：优先 `EVAL_MYSQL_URL` / `EVAL_PG_URL`（URL 解析并执行 fixture）；否则 Testcontainers `mysql:8.0` / `postgres:16-alpine`。MySQL 用 `rowsAsArray: true`，PG 按 `fields` 顺序把对象转数组。
- [x] **Step 3: 集成测试**（`RUN_DB_TESTS=1`）：两方言执行 fixture；逐条执行期望 SQL，断言无错误且至少 1 行；同用例 MySQL 与 PG 结果集相等。
- [x] **Step 4: 跑测试**（需要 Docker）：
  `RUN_DB_TESTS=1 pnpm vitest run apps/server/test/eval-fixture.integration.test.ts`
- [x] **Step 5: Commit** `feat(eval): run golden queries on mysql and postgres fixtures`。

### Task 4: Agent 执行与 SQL 提取

**Files:**
- Create: `apps/server/src/eval/runner.ts`
- Test: `apps/server/test/eval-runner.test.ts`

- [x] **Step 1: 写失败测试**：从 `run_events` 找最后一个 `type=sql && payload.status=ok`；忽略 rejected/error；没有则返回 undefined；超时/abort 返回 `timeout`。
- [x] **Step 2: 实现**

```ts
export interface CaseExecution {
  status: "ok" | "error" | "aborted" | "timeout";
  sql?: string;
  sqlAttempts: { sql: string; status: string }[];
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}
export async function runCase(input: {
  db: Db; manager: RuntimeManager; conversation: ConversationRow;
  userId: string; question: string; timeoutMs: number;
}): Promise<CaseExecution>;
```

流程：`createRun` → 订阅 `manager.bus` 的 `run_end` → `runtime.enqueue` → 超时 abort → 读取 `listRunEventsAfter` → 取最后成功 SQL。超时后等待 abort 落库，再返回 `timeout`。

- [x] **Step 3: 跑测试** `pnpm vitest run apps/server/test/eval-runner.test.ts`。
- [x] **Step 4: Commit** `feat(eval): execute one golden question through the agent runtime`。

### Task 5: CLI、报告与文档

**Files:**
- Create: `apps/server/src/eval/report.ts`
- Create: `apps/server/scripts/eval-nl2sql.ts`
- Modify: `apps/server/package.json`、`package.json`
- Create: `evals/nl2sql/README.md`
- Modify: `.gitignore`

- [x] **Step 1: 实现 CLI**：参数 `--dialect`、`--model`、`--case`（可重复）、`--repeat`、`--threshold`、`--output`、`--timeout`；环境 `EVAL_API_KEY`/`SILICONFLOW_API_KEY`、`EVAL_BASE_URL`、`EVAL_PROTOCOL`、`EVAL_MODEL`、`EVAL_MYSQL_URL`/`EVAL_PG_URL`。
- [x] **Step 2: 初始化临时应用库**：`createDb(":memory:")` + `migrateDb`；插入 admin 用户、fixture 数据源（密码加密）、LLM provider（加密 Key、单模型）；`refreshDatasourceSchema` 预热；创建 `RuntimeManager({sweepIntervalMs:0})`。
- [x] **Step 3: 报告**：JSON 含元数据/逐次结果；Markdown 含汇总、失败详情（问题、原因、生成/期望 SQL、差异样例）；`--repeat` 按用例至少一次通过统计。
- [x] **Step 4: 退出码**：通过率 `< threshold` 或存在失败时 1；输出报告路径。
- [x] **Step 5: 脚本**：root `"eval:nl2sql": "pnpm --filter @datachat/server eval:nl2sql"`，server `"eval:nl2sql": "tsx --env-file-if-exists=../../.env scripts/eval-nl2sql.ts"`。
- [x] **Step 6: README**：前置条件、命令、用例格式、评分口径、成本/耗时、如何加用例；`.gitignore` 加 `evals/nl2sql/reports/`。
- [x] **Step 7: 跑 `pnpm typecheck` 与纯单测**。
- [x] **Step 8: Commit** `feat(eval): add nl2sql evaluation cli and reports`。

### Task 6: 跑基线并修复评测暴露的问题

**Files:**
- 视结果修改：runner/compare/fixture/用例 SQL/提示词。

- [x] **Step 1: MySQL 单方言跑通** `pnpm eval:nl2sql -- --dialect mysql --threshold 0`。
- [x] **Step 2: 修复 harness 问题**（连接、超时、SQL 提取、结果类型差异），不改期望结果来迁就错误答案。
- [x] **Step 3: 若失败集中在提示词，评估后做最小改动**；记录基线（模型、通过率、失败用例）。
- [x] **Step 4: 跑 PostgreSQL**，处理方言差异。
- [x] **Step 5: 保存基线报告到对话/README（不提交 reports 目录）**。
- [x] **Step 6: Commit** `fix(eval): stabilize the nl2sql harness`（如有）。

### Task 7: 全量验证

- [x] **Step 1: `pnpm verify`** 全绿。
- [ ] **Step 2: `RUN_DB_TESTS=1 pnpm vitest run apps/server/test/eval-fixture.integration.test.ts`** 通过（本机 Docker npipe 不可用，未执行；CLI 已用外部 MySQL/PG 实跑）。
- [x] **Step 3: 检查无密钥/报告误提交**；`git status` 干净。
- [x] **Step 4: 提交文档与最终改动并 push。**

---

## 执行记录

- 2026-11-11 完成。实现与计划的小差异：runner 内聚在 `apps/server/src/eval/runner.ts`（不单独建 `runCase` 模块）；临时应用库使用 `mkdtemp` 下的文件 SQLite 而非 `:memory:`；fixture 实际为 4 表 / 42 条明细；`--repeat` 已支持，任一通过即通过并保留逐次明细。
- 基线：`workbuddy-ai/deepseek-v4.1-flash-sg`（Magpie），MySQL 13/15（86.7%）、PostgreSQL 12/15（80.0%）。失败主要是模型多返回辅助列或 Top-N 行数，未修改金标结果迁就。
- 为提升结果列对齐，`agent/prompts/system.md` 增加“最终回答只执行一条查询、只返回问题所需列”的约束。
- Testcontainers 集成测试因本机 Docker npipe 不可用保持 skipped；CLI 使用已有 MySQL/PostgreSQL 实例验证。
