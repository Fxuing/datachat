# Auth and permissions

Authentication is a signed cookie; authorization is re-resolved from SQLite on
every request. The browser is never the authority.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Session cookie | Sign/verify `dc_session`; expiry/renewal | [`jwt.ts`](../../apps/server/src/auth/jwt.ts) |
| Login | Verify password, issue cookie, rate limit | [`routes/auth.ts`](../../apps/server/src/routes/auth.ts), [`password.ts`](../../apps/server/src/auth/password.ts) |
| Guards | `authenticate`, `requirePermission`, `requireAdmin` | [`guard.ts`](../../apps/server/src/auth/guard.ts) |
| Access resolution | Union roles + direct grants; admin bypass | [`access.ts`](../../apps/server/src/auth/access.ts) |
| Permission list | Shared permission strings/labels | [`permissions.ts`](../../packages/shared/src/permissions.ts) |
| Role/user admin | Roles, assignments, datasource grants | [`routes/admin-roles.ts`](../../apps/server/src/routes/admin-roles.ts), [`admin-users.ts`](../../apps/server/src/routes/admin-users.ts) |
| Public share | Anonymous token + snapshot | [`shares.ts`](../../apps/server/src/services/shares.ts) |

`users.role = "admin"` is the system-admin flag. Custom roles are additive; a user
with no custom role falls back to the built-in member preset. Datasource access is
the union of role grants and direct `datasource_grants`.

## Request path

1. `authenticate` reads `dc_session`, verifies the signature, then **re-reads the
   user from SQLite**. A disabled/deleted user is rejected even if the JWT is valid.
2. `request.user` and `request.access` are set; `resolveUserAccess` computes
   permissions and allowed datasource ids. Roles/status are not trusted from the
   token.
3. `requirePermission(permission)` calls `authenticate`, then checks
   `request.access.permissions`; failure is `403 PERMISSION_DENIED` with the
   missing permission.
4. The route/service checks resource ownership and datasource grants. A resource
   belonging to another user is `404`, not `403` (do not leak existence).
5. Agent tools receive `userId`/`datasourceId` from the session, not from model
   arguments, and re-check access before querying. A queued or scheduled run
   re-resolves access at execution time.

## Permission model

- Functional permissions include chat, skills, MCP, reports, shares, export, and
  admin areas. See `packages/shared/src/permissions.ts`; add new permissions to
  `ALL_PERMISSIONS`, role presets, route/tool gates, admin UI, and tests.
- Datasource grants are separate from functional permissions: a user needs both
  `chat.use` (or the relevant feature) and access to that datasource.
- Admin bypass is by the `admin` flag, not a role name. Admins can manage users,
  roles, datasources, settings, and audit; they do not automatically read other
  users’ memory contents.
- A public share is not a login bypass for other APIs. It resolves only the share
  token and returns the stored snapshot, subject to expiry/revocation.

## CSRF, cookies and deployment

- Browser mutations require the configured `APP_ORIGIN` (including the public
  port); an origin mismatch is rejected before the route.
- `COOKIE_SECURE` is explicit or derived from `APP_ORIGIN`’s protocol. HTTP + IP
  deployments need `Secure=false`; HTTPS needs `Secure=true`.
- `TRUST_PROXY` is only for a trusted reverse proxy; do not enable it blindly.
- Session cookies are HttpOnly/SameSite by default; never expose them to JS.

## Failure behavior

- Missing/expired/invalid cookie: `401 AUTH_REQUIRED`; do not redirect from the API.
- Authenticated but missing permission: `403 PERMISSION_DENIED` with `permission`.
- Resource not owned: `404 NOT_FOUND`.
- Datasource revoked/disabled: tool/query returns a permission error; do not fall
  back to another datasource.
- Admin deleting a role in use: `409`; deleting a user revokes sessions by the
  next-request user read and cleans owned resources.

## Verification

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

A permission change needs at least one cross-user denial test and one admin bypass
test. A new public route needs an explicit reason and a test proving what it does
not expose.
