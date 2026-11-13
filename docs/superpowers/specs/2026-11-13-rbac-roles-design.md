# RBAC 角色与权限设计

- 日期：2026-11-13
- 状态：待评审
- 范围：RBAC 第一版（自定义角色、功能权限矩阵、角色-数据源授权、用户角色分配）
- 后续：定时任务（Phase 2）

## 1. 背景

当前权限模型只有两种身份：

- `users.role` 为 `admin | user`
- 普通用户通过 `datasource_grants` 直接获得单个数据源权限
- 所有 `/api/admin/*` 路由使用 `requireAdmin`

这无法表达“财务分析师只能查财务库、不能导出/分享”“运营角色可以导出但不能建报告”等需求。本设计引入自定义角色，同时保留现有用户直授数据源，避免迁移时丢权限。

## 2. 目标与非目标

### 目标

- 管理员可创建/编辑/删除自定义角色
- 角色包含功能权限集合与数据源授权集合
- 一个用户可分配多个角色，权限与数据源取并集
- 保留用户直授数据源，与角色授权取并集
- 服务端逐路由执行权限，前端按权限隐藏/禁用操作
- 角色与分配的变更写入审计
- 现有非管理员迁移后行为不变

### 非目标

- 行级/列级数据权限（后续用数据库视图或 RLS）
- 按角色限制可用模型
- 技能/MCP 服务器的逐项授权（第一版只有 `skill.use` / `mcp.use` 总开关）
- 角色继承、审批流、临时授权
- 定时任务与站内信（Phase 2）
- 系统管理权限授予自定义角色

## 3. 权限矩阵

权限常量放在 `packages/shared/src/permissions.ts`，服务端与前端共用。

### 功能权限

| 权限 | 说明 |
| --- | --- |
| `chat.use` | 创建/查看/删除自己的会话，发消息、停止、重试、反馈、回答问卷、查看结果 |
| `skill.use` | 会话注入 Skills、`/` 技能菜单、发送时选择技能 |
| `mcp.use` | 会话加载 MCP 工具 |
| `report.create` | 从查询结果生成报告 |
| `share.create` | 创建分享链接 |
| `export.data` | 下载 CSV / Excel |

### 系统权限

| 权限 | 说明 |
| --- | --- |
| `admin.users` | 用户管理 |
| `admin.roles` | 角色管理 |
| `admin.datasources` | 数据源管理、schema 刷新、授权 |
| `admin.skills` | 技能管理 |
| `admin.mcp` | MCP 管理 |
| `admin.settings` | 模型服务与系统设置 |
| `admin.audit` | 审计日志 |
| `admin.ops` | 运维页、保留策略、备份列表 |

系统权限只用于展示和内置 admin 判定；自定义角色不允许包含任何 `admin.*` 权限。UI 中系统分组只读。

### 内置角色

- **管理员**：不存为普通角色；`users.role === "admin"` 时拥有全部功能权限和全部数据源，绕过 `role_*` 查询。
- **成员**：内置角色（`builtin = 1`），默认拥有全部功能权限、无数据源授权。可编辑其功能权限，但不可删除、不可改名。
- 现有 `role = "user"` 的用户迁移时自动分配“成员”，保持原有能力。
- 新用户默认分配“成员”。

## 4. 数据模型

迁移 `0010_rbac.sql`：

```sql
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE role_datasource_grants (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  datasource_id TEXT NOT NULL REFERENCES datasources(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, datasource_id)
);

CREATE INDEX user_roles_role_idx ON user_roles (role_id);
CREATE INDEX role_datasource_grants_datasource_idx ON role_datasource_grants (datasource_id);
```

种子数据：

- `roles` 插入 `role_member`，名称“成员”，`builtin = 1`
- `role_permissions` 插入 6 个功能权限
- `user_roles` 从 `users WHERE role = 'user'` 插入 `role_member`

迁移 `0011_role_audit.sql`：按 `0009_ops_audit.sql` 的方式重建 `query_audit`，在 CHECK 中加入 `role_change`。

角色删除时，`user_roles` 与 `role_datasource_grants` 由外键级联删除。现有 `datasource_grants` 表不变。

## 5. 权限解析

新增 `apps/server/src/auth/access.ts`：

```ts
export interface UserAccess {
  isAdmin: boolean;
  permissions: Set<Permission>;
  /** null 表示全部数据源（管理员） */
  datasourceIds: Set<string> | null;
}

export function resolveUserAccess(db: Db, user: UserRow): UserAccess;
```

解析规则：

1. `role === "admin"`：全部权限、`datasourceIds = null`
2. 其他用户：
   - `user_roles → role_permissions` 去重得到权限集合
   - `role_datasource_grants` 与 `datasource_grants` 去重得到数据源集合
