# Reports and public shares

A report is a saved markdown document that references query-result artifacts. A
public share is a read-only projection of one report or conversation addressed by an
unguessable token.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Tables | `reports`, `shares`, `artifacts` | [`schema.ts`](../../apps/server/src/db/schema.ts) |
| Report creation | Ownership, artifact membership, markdown generation | [`reports.ts`](../../apps/server/src/services/reports.ts) |
| Report tool | Model-facing `create_report`, permission gate | [`create-report.ts`](../../apps/server/src/agent/tools/create-report.ts) |
| Routes | List/detail/delete reports; create/revoke shares | [`reports.ts` route](../../apps/server/src/routes/reports.ts), [`shares.ts` route](../../apps/server/src/routes/shares.ts) |
| Public resolve | Token lookup, expiry/revocation, projection | [`shares.ts`](../../apps/server/src/services/shares.ts) |
| Report UI | Markdown, artifacts, share/export | [`ReportPage.tsx`](../../apps/web/src/pages/ReportPage.tsx) |
| Public UI | Anonymous report/conversation view | [`PublicSharePage.tsx`](../../apps/web/src/pages/PublicSharePage.tsx) |

Constants: `REPORT_MAX_ARTIFACTS = 20`, `REPORT_MAX_MARKDOWN_LENGTH = 50_000`,
`SHARE_MAX_ROWS = 100`, expiry 1–365 days (default 7).

## Report path

1. `create_report` requires `report.create`, checks the conversation belongs to the
   user, and validates every artifact id: owned by the user, same conversation, no
   duplicates. Missing/foreign artifacts fail closed.
2. If markdown is omitted, the service builds it from the referenced artifacts
   (columns + preview rows); a supplied markdown is length/count checked.
3. The report stores `markdown` and `artifact_ids` (JSON). It does not copy row data;
   report rendering resolves current artifact contents.
4. Report detail is readable by its owner or an admin. Missing and foreign reports
   return the same not-found shape.
5. Deleting a report does not delete the underlying artifacts; deleting a
   conversation/artifacts can make a report’s result cards unavailable.

Reports use `[[artifact:<id>]]` for result cards and may contain Mermaid fences.
`[[result:<id>]]` is chat-only and stays literal in report markdown.

## Share path

1. Creating a share requires the relevant feature permission (`share.create`) and
   ownership. The raw token is generated randomly and returned **once**; only
   `sha256(token)` is stored.
2. A share targets a conversation or a report and has an expiry between 1 and 365
   days. Revocation sets `revoked_at`; expired/revoked/unknown tokens all return the
   same “share unavailable” response.
3. `GET /api/public/shares/:token` requires no login. It resolves the live
   conversation/report, applies the owner’s data, and returns a projection capped at
   `SHARE_MAX_ROWS` rows per result. It must not expose SQL, credentials, other
   conversations, or non-shared artifacts.
4. A share is a **live projection, not an immutable snapshot**. Deleting the report,
   conversation, or artifacts can make it unavailable or partial; the UI must handle
   that. Do not claim historical immutability.
5. Public responses are read-only and cannot create runs, reports, shares, or
   notifications. Rate-limit and cache headers should not leak whether a token
   existed before expiry.

## Contracts

- **Ownership is checked before every create/revoke.** A foreign report/share is
  `404`, not `403`.
- **Artifact ids are not trust boundaries.** Re-check owner + conversation on report
  creation and on public projection.
- **Tokens are bearer secrets.** Never log the raw token, store it in plaintext,
  put it in analytics, or return it in list responses. Store only the hash.
- **Public rendering is sanitized.** Markdown/HTML follows the same safe renderer;
  no arbitrary links/scripts, no authenticated API calls from the public page.
- **``[[result:...]]`` must not become a public data leak.** It is chat-only; report
  and public parsers leave it literal or ignore it.
- **Deletion is explicit.** Revoke shares when deleting their report/conversation;
  do not leave a token that resolves to unrelated data.

## Failure behavior

| Case | Behavior |
| --- | --- |
| Foreign/missing report | `404` (same shape) |
| Invalid/foreign artifact | `400`/`ARTIFACT_NOT_FOUND`; no report |
| Too many artifacts/markdown | Validation error; no partial report |
| Share token expired/revoked/unknown | Generic `SHARE_GONE` |
| Report deleted after share | Share unavailable; do not fall back |
| Artifact deleted | Result card unavailable; rest of report still renders |
| Public request tries mutation | `405`/`404`; no auth bypass |

## Verification

```bash
pnpm exec vitest run apps/server/test/reports.test.ts \
  apps/server/test/shares.test.ts
pnpm --filter @datachat/web exec vitest run \
  src/pages/ReportPage.test.tsx \
  src/pages/PublicSharePage.test.tsx
```

A sharing change needs an expired/revoked/foreign-token test and a projection test
proving no SQL/credentials/other-user data is returned. A report change needs a
cross-conversation artifact rejection test.
