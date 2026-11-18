# Datasources and schema cache

A datasource is an encrypted MySQL/PostgreSQL connection plus a cached schema
snapshot. Admins manage connections; users only see datasources granted to them.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Input validation | Shared schema, host/port/database rules | [`index.ts`](../../packages/shared/src/index.ts) |
| Probe | Connect, test read-only status, collect safe warnings | [`probe.ts`](../../apps/server/src/agent/datasource/probe.ts) |
| Introspection | MySQL/PostgreSQL tables, columns, keys | [`introspect.ts`](../../apps/server/src/agent/datasource/introspect.ts) |
| Credentials | AES-GCM encrypt/decrypt with `APP_SECRET` | [`crypto.ts`](../../apps/server/src/agent/datasource/crypto.ts) |
| Pools | Reuse connections; close on config change | [`pool.ts`](../../apps/server/src/agent/datasource/pool.ts) |
| Schema cache | Persist snapshot/error, 24h TTL, in-flight dedupe, stale fallback | [`schema-refresh.ts`](../../apps/server/src/services/schema-refresh.ts), [`schema-cache.ts`](../../apps/server/src/db/repositories/schema-cache.ts) |
| Admin routes | CRUD, test, schema refresh, permission checks | [`datasources.ts`](../../apps/server/src/routes/datasources.ts), [`datasource-schema.ts`](../../apps/server/src/routes/datasource-schema.ts) |
| Grant checks | User/role/direct datasource access | [`access.ts`](../../apps/server/src/auth/access.ts) |

`datasources.password_cipher` is the only stored secret. Never log or return
plaintext passwords; probe errors are passed through `safeErrorMessage` with the
password redacted.

## Runtime paths

### Create / update

1. Admin submits `datasourceInputSchema` (name, type, host, port, database,
   username, password, SSL mode, `allowWriteAccount`).
2. Reject link-local/metadata hosts (`isBlockedDatasourceHost`) and duplicate names
   before connecting.
3. `probeDatasource` opens a short-lived connection and checks read-only status. The
   submitted password is used for this probe and never logged.
4. Store the encrypted password; `readOnlyVerified=1` only when the probe proves it.
   When `allowWriteAccount` is set, keep the flag but still execute only read-only
   statements. Editing host/database/credentials resets `readOnlyVerified=0`.
5. Audit `datasource_create`/`datasource_update`; invalidate pools for the old
   connection.

### Schema read (`db_schema` or schema API)

1. Check the user still has access to the datasource.
2. Load the cached snapshot. If absent or older than
   `SCHEMA_CACHE_TTL_MS` (24h), call `refreshDatasourceSchema`.
3. Concurrent refreshes for one datasource share one introspection promise.
4. Introspection saves a new snapshot; on failure it saves the error but keeps the
   old snapshot.
5. If refresh fails and a snapshot exists, serve it with `stale=true`; if no
   snapshot exists, return `SCHEMA_UNAVAILABLE` with a user-safe reason.
6. The tool may filter by `table` or `search`; truncation is explicit so the model
   knows the schema is incomplete.

The schema endpoint reads the same cache; it does not expose credentials or query
data.

## Contracts

- Datasource ids are UUIDs; ownership is **not** a column—access comes from grants.
  Every route/tool must call the grant check; never accept a datasource id from the
  model without checking it against the run’s user.
- The read-only pool is the execution boundary. `allowWriteAccount` only suppresses
  the “account is writable” warning; the SQL guard still rejects writes.
- Do not add a new dialect by branching only in the UI. Guard parsing, executor,
  introspection, placeholder syntax and tests must all support it.
- Deleting a datasource that conversations still reference must fail with `409`;
  clean schema cache/pools/grants on success.
- Schema snapshots are metadata, not a security boundary: table/column names can
  appear in prompts, but row data must still go through `db_query`.
- Cache invalidation must be explicit after DDL or connection edits. Do not rely on
  TTL alone when the admin can refresh immediately.

## Failure behavior

| Case | Behavior |
| --- | --- |
| Bad credentials/host | Controlled probe error; no datasource row on create |
| Link-local/metadata host | `400 HOST_NOT_ALLOWED` |
| Duplicate name | `409 CONFLICT` |
| Probe succeeds but account writable | Save with warning unless `allowWriteAccount` |
| Refresh fails, old snapshot exists | Serve stale + warning |
| Refresh fails, no snapshot | `SCHEMA_UNAVAILABLE`; do not fabricate schema |
| User lacks grant | `403`/tool `DATASOURCE_FORBIDDEN`; no connection |
| Delete in use | `409`; do not cascade silently |

## Verification

```bash
pnpm exec vitest run apps/server/test/datasource.test.ts \
  apps/server/test/datasource-schema.test.ts \
  apps/server/test/schema-refresh.test.ts \
  apps/server/test/db-schema-lazy.test.ts \
  apps/server/test/probe.test.ts \
  apps/server/test/introspect.test.ts
RUN_DB_TESTS=1 pnpm exec vitest run apps/server/test/introspect.integration.test.ts
```

A connection/security change needs a real MySQL/PostgreSQL probe test. A cache
change needs a stale-fallback test that proves the old snapshot is not deleted.
