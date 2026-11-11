# NL2SQL 金标集与回归评分 设计

日期：2026-11-11
状态：待确认

## 1. 目标

建立一套可重复执行的 NL2SQL 回归评测：固定数据、固定问题、真实 Agent 链路、自动对比结果集，用于比较不同模型、提示词、技能和代码改动对查询质量的影响。

验收标准：

1. 仓库内自带 MySQL/PostgreSQL 两份等价 fixture（电商 5 表 + 固定数据），不依赖业务库。
2. 15 条单轮中文问题，每条带两种方言的期望 SQL；覆盖筛选、聚合、分组、join、时间范围、TopN、子查询。
3. 一条命令用真实模型跑完整 Agent（schema 工具 + SQL 工具 + 最终回答），按“最后一个成功执行的 SQL”评分。
4. 评分以结果集为准（列数/行数/值），默认忽略行序，问题要求排序时按序比较；SQL 文本不要求逐字一致。
5. 输出 JSON + Markdown 报告，包含通过率、耗时、token、失败原因、生成 SQL 与期望 SQL；未达阈值时进程退出码为 1。
6. 纯单元测试覆盖结果比较与用例校验；fixture 集成测试可用 `RUN_DB_TESTS=1` 跑通两种方言。

## 2. 非目标

- 不做多轮追问、技能触发、图表、澄清提问的评分（后续版本）。
- 不做 LLM-as-judge，不评价自然语言回答质量。
- 不自动修改提示词去“刷分”；基线用于发现回归。
- 不把评测接入每次 CI（需要模型 API Key，后续可做夜间任务）。

## 3. 目录结构

```text
evals/nl2sql/
  README.md                 # 使用说明、环境变量、如何新增用例
  fixtures/
    mysql.sql               # DROP/CREATE/INSERT，固定数据
    postgres.sql
  cases.json                # 15 条用例（含 mysql/postgres 期望 SQL）
  reports/                  # 运行产物，git 忽略
apps/server/scripts/
  eval-nl2sql.ts            # CLI 入口
apps/server/src/eval/
  cases.ts                  # 用例加载 + zod 校验
  compare.ts                # 结果集规范化与比较
  fixture.ts               # Testcontainers / 现有库连接
  runner.ts                 # Agent 执行与 SQL 提取
  report.ts                 # JSON/Markdown 报告
```

`evals/nl2sql/reports/` 加入 `.gitignore`。

## 4. Fixture

### 4.1 表结构

| 表 | 列 |
|---|---|
| `customers` | `id`, `name`, `city`, `segment`, `created_at` |
| `products` | `id`, `name`, `category`, `price` |
| `orders` | `id`, `customer_id`, `status`, `created_at`, `total_amount` |
| `order_items` | `id`, `order_id`, `product_id`, `quantity`, `unit_price` |

固定数据：11 个客户（1 个无订单）、8 个产品、20 个订单（`completed`/`cancelled`）、约 31 条明细；日期全部落在 2025 年，避免“最近 N 个月”随运行日期漂移。

两份 fixture 数据完全一致，仅建表语法/标识符引用按方言调整；期望 SQL 负责处理 `DATE_FORMAT` vs `to_char`、`IFNULL` vs `COALESCE`、`LIMIT` 等差异。

### 4.2 用例格式

```json
{
  "id": "monthly-orders-2025",
  "question": "统计 2025 年每个月的订单数，按月份升序",
  "mysql": "SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS orders FROM orders WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01' GROUP BY DATE_FORMAT(created_at, '%Y-%m') ORDER BY month",
  "postgres": "SELECT to_char(created_at, 'YYYY-MM') AS month, COUNT(*) AS orders FROM orders WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01' GROUP BY to_char(created_at, 'YYYY-MM') ORDER BY month",
  "ordered": true,
  "tags": ["time", "aggregation"]
}
```

- `ordered: true` 仅用于问题明确要求排序、且期望 SQL 有确定性排序的用例。
- 同一用例两方言的结果列顺序必须一致；列名不参与比较。
- 15 条用例覆盖：计数、城市分组、状态过滤、月度订单、TopN 产品、含零订单客户的左连接、城市客单价、取消率、按产品名反查客户、品类销量、季度品类销售额、高于均值的订单、下单最多客户、客户总消费含零、单月销售额。

## 5. 执行流程

1. 读取环境变量与 CLI 参数，加载并校验 `cases.json`。
2. 启动 fixture：
   - 默认用 Testcontainers 起 `mysql:8.0` / `postgres:16`；
   - 若设置 `EVAL_MYSQL_URL` / `EVAL_PG_URL`，直接连接现有库并执行 fixture（仅限专用评测库）。
