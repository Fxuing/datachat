# 部门与行级数据权限设计

- 日期：2026-11-17
- 状态：已实现（2026-11-18）。实现差异：迁移为 `0014_departments_scope.sql`（0013 已被用户记忆占用）；`app_id`/`app_code` 直接取本系统部门 id/code；过滤值使用绑定参数而非 SQL 字面量；`nullVisible` 当前只生成 `IS NULL`。当前行为以 [`docs/subsystems/data-scope.md`](../../subsystems/data-scope.md) 为准。
- 范围：部门组织、部门-数据源授权、表级数据范围分类、行级过滤、范围快照与存量数据迁移
- 关联：[`2026-11-13-rbac-roles-design.md`](./2026-11-13-rbac-roles-design.md)、[`../roadmap.md`](../roadmap.md)
- 后续：实施计划见 [`../plans/2026-11-17-department-data-scope.md`](../plans/2026-11-17-department-data-scope.md)

## 1. 背景

当前权限模型解决的是“能不能访问某个数据源”：

- RBAC 角色控制功能权限与角色级数据源授权；
- `datasource_grants` 提供用户级直授；
- 普通用户只要拿到某个数据源，就能查询该数据源中的全部表和全部行。

这不能满足“同一张订单表，北京分公司只能看北京、上海分公司只能看上海、集团管理员能看全部”的需求。

业务表通常已经带有部门字段，但不同系统写法不同：

- 部门编码，例如 `dept_code = '1101'`；
- 业务系统部门表主键，例如 `department_id = 38`；
- 机构编码，例如 `org_code = '110100'`；
- 经业务部门表关联后才知道属于哪个部门。

为每个部门建数据库视图不可行：部门数量多、层级深、数据源多，视图会快速膨胀，权限变更也要改数据库对象。

因此第一版采用：

> **功能权限继续由 RBAC 管理；数据边界由部门管理；在 SQL 执行前按表策略做 AST 级行过滤。**

## 2. 目标与非目标

### 2.1 目标

- 管理员维护部门树，支持手工增删改与批量导入。
- 一个用户可属于多个部门，数据范围取并集。
- 父部门默认可以看到所有下级部门的数据。
- 部门可被授予数据源；与用户直授、角色授权取并集。
- 每张表可配置为 `scoped`、`public`、`denied` 三种数据范围策略之一。
- `scoped` 表在 SQL 执行前自动追加部门过滤，不依赖模型提示词。
- 支持部门字段为空的数据按表选择“可见/不可见”，默认可见。
- 受控数据源禁止公开分享；存量结果标记 legacy，要求重新生成。
- 管理端提供设置向导、覆盖检查、权限诊断和最近被拒查询，避免“不知道为什么查不到”。
- 查询失败返回结构化原因，用户能看懂、管理员能定位。

### 2.2 非目标（第一版不做）

- **不做“部门 × 表”的 allowlist**。表只做 `scoped/public/denied` 分类，不表达“A 部门能看订单表、B 部门不能看”。
- 不做列级权限。
- 不把角色挂到部门；角色只负责功能权限。
- 不在查询时递归访问业务系统的部门表；部门关系使用导入后的映射。
- 不自动同步 HR/AD/IdP；第一版手工维护 + 导入。
- 不使用数据库视图或 RLS 实现；由应用层 AST 改写 + 参数化过滤。
- 不做跨数据源统一身份、临时授权、审批流。
- 不做历史结果回溯重算；旧结果直接 legacy，重新生成。

## 3. 术语

| 术语 | 含义 |
| --- | --- |
| 系统部门 | DataChat 内维护的部门树节点，有 `id`、`code`、父节点 |
| 业务部门值 | 业务表部门字段中实际存储的值，可能是 id、code、org_code |
| 受控数据源 | 开启行级数据权限的数据源；关闭时行为与现在一致 |
| 表策略 | 某张表在某个数据源下的分类：`scoped` / `public` / `denied` |
| 部门映射 | 系统部门到业务部门值（id/code/org_code）的对应关系 |
| 有效部门集 | 用户所属部门 + 这些部门的所有下级部门，多部门取并集 |
| 范围快照 | 一次 run 创建时冻结的部门范围，用于历史结果鉴权 |
| legacy 结果 | 受控开启前生成、没有范围快照的 artifact/report/结果预览 |