3. 无角色用户：解析器按“成员”功能权限兜底（仅兼容迁移前的历史行/测试），服务端禁止保存空 `roleIds`，因此正常运行不会产生无角色用户。

`authenticate` 每次请求从数据库重新解析（角色/分配变更立即生效，不依赖 JWT 中的 role），挂到 `request.access`。新增：

```ts
app.decorate("requirePermission", (permission: Permission) => async (request, reply) => {
  await app.authenticate(request, reply);
  if (reply.sent) return;
  if (!request.access?.permissions.has(permission)) {
    return reply.code(403).send({
      error: { code: "PERMISSION_DENIED", message: "当前角色没有此操作权限", permission },
    });
  }
});
```

`requireAdmin` 保留给真正的系统入口；系统路由改为 `requirePermission("admin.users")` 等，语义更清晰。由于自定义角色不能有系统权限，两者结果一致。

`/api/auth/me` 返回：

```json
{
  "user": { "...": "..." },
  "permissions": ["chat.use", "report.create"],
  "roles": [{ "id": "role_member", "name": "成员" }]
}
```

## 6. 数据源访问

- `listDatasourcesForUser` 改为 `access.datasourceIds === null ? 全部 : IN (...)`，不再单独接收 isAdmin。
- 创建会话、发消息、重试、读取结果、刷新 schema 时继续校验目标数据源在 `access.datasourceIds` 内。
- 角色授权与直授取并集；管理员不受限。
- 删除数据源时，`role_datasource_grants` 行级联删除。

## 7. 路由执行点

| 路由/功能 | 权限 |
| --- | --- |
| `/api/conversations/*`（列表、详情、创建、消息、停止、重试、反馈） | `chat.use` + 数据源访问 |
| `/api/conversations/:id/skills` | `chat.use`；无 `skill.use` 返回空数组 |
| 发送消息携带 `skill` | `chat.use` + `skill.use`，否则 403 |
| `/api/questions/*` | `chat.use` |
| `/api/artifacts/:id`（预览 JSON） | `chat.use` + 属主/管理员 |
| `/api/artifacts/:id/download?format=csv\|xlsx` | `export.data` + 属主/管理员 |
| `POST /api/reports` | `report.create` |
| `GET/DELETE /api/reports/:id` | 登录 + 属主/管理员（撤销权限后仍可查看/删除已有报告） |
| `POST /api/shares` | `share.create` |
| `DELETE /api/shares/:id` | 登录 + 属主/管理员（允许撤销已有分享） |
| `GET /api/public/shares/:token` | 公开，不变 |
| `/api/admin/users/*` | `admin.users` |
| `/api/admin/roles/*` | `admin.roles` |
| `/api/admin/datasources/*`、授权、schema 刷新 | `admin.datasources` |
| `/api/admin/skills/*` | `admin.skills` |
| `/api/admin/mcp-servers/*` | `admin.mcp` |
| `/api/admin/settings`、`/api/admin/llm-providers/*` | `admin.settings` |
| `/api/admin/audit` | `admin.audit` |
| `/api/admin/ops/*` | `admin.ops` |

`/api/models` 保持登录即可访问；Composer 需要模型列表，模型配置仍由管理员维护。

## 8. Agent 资源门禁

`ConversationResourcesInput` 增加：

```ts
permissions: { skills: boolean; mcp: boolean };
```

- `skills = false`：不传入 materialized skills 路径，`materializeSkills` 跳过；会话工具中无技能。
- `mcp = false`：不注册 `createMcpExtension`，会话无 MCP 工具。
- 两者在**会话创建时**读取用户权限。权限变更后，已缓存的 Pi 会话不会热移除资源；关闭/新建会话后生效。HTTP 接口和 UI 立即生效。
- 若用户没有 `skill.use`，`/conversations/:id/skills` 返回 `[]`；发送带技能的请求返回 403 `PERMISSION_DENIED`。
- `mcp.use` 不改变管理端 MCP CRUD。

## 9. 管理 API

### 角色

- `GET /api/admin/roles`：列表，含 `userCount`、`permissionCount`、`datasourceCount`
- `GET /api/admin/roles/:id`：角色详情（permissions、datasourceIds）
- `POST /api/admin/roles`：`{ name, description?, permissions: string[], datasourceIds: string[] }`
- `PATCH /api/admin/roles/:id`：同上，均可选；内置成员不可改名
- `DELETE /api/admin/roles/:id`：内置角色返回 400 `BUILTIN_ROLE`

校验：

