# SQL, artifacts and audit

Every user-facing query goes through one guarded path. This page covers the SQL
boundary and the files that hold results; prompt wording and chat rendering are in
[Chat UI](chat-ui.md).

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Guard | Parse/allow-list a statement, reject writes/system access, inject a bounded limit | [`guard.ts`](../../apps/server/src/agent/sql/guard.ts) |
| Executor | Run one statement on the read-only pool, stream rows, enforce timeout/abort | [`executor.ts`](../../apps/server/src/agent/sql/executor.ts) |
| Query service | Authorize, read settings, guard, execute, write artifact, record audit | [`query-service.ts`](../../apps/server/src/services/query-service.ts) |
| Artifact store | JSONL rows + metadata; chart specs; read/preview/export | [`artifacts.ts`](../../apps/server/src/services/artifacts.ts) |
| Audit | Write `query_audit` for ok/rejected/error | [`audit.ts`](../../apps/server/src/services/audit.ts) |
| Export HTTP | Authorize, stream, audit completion | [`artifacts.ts` route](../../apps/server/src/routes/artifacts.ts) |
| Chart tool | Build a spec from a result artifact | [`make-chart.ts`](../../apps/server/src/agent/tools/make-chart.ts) |

Limits (`maxRows`, `previewRows`, `timeoutMs`) come from app settings via
`resolveQueryLimits`; read them once per query so a settings change applies to the
next run. The datasource connection is encrypted at rest and decrypted only inside
the query path.

## Runtime path

```text
tool/route
  → authorizeDatasourceAccess(user, datasource)
  → resolveQueryLimits()
  → guardSql({ sql, dialect, maxRows })
      ├─ rejected → audit(rejected) → errorResult (no pool, no connection)
      └─ ok
  → ArtifactStore.openResult()
  → executeReadOnly(pool, guardedSql, limits, signal, onRow)
  → writer.finish({ columns, rowCount, truncated })
  → audit(ok, duration, rowCount)
  → { artifactId, columns, previewRows, rowCount, truncated, guardedSql }
```

- `guardSql` allows read-only statement types only; rejects writes/DDL, system
  schemas, locking, hints, unsafe functions, and excessive table counts. It returns
  the SQL actually sent, including the injected limit.
- `executeReadOnly` uses the datasource’s read-only pool, streams each row to the
  artifact writer, and bounds memory to the preview window. `rowCount` counts all
  returned rows; `truncated` says the cap was reached.
- A rejected query is audited with the reason and never opens a connection.
- The artifact is durable before the audit is written. An audit failure must not
  delete or invalidate a successful result.

## Artifact contracts

- `artifacts.kind` is `result` or `chart`. Result rows live in
  `DATA_DIR/artifacts/*.jsonl` (gzip where applicable); SQLite stores id, owner,
  conversation/run, columns, row count, truncation, relative storage path and
  timestamps.
- Values are encoded/decoded for BigInt, Date, Buffer, Decimal and non-finite
  numbers (`encodeValue`/`decodeValue`). Do not `JSON.stringify` driver rows
  directly.
- Preview rows are a bounded slice for the UI. Full rows are read by the artifact
  API with pagination; exports stream the file.
- Artifacts are scoped by `userId` and optionally conversation/run. A download or
  chart must verify access; never accept an arbitrary file path.
- Chart input is capped (`MAX_CHART_INPUT_ROWS = 50_000`) and reads only a result
  artifact. A chart spec is stored as an artifact of kind `chart`, not as SQLite
  row data.
- Deleting a conversation/user cleans artifact files and rows; do not orphan files.

## Audit contracts

`query_audit` records user, datasource, conversation/run, action (`query`/
`explain`), SQL text, status (`ok`/`rejected`/`error`), row count, duration, error
message. Audit rows are append-only; do not update a success into a rejection.
The admin audit page/pagination reads these rows; keep indexes and filters stable.

## Failure behavior

- Guard rejection: stable code (`SQL_NOT_ALLOWED`, etc.), human-readable reason,
  audit row, no connection.
- Datasource not verified/read-only: fail closed unless explicitly
  `allowWriteAccount`; still execute only read-only statements.
- Timeout/abort: executor throws a typed error; the artifact writer is aborted and
  partial files are removed/finalized consistently.
- Export disconnect: stream cleanup runs and exactly one audit row is written with
  `ok` or `error`.
- Malformed artifact JSON/columns: return a controlled error; do not crash the
  detail page.

## Verification

```bash
pnpm exec vitest run apps/server/test/query-service.test.ts \
  apps/server/test/query-service.artifacts.test.ts \
  apps/server/test/sql/guard.test.ts \
  apps/server/test/artifacts.test.ts \
  apps/server/test/artifacts-api.test.ts \
  apps/server/test/charts.test.ts \
  apps/server/test/make-chart-tool.test.ts
RUN_DB_TESTS=1 pnpm exec vitest run apps/server/test/query-service.integration.test.ts \
  apps/server/test/sql/executor.integration.test.ts
```

For a new dialect/statement shape, add a guard test and a real-database integration
case. For a new artifact consumer, test the cross-user/export denial path.
