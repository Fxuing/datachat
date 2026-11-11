# NL2SQL 金标集

固定电商 fixture（MySQL / PostgreSQL）+ 15 条单轮问题，用真实 Agent 链路生成 SQL，再执行生成 SQL 与金标 SQL，比较结果集的列数、行数与值。默认无序比较；`ordered: true` 的用例按行序比较。

```bash
# 启动两个 Testcontainers（需要 Docker）
pnpm eval:nl2sql -- --dialect both

# 复用已有数据库：会自动 DROP/重建 fixture 的 customers/products/orders/order_items
EVAL_MYSQL_URL='mysql://root:pass@127.0.0.1:3306/nl2sql_eval' \
EVAL_PG_URL='postgresql://user:pass@127.0.0.1:5432/nl2sql_eval' \
pnpm eval:nl2sql -- --dialect both --threshold 0.8
```

常用参数：`--case <id>`（可重复）、`--model <provider::model>`、`--repeat <n>`（默认 1，任一通过即算通过，报告保留逐次明细）、`--threshold`、`--timeout`（秒）、`--output`。

模型通过 `EVAL_API_KEY` 注册为临时 `eval` provider；`EVAL_BASE_URL` 可指向本地网关（如 Magpie），避免外部限流。完整说明与基线见根目录 `README.md` 的“NL2SQL 金标集”。

报告写入 `evals/nl2sql/reports/`（已 gitignore）。**不要把这些报告或数据库连接串提交到仓库。**