## 4. 权限模型

### 4.1 两层模型

```
功能权限（RBAC）  →  能不能用聊天/技能/报告/分享/导出/管理功能
数据边界（部门）  →  能看哪些数据源、哪些表、哪些行
```

一个用户最终能查什么，由三件事共同决定：

```
数据源访问 ∧ 表策略 ∧ 行范围
```

### 4.2 数据源访问

有效数据源访问取并集：

```
用户直授 datasource_grants
∪ 角色授权 role_datasource_grants
∪ 部门授权 department_datasource_grants（授予部门及其下级）
```

- 管理员绕过所有数据源与行级限制。
- 部门授权向下继承：授予“华东大区”，华东大区及其所有下级部门的用户都获得该数据源。
- 下级部门的授权不会反向授予上级部门。
- 用户没有任何部门时：
  - 仍可通过直授/角色获得数据源；
  - 只能看该数据源中的 `public` 表；
  - 所有 `scoped` 表返回 `DATA_SCOPE_NO_DEPARTMENT`。

### 4.3 部门范围

- 用户可属于多个部门；有效部门集是每个部门子树的并集。
- 父部门天然包含所有下级部门。
- 用户被移动部门后，新查询立即使用新范围；历史结果按快照鉴权。
- 管理员默认全范围。

## 5. 部门模型

### 5.1 `departments`

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `name` | 部门名称 |
| `code` | 系统内唯一编码；`app_code` 模式直接使用 |
| `parent_id` | 父部门，根为 null |
| `sort_order` | 同级排序 |
| `status` | `active` / `archived` |
| `created_at` / `updated_at` | 时间 |

约束：

- `code` 全局唯一。
- 不能把部门移动到自己的子树下，禁止环。
- 有子部门、用户、授权或映射时不能删除；先移动/清理。
- 归档前必须先转移该部门的用户、子部门、授权与映射；第一版不允许归档仍有引用的部门，避免用户静默失去范围。
- 删除只允许空节点；历史审计保留名称快照。

### 5.2 `department_closure`

| 字段 | 说明 |
| --- | --- |
| `ancestor_id` | 祖先 |
| `descendant_id` | 后代 |
| `depth` | 距离，自身为 0 |

用于 O(1) 取子树和判断祖先关系。移动部门时在同一事务内重建受影响子树。

### 5.3 `user_departments`

| 字段 | 说明 |
| --- | --- |
| `user_id` | 用户 |
| `department_id` | 部门 |
| `is_primary` | 是否主部门，仅用于展示 |
| `created_at` | 时间 |

主键 `(user_id, department_id)`。一个用户至少一个部门才能使用 `scoped` 表。

### 5.4 `department_datasource_grants`

| 字段 | 说明 |
| --- | --- |
| `department_id` | 部门 |
| `datasource_id` | 数据源 |
| `created_at` | 时间 |

主键 `(department_id, datasource_id)`。授权向下继承；与直授/角色授权并集。

## 6. 表策略

### 6.1 `data_scope_policies`

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `datasource_id` | 数据源 |
| `table_name` | 表/视图名，按数据源规范化（大小写、schema） |
| `mode` | `scoped` / `public` / `denied` |
| `column_name` | `scoped` 时的部门字段 |
| `value_mode` | `app_id` / `app_code` / `external_id` / `external_code` / `external_org_code` |
| `null_visible` | 部门字段为空时是否可见，默认 true |
| `created_at` / `updated_at` | 时间 |

唯一约束 `(datasource_id, table_name)`。

### 6.2 三种模式

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `scoped` | 按部门字段过滤；必须配置列与值模式 | 业务事实表、带部门列的分析表 |
| `public` | 不过滤，所有拥有数据源访问的人可见 | 字典、公共维表、无部门属性的参考表 |
| `denied` | 非管理员不可查询；普通用户的 `db_schema` 不返回 | 敏感表、系统表、未确认的新表 |

注意：`public` 不是“互联网公开”，而是“该数据源的所有授权用户可见”。

### 6.3 默认与覆盖

