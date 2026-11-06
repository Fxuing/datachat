---
name: sql-dialect-mysql
description: MySQL 方言要点：标识符引用、日期函数、字符串拼接、分页与 EXPLAIN
---

# MySQL 方言

## 标识符

- 表名/列名使用反引号：`` `order` ``（保留字必须引用）。
- 数据库限定的完整名称：`` `数据库名`.`table` ``；跨库查询需确认权限。
- 别名使用 `AS`，避免用保留字当别名。

## 常用函数

- 日期：`CURDATE()`、`NOW()`、`DATE_FORMAT(col, '%Y-%m-%d')`、`DATE_SUB(NOW(), INTERVAL 7 DAY)`。
- 字符串：`CONCAT(a, b)`、`CONCAT_WS('-', a, b)`、`SUBSTRING_INDEX(col, ',', 1)`。
- 空值：`IFNULL(col, 0)`、`NULLIF(a, b)`、`COALESCE(a, b)`。
- 条件：`CASE WHEN ... THEN ... ELSE ... END`；没有 `IF()` 以外的布尔类型，`TRUE`/`FALSE` 即 1/0。

## 分页与限制

- `LIMIT n OFFSET m` 或 `LIMIT m, n`。
- 大偏移量代价高，优先用基于游标的 `WHERE id > ? ORDER BY id LIMIT n`。
- 聚合后排序再 `LIMIT`，避免先截断再聚合。

## 类型注意

- `DECIMAL` 结果保持字符串/定点数语义，不要用浮点直接比较金额。
- `DATETIME` 无时区，`TIMESTAMP` 存 UTC 且受会话时区影响；跨时区比较需显式 `CONVERT_TZ`。
- `GROUP BY` 在 `ONLY_FULL_GROUP_BY` 下要求非聚合列出现在分组中。

## EXPLAIN

- `EXPLAIN SELECT ...` 输出 `type/key/rows/Extra`；关注 `ALL`（全表扫描）、`Using filesort`、`Using temporary`。
- 需要更详细信息时使用 `EXPLAIN FORMAT=JSON`（`db_explain` 会原样返回文本）。
