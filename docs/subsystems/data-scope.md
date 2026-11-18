# 部门与行级数据权限

功能权限决定“能不能用某个能力”，部门数据权限决定“能看到哪些行”。两者叠加：用户既要有数据源访问权，也要命中表策略和行范围。浏览器、模型参数和请求体都不是权限的事实来源。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 表 | 部门树/闭包、成员、部门授权、组织映射、表策略/规则、快照 | [`schema.ts`](../../apps/server/src/db/schema.ts)（`departments`、`department_closure`、`user_departments`、`department_datasource_grants`、`department_org_map`、`data_scope_policies`、`data_scope_rules`） |
| 部门仓储 | 建/改/移动/删除、闭包重建、成员、授权（查祖先）、子树解析 | [`departments.ts`](../../apps/server/src/db/repositories/departments.ts) |
| 范围配置仓储 | 表策略、组织映射、覆盖统计 | [`data-scope.ts`](../../apps/server/src/db/repositories/data-scope.ts) |
| 访问解析 | 角色/直授/部门授权并集；`access.departmentIds` = 子树并集 | [`access.ts`](../../apps/server/src/auth/access.ts) |
| 范围解析 | 决定每张表的 public/denied/scoped 与过滤值，生成快照 | [`data-scope.ts` 服务](../../apps/server/src/services/data-scope.ts) |
| SQL 改写 | 把 scoped 表包成带条件（`IN`、比较、`IS NULL`）的派生表 | [`scope.ts`](../../apps/server/src/agent/sql/scope.ts) |
| 历史可见性 | run 快照校验、artifact/report 过滤 | [`scope-access.ts`](../../apps/server/src/services/scope-access.ts) |
| 管理 API | 部门 CRUD、成员、授权、导入；范围配置、预览、诊断、启用 | [`admin-departments.ts`](../../apps/server/src/routes/admin-departments.ts)、[`admin-data-scope.ts`](../../apps/server/src/routes/admin-data-scope.ts) |
| 管理 UI | 部门页、受控配置页、用户部门分配 | [`DepartmentsPage.tsx`](../../apps/web/src/pages/admin/DepartmentsPage.tsx)、[`DatasourceScopePage.tsx`](../../apps/web/src/pages/admin/DatasourceScopePage.tsx)、[`UsersPage.tsx`](../../apps/web/src/pages/admin/UsersPage.tsx) |

## 模型

- 部门是一棵树，`department_closure` 存 `(ancestor, descendant, depth)`，自身 depth 为 0。移动部门后闭包整体重建；禁止移到自己的子树下。
- 用户可属多个部门，`is_primary` 只用于展示。有效范围 = 所有所属部门的**子树并集**；父部门天然包含下级。
- 数据源访问 = 角色授权 ∪ 用户直授 ∪ 部门授权。部门授权沿树**向下继承**，所以查询某部门的授权要取它的**祖先**；范围计算则取**子树**。这两个方向写反是本模块最容易犯的错。
- 表策略按 `(datasource_id, table_name)` 唯一，`mode` 为 `scoped` / `public` / `denied`。`scoped` 由 `data_scope_rules` 中的一条或多条规则组成，规则之间固定按 **AND** 组合；目前不支持 OR。没有规则（或规则为空）的 `scoped` 策略不能保存。开启受控后，没有策略的表一律视为未分类并拒绝，绝不静默放行。
- 规则字段：`column_name`、`operator`（`eq` / `in` / `not_in` / `gt` / `gte` / `lt` / `lte`）、`value_mode`、`literal_values_json`、`null_visible`。`in` / `not_in` 可用多个值，比较操作只接受一个固定值；空 `IN` 生成恒假条件，空 `NOT IN` 不产生限制。
- 取值方式分两类：
  - **全局固定值** `literal`：对所有用户生效，**包括管理员**。适合 `is_deleted = 0`、`tenant_id = 'x'` 这类数据完整性约束。
  - **身份派生值**：`department_id` / `department_code`（本系统部门）、`external_id` / `external_code` / `external_org_code`（组织映射）、`user_id` / `username` / `role`（当前登录人）。管理员不受这些条件限制。
- 每条规则独立决定 `null_visible`，默认 **false**；为 true 时该条件变成 `(条件 OR 列 IS NULL)`，再与其他条件 AND。
- 组织映射按 `(datasource_id, department_id)` 唯一。`app_id` / `app_code` 直接使用本系统 `departments.id` / `departments.code`；`external_*` 必须来自 `department_org_map`。
- 状态 `datasources.data_scope_mode`：`off`（默认，不过滤）、`configuring`（可配置，不过滤）、`enabled`（强制过滤）。启用前要求所有已缓存表已分类；使用外部取值时还要求所有相关部门已映射。
- 快照 `runs.scope_snapshot` 记录 `{v:1, datasourceId, departments, departmentNames?, scopedTables?, policyHash}`。`departments` 是当时生效的部门集合（子树展开后的 id）；空数组表示不限制（管理员或未受控）。`departmentNames` 是写入时捕获的展示名，`scopedTables` 是实际被改写加过滤的表；两者都用于回答里的范围提示，旧快照可能没有。`policyHash` 用于事后判断策略是否变化。

## 运行路径

