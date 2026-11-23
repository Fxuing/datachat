# 认证与权限

认证使用签名 cookie；授权在每个请求上从 SQLite 重新解析。浏览器永远不是权限的事实来源。

## 职责与事实来源

| 部分 | 职责 | 源码 |
| --- | --- | --- |
| 会话 cookie | 签名/校验 `dc_session`；过期/续期 | [`jwt.ts`](../../apps/server/src/auth/jwt.ts) |
| 登录 | 校验密码、签发 cookie、限流 | [`routes/auth.ts`](../../apps/server/src/routes/auth.ts)、[`password.ts`](../../apps/server/src/auth/password.ts) |
| 守卫 | `authenticate`、`requirePermission`、`requireAdmin` | [`guard.ts`](../../apps/server/src/auth/guard.ts) |
| 访问解析 | 部门授权（向下继承）+ 个人特例直授取并集；admin 绕过 | [`access.ts`](../../apps/server/src/auth/access.ts) |
| 权限清单 | 共享权限字符串/标签 | [`permissions.ts`](../../packages/shared/src/permissions.ts) |
| 角色/用户/部门管理 | 角色（纯功能权限）、分配、数据源统一授权、用户部门 | [`routes/admin-roles.ts`](../../apps/server/src/routes/admin-roles.ts)、[`admin-users.ts`](../../apps/server/src/routes/admin-users.ts)、[`admin-departments.ts`](../../apps/server/src/routes/admin-departments.ts) |
| 公开分享 | 匿名 token + 只读投影 | [`shares.ts`](../../apps/server/src/services/shares.ts) |

`users.role = "admin"` 是系统管理员标志。权限与数据正交：自定义角色只授予**功能权限**（多角色叠加，无角色用户回退到内置成员预设），不再授予数据源访问权（`role_datasource_grants` 已在迁移 0016 移除）。数据源访问权是**部门授权（沿部门树向下继承）与个人特例直授（`datasource_grants`）的并集**，在数据源管理页的「授权」弹窗中统一配置（`GET/PUT /api/admin/datasources/:id/grants`）；部门页只读展示可访问数据源。`resolveUserAccess` 同时返回 `departmentIds`（所属部门子树并集，admin 为 null），供行级数据权限使用；数据边界见 [部门与行级数据权限](data-scope.md)。

## 请求路径

1. `authenticate` 读取 `dc_session`，校验签名，然后**从 SQLite 重新读取用户**。即使用户已被禁用/删除但 JWT 仍然有效，也会被拒绝。
2. 设置 `request.user` 和 `request.access`；`resolveUserAccess` 计算权限和允许的数据源 id。不信任 token 里的角色/状态。
3. `requirePermission(permission)` 先调用 `authenticate`，再检查 `request.access.permissions`；失败返回 `403 PERMISSION_DENIED`，并带上缺失的权限。
4. 路由/服务检查资源归属和数据源授权。访问其他用户的资源返回 `404`，不是 `403`（不泄露资源是否存在）。
5. Agent 工具从会话上下文中拿 `userId`/`datasourceId`，不从模型参数里拿，并在查询前重新检查权限。排队中或定时运行的 run 在执行时重新解析权限。

## 权限模型

- 功能权限包括聊天、技能、MCP、报告、分享、导出和管理区域。见 `packages/shared/src/permissions.ts`；新增权限要同步更新 `ALL_PERMISSIONS`、角色预设、路由/工具门禁、管理界面和测试。
- 数据源授权与功能权限分离：用户既需要 `chat.use`（或对应功能权限），也需要该数据源的访问权。
- 部门不是角色：部门只决定数据边界，不授予功能权限。部门授权只授予数据源访问权；表级与行级策略在查询路径中单独解析。
- Admin 绕过依据是 `admin` 标志，不是角色名。管理员可以管理用户、角色、部门、数据源、设置和审计；但不会自动读取其他用户的记忆内容。行级数据权限同样对管理员放行。
- `admin.departments` 控制部门管理 API 与 `/admin/departments` 页面；它不改变任何数据可见范围。
- 公开分享不是绕过其他 API 登录的通道。它只解析分享 token，返回受过期/撤销约束的只读投影（支持会话、报告与个人数据看板；看板分享仅返回图表渲染 spec 与刷新时间，绝不暴露 SQL 或数据源凭据）。如果目标会话、报告或看板中任一卡片引用了启用行级数据权限的数据源，创建与访问都会直接拒绝（`403`/`410 SHARE_DISABLED_BY_SCOPE`），且启用数据权限时自动撤销已有分享。

## CSRF、cookie 与部署

- 浏览器写操作要求配置的 `APP_ORIGIN`（包含公开端口）；origin 不匹配会在进入路由前被拒绝。
- `COOKIE_SECURE` 可以显式设置，也可以从 `APP_ORIGIN` 协议推导。HTTP + IP 部署需要 `Secure=false`；HTTPS 需要 `Secure=true`。
- `TRUST_PROXY` 只用于可信反向代理；不要盲目开启。
- 会话 cookie 默认 HttpOnly/SameSite；绝不要暴露给 JS。

## 失败行为

- cookie 缺失/过期/无效：`401 AUTH_REQUIRED`；API 不要返回重定向。
- 已认证但缺少权限：`403 PERMISSION_DENIED`，并带 `permission`。
- 资源不属于当前用户：`404 NOT_FOUND`。
- 数据源被撤销/禁用：工具/查询返回权限错误；不要回退到其他数据源。
- 部门相关失败：无部门、缺映射、未分类表等返回稳定的 `DATA_SCOPE_*` 错误码，并在建立连接前拒绝；完整列表见 [部门与行级数据权限](data-scope.md#失败行为)。
- 管理员删除正在使用的角色：`409`；删除用户后，下一次请求重读用户会使其会话失效，并清理其拥有的资源。

## 验证

```bash
pnpm exec vitest run apps/server/test/auth.test.ts \
  apps/server/test/auth-me.test.ts \
  apps/server/test/rbac-routes.test.ts \
  apps/server/test/rbac-schema.test.ts \
  apps/server/test/admin-roles.test.ts \
  apps/server/test/admin-users.test.ts \
  apps/server/test/admin-users-roles.test.ts \
  apps/server/test/shares.test.ts
```

权限改动至少需要一个跨用户拒绝测试和一个 admin 绕过测试。新增公开路由必须给出明确理由，并用测试证明它不会暴露什么。