- `name` 去空白后 1–40 字符，唯一；允许中文
- `description` ≤ 200 字符
- `permissions` 只能来自功能权限；出现 `admin.*` 返回 400 `SYSTEM_PERMISSION_NOT_ALLOWED`
- `datasourceIds` 去重且必须存在，否则 400
- 内置成员允许修改 permissions/datasourceIds，但不允许改名/删除

### 用户

- `GET /api/admin/users` 返回每个用户的 `roles: [{id,name}]` 与 `roleIds`
- `POST /api/admin/users` 增加可选 `roleIds`，缺省分配成员
- `PATCH /api/admin/users/:id` 增加可选 `roleIds`；管理员账户的 `role` 字段逻辑不变
- 保留现有“至少一名可用管理员”保护
- 直授数据源仍走原数据源授权接口，不在用户编辑页合并

### 审计

- 角色创建/更新/删除：`role_change`，`detail` 记录 `{ roleId, action, permissions, datasourceIds }`
- 用户角色变更：`user_update`，`detail` 记录 `{ roleIds }`
- 不记录权限矩阵全文到 SQL 文本，`sqlText` 使用 `role:<name>`

## 10. 前端

### 角色管理页 `/admin/roles`

- 列表：名称、描述、权限数、数据源数、用户数、内置标记
- 新建/编辑抽屉：
  - 名称、描述
  - “功能权限”分组复选（使用 / 产出）
  - “系统权限”分组只读，提示仅内置管理员
  - 数据源多选（全部数据源列表，仅管理员可见）
- 删除确认；内置成员隐藏删除，名称禁用
- 顶部说明卡：管理员不受角色限制；多角色取并集

### 用户管理页 `/admin/users`

- 用户行显示角色标签
- 新建/编辑增加角色多选
- 保留启用/禁用、管理员角色、密码重置

### 会话界面

新增 `useCan(permission)`（基于 `/api/auth/me`）：

- `share.create` 为 false：隐藏“分享”按钮
- `report.create` 为 false：隐藏结果卡片“生成报告”
- `export.data` 为 false：隐藏“下载 CSV / Excel”
- `skill.use` 为 false：隐藏 `/` 技能菜单与技能 chip 选择
- `chat.use` 为 false：会话页显示无权限提示（正常情况下仍可登录）
- 401/403 错误统一显示后端 message，不静默失败

`AppShell` 管理导航根据 `permissions` 是否包含对应 `admin.*` 显示；自定义角色没有系统权限，因此仍只对 admin 显示。

## 11. 兼容与迁移

- 现有非 admin 用户 → 成员角色 + 全部功能权限，行为不变
- 现有直授数据源保留
- 现有 admin 不受影响
- `/api/auth/me` 新增字段，旧前端忽略也不报错
- 迁移不删除任何表/数据
- 升级前建议 `pnpm ops:backup`

## 12. 测试

服务端：

- `resolveUserAccess`：管理员全量、多角色并集、直授+角色并集、无角色容错
- 角色 CRUD：系统权限拒绝、重名、内置角色删除/改名、数据源不存在
- 用户角色分配：多角色、默认成员、审计、至少一名管理员保护不变
- 权限门禁：无 `chat.use`/`report.create`/`share.create`/`export.data` 时 403；有权限时通过
- 数据源过滤：角色授权可见、直授可见、无授权不可见/不可建会话
- skills/mcp：无权限时资源不加载、技能列表为空、带技能发送 403
- 迁移：成员角色种子、现有用户自动分配
- 审计：角色变更与用户角色变更可查

前端：

- 角色编辑：权限勾选、系统权限只读、数据源选择、内置成员限制
- 用户编辑：角色多选与展示
- ChatPage/ResultTable/ShareDialog：按权限隐藏操作
- `useCan` 对未知权限返回 false

验证：`pnpm verify`、`pnpm lint`、CI 全绿。

## 13. 验收标准

- 管理员可创建“财务分析师”角色，授权财务数据源与 chat/export，不授予 report/share
- 用户分配该角色后只看到财务数据源，可查询、可导出，看不到报告/分享入口，直接调接口 403
- 用户同时拥有两个角色时，权限和数据源为并集
- 自定义角色无法获得任何 `admin.*` 权限
- 现有普通用户升级后行为与升级前一致
- 角色与分配变更可在审计页查到
- 角色变更后新会话立即按新 Skills/MCP 权限加载

## 14. 实施顺序（供 plan 使用）

1. 共享权限常量 + 数据表/迁移/种子
2. access 解析、`requirePermission`、`/api/auth/me`
3. 角色 CRUD 与用户角色分配 API + 审计
4. 数据源过滤与功能路由门禁
5. Agent skills/MCP 门禁
6. 角色管理页、用户页、会话 UI 权限
7. 测试、文档、verify