- 数据源开启受控前，必须把所有现有表分类完毕；未分类表数量必须为 0。
- 开启受控后，新建表/新视图默认 `denied`，管理员需主动分类。
- Schema 刷新发现新表时，数据源页和运维页显示“待分类 N 张”。
- 表被重命名视为新表（默认 denied）；旧策略标记失效。
- `scoped` 列不存在、表不存在时，策略标记 `stale`，查询该表返回 `DATA_SCOPE_POLICY_STALE`，不静默放行。
- 管理员可以查询 `denied` 表用于排障，但必须写审计。

### 6.4 自动识别候选

开启向导从 schema 缓存扫描以下列名（大小写不敏感）：

```
dept_id, department_id, dept_code, department_code,
org_id, org_code, organization_id, organization_code,
bmbm, bmid, bm_code
```

- 命中列的表预填 `scoped`，默认选中该列。
- 未命中的表预填 `public` 或 `denied`，由管理员批量决定。
- 自动识别只是建议，必须人工确认；不根据列名自动启用。

## 7. 部门映射

### 7.1 `department_org_map`

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `datasource_id` | 数据源 |
| `department_id` | 系统部门 |
| `external_id` | 业务部门表主键（可选） |
| `external_code` | 业务部门编码（可选） |
| `external_org_code` | 机构编码（可选） |
| `source` | `manual` / `import` |
| `created_at` | 时间 |

唯一约束 `(datasource_id, department_id)`；至少一个 external 字段非空。

### 7.2 什么时候需要映射

| `value_mode` | 过滤值来源 | 是否需要映射 |
| --- | --- | --- |
| `app_id` | `departments.id` | 否 |
| `app_code` | `departments.code` | 否 |
| `external_id` | 映射行的 `external_id` | 是 |
| `external_code` | 映射行的 `external_code` | 是 |
| `external_org_code` | 映射行的 `external_org_code` | 是 |

如果业务表字段就是系统部门编码，优先用 `app_code`，不需要维护映射。

### 7.3 导入与校验

支持 CSV / JSON 导入，至少包含：

```csv
department_code,external_id,external_code,external_org_code
1101,38,D1101,110100
```

校验：

- `department_code` 必须存在；
- 同一数据源、同一 external 值不能映射到多个系统部门；
- 一个部门只能有一行映射（第一版不支持多别名）；
- 空 external 字段允许，但不能全空；
- 未映射的有效部门在向导中单列，不计为通过。

### 7.4 未映射的运行时行为

- `scoped` 表查询时，如果有效部门集中任一部门缺所需映射，**整条查询失败**：`DATA_SCOPE_MAPPING_MISSING`。
- 不做“跳过未映射部门继续查”，避免用户看到不完整数据却不知道。
- 管理员诊断页展示该用户缺哪些映射，以及需要补的 external 字段。

## 8. SQL 执行与行级过滤

### 8.1 执行链路

```
Agent 生成 SQL
  → sqlGuard（单条只读、危险语法、LIMIT）
  → AST 解析
  → 表引用遍历（含 join / 子查询 / CTE / union）
  → 逐表策略检查
  → scoped 表包成过滤子查询
  → 重新序列化
  → 参数化执行
```

### 8.2 改写方式

对 `scoped` 表的每个物理表引用，将其替换为派生表：

```sql
-- 原始
SELECT o.id, o.amount
FROM orders o
WHERE o.status = 'paid';

-- 改写后
SELECT o.id, o.amount
FROM (
  SELECT *
  FROM orders
  WHERE dept_code IN (?, ?, ?)
     OR dept_code IS NULL          -- null_visible = true 时
) o
WHERE o.status = 'paid';
```

要求：

- 保留原别名；没有别名时生成稳定别名。
- 支持 `schema.table` / `database.table`，内层使用完整表名。
- CTE 名称不是物理表，不包装。
- 覆盖 `JOIN`、子查询、`EXISTS`、`UNION`、`INTERSECT`、`EXCEPT`。
- `SELECT *` 派生表可能产生重复列名；实现阶段在 AST 层显式列出列，或验证列名唯一后回退。
- 只处理 `SELECT`/`WITH`；其他语句已被 sqlGuard 拒绝。

### 8.3 过滤值

