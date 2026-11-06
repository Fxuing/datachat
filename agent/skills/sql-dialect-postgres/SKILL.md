---
name: sql-dialect-postgres
description: PostgreSQL 方言要点：标识符引用、日期函数、类型转换、分页与 EXPLAIN
---

# PostgreSQL 方言

## 标识符

- 未加引号的标识符会被折叠为小写；大小写混合或含特殊字符时使用双引号：`"Order"`。
- `search_path` 决定未限定表名的解析顺序，跨 schema 查询请写 `schema.table`。
- 字符串用单引号，双引号只用于标识符。

## 常用函数

- 日期：`CURRENT_DATE`、`now()`、`to_char(col, 'YYYY-MM-DD')`、`col - interval '7 days'`。
- 字符串：`a || b`、`concat(a, b)`、`split_part(col, ',', 1)`、`col ILIKE '%x%'`。
- 空值：`COALESCE(a, b)`、`NULLIF(a, b)`；`col IS DISTINCT FROM other` 可安全处理 NULL。
- 条件：`CASE WHEN ... THEN ... ELSE ... END`。

## 分页与限制

- `LIMIT n OFFSET m`；大偏移建议使用 `WHERE id > ? ORDER BY id LIMIT n` 的游标分页。
- `ORDER BY` 需确定唯一排序键，否则分页结果不稳定。

## 类型注意

- `numeric` 精确、`double precision` 近似；金额使用 `numeric`。
- `timestamp` 无时区、`timestamptz` 带时区；比较时显式 `AT TIME ZONE` 并避免隐式转换导致索引失效。
- 显式转换：`col::date`、`CAST(col AS integer)`；避免在索引列上套函数。
- 聚合中的 `FILTER (WHERE ...)` 可替代多次条件聚合。

## EXPLAIN

- `EXPLAIN SELECT ...` 只给计划；`EXPLAIN (ANALYZE, BUFFERS) SELECT ...` 会实际执行并返回真实耗时。
- 关注 `Seq Scan`（大表全扫）、`Nested Loop` 的行数估算偏差、`Sort` 的 `external merge`（落盘）。