```text
query/explain
  → authorizeDatasourceAccess + resolveQueryLimits
  → guardSql
  → applyScopeToSql({ datasourceId, mode, userId, sql, dialect })
      ├─ off/configuring → 原样执行（快照 departments=[]）
      └─ enabled
          ├─ admin → 只应用 literal 规则（全局约束），部门/身份规则跳过
          └─ 非 admin
              → listUserDepartments → effectiveDepartmentIds（子树）
              → 每张物理表查策略
                  ├─ public   → 不动
                  ├─ denied   → DATA_SCOPE_DENIED_TABLE
                  └─ scoped   → 逐条规则生成条件（AND）；包成派生表
  → executeReadOnly(sql, params)
  → 成功后写 run.scope_snapshot → artifact → audit(ok, scopeReason)
```

- 改写覆盖 join、子查询、派生表和 CTE 体；CTE 名本身不会被误当成物理表。`scoped` 表被替换为 `(SELECT * FROM <表> WHERE <条件1> AND <条件2> …) AS <别名>`；每个条件按操作符生成 `= ?` / `IN (?, …)` / `NOT IN (?, …)` / `> ?`，必要时包成 `(… OR <列> IS NULL)`。参数用真实绑定值，不做字面量拼接。
- `nullVisible` 当前只生成 `IS NULL` 分支；不要假设它还会匹配空字符串。空字符串需要单独写 `eq ''` 规则（注意数值列在 PostgreSQL 上会报类型错误）。
- 未分类、拒绝、映射缺失和策略过期都发生在**建立连接之前**，并写 `rejected` 审计与 `scope_reason`。
- 管理员只有在存在 `literal` 规则时才会被改写；此时快照仍是 `departments: []`，查询会被标记为已过滤，但不会显示部门范围条。
- `db_schema` 对受控数据源只暴露已分类且非 `denied` 的表；无部门时直接返回 `DATA_SCOPE_NO_DEPARTMENT`。`db_explain` 与查询走同一套改写。
- 启用受控时撤销该数据源下所有未撤销分享；之后新建分享返回 `SHARE_DISABLED_BY_SCOPE`，已有链接解析同样失败。

## 历史与快照

- 读取 artifact、下载结果、读取报告、拉取会话详情时，都会用 run 快照判断可见性：非管理员要求快照部门 ⊆ 当前子树并集。
- 快照缺失（受控前的历史 run）对非管理员不可见；管理员仍可读。这是有意的兼容策略，不是“默认放行”。
- 会话详情会给实际被改写的轮次附加 `scope.departments`（优先使用快照里的部门名）；聊天界面据此在回答上方显示“数据范围：海港分局（含下级部门）……”。没有 `scopedTables` 的旧快照不显示该提示，避免把全公开结果标成已过滤。
- 定时任务每次执行都重新解析权限和部门范围；任务不会保存旧范围继续跑。

## 失败行为

| 错误码 | 触发条件 | 用户可见结果 |
| --- | --- | --- |
| `DATA_SCOPE_NO_DEPARTMENT` | 受控数据源 + 用户没有任何部门 | 查询/`db_schema` 拒绝 |
| `DATA_SCOPE_MAPPING_MISSING` | 外部取值模式下某部门没有映射 | 整条查询拒绝，无部分结果 |
| `DATA_SCOPE_TABLE_NOT_CONFIGURED` | 表没有策略 | 查询/`db_schema` 拒绝，消息附带当前部门范围 |
| `DATA_SCOPE_DENIED_TABLE` | 表策略为 `denied` | 查询拒绝并提示当前部门范围；`db_schema` 不展示 |
| `DATA_SCOPE_POLICY_STALE` | 策略指向的表/列已不存在 | 查询拒绝，提示重新分类 |
| `DATA_SCOPE_NOT_VISIBLE` | 历史结果超出当前部门范围 | artifact/报告返回 404 |
| `SHARE_DISABLED_BY_SCOPE` | 受控数据源上的分享 | 创建 409；解析返回“分享不可用” |

空结果不是错误：范围内确实没有数据时返回 `rowCount = 0`，不要把它提示成权限失败。

## 管理路径

1. 管理员在 `/admin/departments` 建树、分配成员、勾选数据源授权的部门（子部门自动继承）。
2. `/admin/users` 给用户选部门与主部门；`/api/auth/me` 返回部门名用于聊天页范围徽标。
3. `/admin/datasources/:id/scope`：套用候选列 → 逐表分类 → 对“按条件过滤”的表点“编辑条件”逐条添加规则（字段、操作符、取值方式、固定值、空值可见）→ 保存 → 补组织映射（可 CSV 导入）→ 预览改写 → 诊断 → 启用。启用会二次确认并撤销分享。
4. “拒绝记录”读取带 `scope_reason` 的 rejected 审计，用来定位未分类表或缺失映射。

## 验证

```bash
pnpm exec vitest run apps/server/test/data-scope-schema.test.ts \
  apps/server/test/departments.test.ts \
  apps/server/test/access.test.ts \
  apps/server/test/data-scope.test.ts \
  apps/server/test/scope-rewrite.test.ts \
  apps/server/test/scope-resolve.test.ts \
  apps/server/test/query-scope.test.ts \
  apps/server/test/db-schema-scope.test.ts \
  apps/server/test/scope-access.test.ts \
  apps/server/test/admin-departments.test.ts \
  apps/server/test/admin-data-scope.test.ts
cd apps/web && pnpm exec vitest run src/pages/admin/DepartmentsPage.test.tsx \
  src/pages/admin/DatasourceScopePage.test.tsx src/components/chat/MessageItem.test.tsx
```

权限改动至少覆盖：父部门能看到子部门数据、子部门看不到父部门其他分支、无部门拒绝、未分类拒绝、历史结果跨部门不可见、受控后分享失效。