- `app_id`：有效部门 UUID。
- `app_code`：有效部门 code。
- `external_*`：映射表值。
- 多部门取并集。
- `null_visible=true` 时增加 `column IS NULL OR column = ''`；`false` 时增加 `column IS NOT NULL AND column <> ''`。
- 空部门集：`scoped` 表直接返回 `DATA_SCOPE_NO_DEPARTMENT`，不生成 `IN ()`。
- 参数化 `IN`；部门数量很大时使用方言能力优化（MySQL `JSON_TABLE` / PostgreSQL `= ANY(array)`），实现阶段按实测选择。
- 所有值来自数据库，禁止字符串拼接；查询审计记录策略版本和范围快照。

### 8.4 查询工具的一致性

- `db_schema`：普通用户只返回 `public` + `scoped` 表，不返回 `denied`；管理员排障时可看到全部表。`scoped` 表可标注“已按部门过滤”，但不暴露具体过滤值。
- `db_query`：走同一改写链路。
- `db_explain`：同样改写，避免通过执行计划推断未授权数据。
- `make_chart` / `create_report`：只消费已过滤后的结果，不直接访问数据库。
- 定时任务：每次执行重新计算范围，不继承创建时的范围。

### 8.5 失败关闭

以下情况一律拒绝，不放行：

- 表没有策略；
- 策略为 `denied`；
- `scoped` 但列不存在 / 表不存在；
- 有效部门缺映射；
- 用户没有部门；
- AST 无法解析或包含无法识别的表引用；
- 改写后列名冲突无法安全处理。

## 9. 范围快照与历史数据

### 9.1 `runs.scope_snapshot`

每次创建 run 时写入 JSON：

```json
{
  "version": 1,
  "datasourceId": "…",
  "departmentIds": ["…"],
  "policyHash": "…"
}
```

- 非受控数据源写 `null`。
- 管理员/无部门用户也写快照，便于审计。
- `policyHash` 标识当时的策略版本；策略变更不重算历史结果，但读取时仍按快照部门鉴权。

### 9.2 读取历史结果

artifact / report / run 结果预览读取时：

1. 管理员直接放行。
2. 数据源当前未受控：沿用旧逻辑（owner/admin）。
3. 快照存在：要求快照部门集 ⊆ 当前有效部门集；否则拒绝。
4. 快照缺失且数据源已受控：视为 legacy。

### 9.3 legacy 处理

开启受控时：

- 撤销该数据源下所有未过期分享（`shares.revoked_at`）。
- 受控期间禁止创建公开分享（`SHARE_DISABLED_BY_SCOPE`）。
- 旧 run 的 artifact、report、run_events 结果预览标记 legacy；非管理员不可查看。
- 对话文本和 SQL 可以保留；页面提示“该结果生成于权限启用前，请重新生成”。
- 定时任务下一次执行使用新范围；旧报告 legacy。

### 9.4 分享

- 受控数据源不允许公开分享；已有分享立即撤销。
- 报告若引用了 legacy artifact，整份报告按 legacy 处理。
- 撤销后访问返回 410，不泄露报告内容。

## 10. 管理端体验

### 10.1 组织管理

新增“组织与部门”页面：

- 部门树：新增、重命名、移动、归档、删除；
- 部门详情：用户列表、数据源授权、映射状态；
- 用户分配：一个用户可多部门，指定主部门；
- 批量导入部门（CSV/JSON）；
- 审计：部门变更、用户部门变更、授权变更。

### 10.2 数据源受控向导

数据源详情增加“数据权限”Tab，状态：

```
未开启 → 配置中 → 已开启
```

向导步骤：

1. **部门检查**：至少一个部门；提示未分配部门的用户。
2. **映射导入**：按需选择 external 模式；展示未映射部门。
3. **表分类**：自动识别候选列；批量设为 scoped/public/denied；逐表配置列、值模式、null 可见。
4. **覆盖检查**：未分类必须为 0；scoped 列必须存在；映射必须覆盖所有将受影响的部门（或明确接受这些用户会报错）。
5. **预览**：选择部门，抽样查看生成的过滤 SQL 和行数；不执行全表扫描。
6. **确认开启**：二次确认“将撤销公开分享、旧结果需重新生成”。

开启后：

- 新表默认 denied；
- 数据源页显示待分类表；
- 策略变更立即生效，写审计；
- 关闭受控需管理员确认，关闭后恢复旧行为（但已撤销分享不恢复）。