3. 建临时应用库（`createDb(":memory:")` + `migrateDb`），插入评测用户、数据源（加密密码）、LLM provider；`syncModelCatalog` 写入模型目录。
4. 对 fixture 做一次 schema introspection 并写入缓存，避免每轮都触发懒刷新。
5. 每条用例：
   - 新建独立会话（避免上下文和标题串扰），模型为 `EVAL_MODEL`（默认 `deepseek-ai/DeepSeek-V3.2`）；
   - `createRun` + 订阅 `RunEventBus` + `runtime.enqueue({content: question})`；
   - 等待 `run_end`，单条超时（默认 120s）后 abort 并判失败；
   - 从 `run_events` 取全部 `sql` 事件，选**最后一个 `status === "ok"`** 的 SQL；
   - 在 fixture 连接上分别执行生成 SQL 与期望 SQL；
   - 规范化结果集并比较。
6. 汇总报告，关闭 runtime、连接、容器和临时目录。

每条用例使用新会话，保证互不影响；同一数据源的 schema 缓存保留，避免重复 introspection。

## 6. 评分口径

### 6.1 结果规范化

- `Date` → ISO 字符串（fixture 期望查询不返回时间列，降低时区影响）。
- `bigint` → number；`Buffer` → base64。
- 数字字符串（含 `DECIMAL` 返回的 `"120.00"`）→ number，保留 6 位小数；布尔 → 0/1。
- `null` 保持 `null`。
- 行按规范化后的 JSON 排序（`ordered: false` 时）；`ordered: true` 保留原始顺序。

### 6.2 通过条件

必须同时满足：

1. 运行状态为 `ok`（非 error/aborted）。
2. 至少有一个成功执行的 `db_query`。
3. 生成 SQL 在 fixture 上执行不报错。
4. 结果列数一致、行数一致、逐行规范化值一致（按 `ordered` 规则）。

不比较：SQL 文本、列别名、额外 `LIMIT`、执行计划、自然语言回答。

### 6.3 失败原因

`run_error`、`timeout`、`no_sql`、`sql_error`、`result_mismatch`；报告中附带生成 SQL、期望 SQL、行列数差异和前 3 行差异。

## 7. CLI

```bash
pnpm eval:nl2sql -- --dialect both --model deepseek-ai/DeepSeek-V3.2
pnpm eval:nl2sql -- --dialect mysql --case monthly-orders-2025 --repeat 3
```

参数：

- `--dialect mysql|postgres|both`（默认 `both`）
- `--model <id>`（默认 `EVAL_MODEL` 或 `deepseek-ai/DeepSeek-V3.2`）
- `--case <id>`（可重复，按 id 过滤）
- `--repeat <n>`（默认 1；报告按用例聚合成 `pass@n` 与逐次明细）
- `--threshold <0..1>`（默认 `0.8`；通过率低于阈值退出 1）
- `--output <dir>`（默认 `evals/nl2sql/reports`）
- `--timeout <seconds>`（单条默认 120）

环境变量：

- `EVAL_API_KEY`（回退 `SILICONFLOW_API_KEY`）
- `EVAL_BASE_URL`（默认 `https://api.siliconflow.cn/v1`）
- `EVAL_PROTOCOL`（默认 `openai-completions`）
- `EVAL_MODEL`
- `EVAL_MYSQL_URL` / `EVAL_PG_URL`（设置后不启容器）

缺少 API Key 或 Docker 时给出明确错误和解决提示，不静默跳过。

## 8. 报告

JSON：运行元数据（模型、方言、时间、参数）、逐用例逐次结果、汇总（通过率、平均耗时、token、失败分布）。
Markdown：汇总表 + 失败用例详情（问题、原因、生成 SQL、期望 SQL、差异摘要），便于贴到 PR/issue。

`--repeat > 1` 时，用例通过定义为至少一次通过，同时报告稳定通过次数。

## 9. 测试

- `apps/server/test/eval-compare.test.ts`：无序/有序、数字字符串、null、列数/行数不一致、重复行。
- `apps/server/test/eval-cases.test.ts`：15 条、id 唯一、两方言 SQL 非空、`ordered` 用例必须有排序。
- `apps/server/test/eval-fixture.integration.test.ts`（`RUN_DB_TESTS=1`）：启动 MySQL/PG、执行 fixture、逐条执行期望 SQL，断言无错误且至少 1 行；不调用模型。
- `pnpm verify` 不包含真实模型评测。

## 10. 风险与取舍

- **模型随机性**：同题可能偶发失败；用 `--repeat` 评估稳定性，基线记录模型与时间。
- **成本**：完整 Agent 每条 10–30s；15 条约 5–8 分钟。先用单方言调试，再跑 both。
- **测试集过拟合**：用例用于回归，不追求把提示词写成只对这些题有效；新增用例优先来自真实失败。
- **方言差异**：期望 SQL 分方言维护；结果比较不含 SQL 文本，容忍写法差异。
- **Docker 依赖**：与现有集成测试一致；无 Docker 时可用 `EVAL_*_URL` 指向专用库。