### 10.3 权限诊断

管理员输入“用户 + 数据源 + 表名”，展示：

- 用户所属部门、展开后的子树；
- 从直授/角色/部门获得的数据源权限来源；
- 该表的策略与命中列；
- 映射后的过滤值；
- 最终 SQL 过滤条件；
- 预计可见行数（抽样/COUNT，限制超时）；
- 最近拒绝记录：用户、表、错误码、时间、requestId。

### 10.4 被拒查询列表

- 记录 `DATA_SCOPE_*` 拒绝事件到审计/独立表；
- 按表聚合“最常被拒的表”，帮助管理员发现漏配；
- 可按用户/数据源/错误码筛选。

## 11. 用户侧体验

### 11.1 结构化错误

| 错误码 | 用户提示 |
| --- | --- |
| `DATA_SCOPE_NO_DEPARTMENT` | 你的账号还没有分配部门，暂时无法查看该数据。请联系管理员。 |
| `DATA_SCOPE_MAPPING_MISSING` | 你所在部门尚未映射到该数据源，请联系管理员补充部门映射。 |
| `DATA_SCOPE_TABLE_NOT_CONFIGURED` | 表 `xxx` 尚未配置数据权限，管理员处理前无法查询。 |
| `DATA_SCOPE_DENIED_TABLE` | 该表不允许通过问答查询。 |
| `DATA_SCOPE_POLICY_STALE` | 表 `xxx` 的部门字段已变化，数据权限配置需要更新。 |
| `SHARE_DISABLED_BY_SCOPE` | 该数据源已启用行级权限，暂不支持公开分享。 |

错误卡片包含：

- 原因（人类可读）；
- 表名（如果有）；
- requestId；
- 管理员入口（仅管理员可见）；
- “复制诊断信息”按钮。

### 11.2 空结果不是错误

查询成功但当前部门范围内无数据时，显示：

> 查询成功，但你当前的数据范围内没有匹配记录。

不要显示“查询失败”或让模型继续重试。

### 11.3 范围提示

- 会话顶栏显示数据源徽标；受控数据源追加“数据范围：XX部及下级”Tooltip。
- 普通用户不显示具体过滤值/SQL 细节。
- 无部门用户进入受控数据源时，空态直接提示并禁用发送，避免先问再报错。

## 12. 数据模型与迁移

### 12.1 新增表

```text
departments
department_closure
user_departments
department_datasource_grants
department_org_map
data_scope_policies
```

### 12.2 修改表

```text
datasources.data_scope_mode   text not null default 'off'  -- off | configuring | enabled
runs.scope_snapshot           text null
query_audit.scope_reason      text null                     -- 可选，拒绝原因
```

### 12.3 迁移顺序

1. 建部门/闭包/用户部门/部门授权表；
2. 建映射与策略表；
3. 数据源加 `data_scope_mode`，默认 off；
4. run 加 `scope_snapshot`；
5. 审计 action 增加 `department_change`、`data_scope_change`、`data_scope_enable`。

不做自动部门初始化；管理员首次进入组织页时创建根部门或导入。

## 13. API 草案

### 13.1 组织

```
GET    /api/admin/departments
POST   /api/admin/departments
PATCH  /api/admin/departments/:id
DELETE /api/admin/departments/:id
POST   /api/admin/departments/import
PUT    /api/admin/users/:id/departments
GET    /api/admin/departments/:id/grants
PUT    /api/admin/departments/:id/grants
```

### 13.2 数据范围

```
GET  /api/admin/datasources/:id/scope
PUT  /api/admin/datasources/:id/scope/policies
POST /api/admin/datasources/:id/scope/import-map
GET  /api/admin/datasources/:id/scope/coverage
POST /api/admin/datasources/:id/scope/preview
POST /api/admin/datasources/:id/scope/enable
POST /api/admin/datasources/:id/scope/disable
```

### 13.3 诊断

```
GET /api/admin/scope/diagnostics?userId=&datasourceId=&table=
GET /api/admin/scope/denials?datasourceId=&userId=
```

所有管理接口使用 `admin.datasources` 或新增的 `admin.departments` 权限：

- `admin.departments`：部门树、用户部门分配、部门数据源授权、映射导入；
- 数据范围策略、覆盖检查、开启/关闭受控归入 `admin.datasources`。

`admin.departments` 是新的系统权限，加入 RBAC 的 14 项权限矩阵后共 15 项；系统权限仍仅内置 admin 可用，不授予自定义角色。

## 14. 前端页面

- `/admin/departments`：部门树、用户分配、部门数据源授权、导入。
- `/admin/datasources/:id?tab=scope`：受控向导、表分类、映射、覆盖检查、预览。
- `/admin/scope/diagnostics`：权限诊断 + 被拒查询。
- 会话页：范围徽标、结构化错误卡片、空结果提示。
- 数据源页：受控状态、待分类表数量。

## 15. 安全与性能

- 所有过滤在服务端执行；提示词只解释，不作为安全边界。
- 过滤值全部参数化；不接受模型生成的部门 ID。
- `db_explain` 与 `db_query` 使用同一改写。
- 任何异常默认拒绝；不允许“策略缺失时放行”。
- 管理员操作全部审计；拒绝查询记录原因。
- 闭包表 + 索引：`user_departments(user_id)`、`department_closure(ancestor_id)`、`data_scope_policies(datasource_id, table_name)`、`department_org_map(datasource_id, department_id)`。
- 单次请求缓存部门子树、映射、策略；不在每条 SQL 重查。
- 部门数量上限建议 5,000；单用户部门数建议 ≤ 20。
- 预览查询带超时与行数上限，避免 COUNT 全表。

## 16. 测试与验收

### 16.1 单元/集成

- 部门树：移动子树、闭包重建、禁止环、删除约束。
- 访问解析：直授/角色/部门并集；父部门授权向下；多部门并集；无部门。
- 映射：唯一性、未映射报错、导入校验。
- 策略：public 不过滤、denied 拒绝、scoped 过滤、null 可见/不可见。
- SQL 改写：简单查询、join、别名、子查询、CTE、union、schema 限定、重复列名、`db_explain`。
- 范围快照：子集校验、部门移除、legacy 拒绝、管理员绕过。
- 分享：受控创建 403、已有分享撤销、410。
- 定时任务/报告/导出：使用 run 快照或重新计算。

### 16.2 验收场景

1. 父部门用户能看子部门数据，子部门用户看不到父部门数据。
2. 用户属于两个部门时看到两边并集。
3. 部门字段为 NULL 的行默认可见；关闭后不可见。
4. 未分类表在新受控数据源中默认拒绝，并返回可定位错误。
5. `public` 表所有授权用户可见；`denied` 表非管理员不可见。
6. 业务值使用 external_code 时，映射后正确过滤。
7. 用户无部门时 public 可查、scoped 返回明确错误。
8. 开启受控后旧报告不可被非管理员查看，分享失效。
9. 管理端覆盖检查不通过时无法开启。
10. 诊断页能解释“为什么这个用户查不到这张表”。

## 17. 实施分期

### Phase 1：组织与授权

- 部门树、闭包、用户多部门、部门数据源授权；
- 组织管理页、导入；
- 有效数据源访问取并集；
- 暂不启用行过滤。

### Phase 2：映射、策略与执行

- 部门映射导入/校验；
- 表分类、覆盖检查、自动识别；
- AST 改写、结构化错误、审计；
- 范围快照、分享限制、legacy；
- 数据源受控开关。

### Phase 3：引导与诊断

- 设置向导完善、预览；
- 权限诊断、被拒查询列表；
- 空态/错误卡片/范围徽标；
- 性能压测与文档。

## 18. 待评审确认

以下为第一版选定的默认行为，评审时确认：

1. **部门授权向下继承**：授予父部门，子部门用户自动获得数据源访问。
2. **映射一对一**：一个系统部门在一个数据源只有一行映射；多历史编码/别名留到后续。
3. **未映射即失败**：任一有效部门缺映射时整条查询失败，不做部分结果。
4. **管理员可查 denied**：用于排障，必须审计。
5. **legacy 仅隐藏结果**：对话文本和 SQL 保留，结果数据非管理员不可见。
6. **受控数据源不允许公开分享**：包括已有的和新创建的。

确认后进入实施计划拆分；本文只描述设计，不包含代码。
