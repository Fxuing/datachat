# User memory: recall, save and extraction

Memory is per-user, cross-conversation context. It is additional prompt context, not
a second database the model can query. Memories are global or scoped to one
datasource and are only visible to their owner.

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Table/settings | `user_memories`, `user_memory_settings`, `runs.memory_extracted_at` | [`schema.ts`](../../apps/server/src/db/schema.ts), migration `0013` |
| Repository | Owner-scoped CRUD, dedupe/merge, active/core filters, source-run count | [`user-memories.ts`](../../apps/server/src/db/repositories/user-memories.ts) |
| Recall | Rank active memories, budget, format prompt block | [`recall.ts`](../../apps/server/src/memory/recall.ts) |
| Extension | Inject the block before each run | [`recall.ts`](../../apps/server/src/memory/recall.ts) |
| Tool | `memory_save` validation/persistence | [`tool.ts`](../../apps/server/src/memory/tool.ts) |
| Extraction | Successful-run transcript → validated memories | [`extraction.ts`](../../apps/server/src/memory/extraction.ts), [`generate.ts`](../../apps/server/src/memory/generate.ts) |
| Secrets | Reject passwords/tokens/keys | [`secrets.ts`](../../apps/server/src/memory/secrets.ts) |
| API | Owner-scoped list/create/update/delete/clear/settings | [`memories.ts` route](../../apps/server/src/routes/memories.ts) |

## Runtime paths

### Recall (before a prompt)

1. Check the global admin switch and the user’s setting. If either is off, inject
   nothing.
2. Load active memories: global + current datasource; exclude inactive/archived.
3. Put `core` `profile`/`instruction` memories first (budget `MEMORY_CORE_BUDGET =
   2000` characters), then ranked relevant memories (budget
   `MEMORY_RECALL_BUDGET = 1500`, at most `MEMORY_RECALL_LIMIT = 5`). Total is
   capped at `MEMORY_TOTAL_BUDGET = 3500`; oversized entries are skipped, not cut
   mid-sentence.
4. Format a short “用户长期记忆” block with title/content, mark `[核心]` and source
   scope, and inject it as hidden prompt context. Do not present it as a user
   message or as a tool result.

### `memory_save` (model-initiated)

The model may save a durable preference/fact when the user states it explicitly.
Required fields include kind (`profile`/`preference`/`instruction`/`fact`), scope
(`global`/`datasource`), title, content, confidence, optional `core` and
datasource id. `profile`/`instruction` may be core; other kinds may not. Reject
secrets and blank/oversized content. A duplicate title/content merges or returns a
controlled conflict; never create two identical active rows.

### Extraction (after a successful run)

1. Trigger only after a successful terminal run when memory is enabled and
   `runs.memory_extracted_at` is null.
2. Skip if this run already wrote via `memory_save` (`sourceRunId` count > 0) or was
   replaced by a retry.
3. Run an independent, tool-less agent session with the same model as the run; pass
   a compact transcript and the extraction prompt. Cap output at 3 memories.
4. Validate each item: allowed kind/scope, confidence threshold, no secrets, no SQL
   results/table lists/transient filters. Low-confidence items may be stored but are
   not injected; invalid items are dropped.
5. Persist `sourceConversationId`/`sourceRunId`, mark `memory_extracted_at` even when
   nothing was extracted, and never fail the run because extraction failed.

## Contracts

- **Owner isolation is absolute.** Every read/write filters `userId`; the model
  cannot read another user’s memory. Admin global disable is not a content browser.
- **Memory is untrusted text.** It can contain prompt injection; label it as
  background, keep it below system/tool rules, and never let it grant permissions or
  change datasource scope.
- **Scope is enforced at recall.** A datasource-scoped memory is injected only when
  the run’s datasource matches; a global memory may appear anywhere.
- **Budgets are character budgets, not token estimates.** Keep the constants and
  tests in sync.
- **Extraction is best-effort.** It must not block run completion, alter run status,
  or emit user-visible errors. It may be disabled globally and must respect the
  user’s setting.
- **Do not store query results or schema dumps.** Those belong to artifacts/schema
  cache. Memory is for durable user preferences/facts.
- **Clear means clear.** User clear deletes only their memories and resets settings
  appropriately; it must not touch another owner.

## Failure behavior

| Case | Behavior |
| --- | --- |
| Global/user memory off | No recall, no tool writes, no extraction |
| No relevant memory | Inject nothing (no empty headings) |
| Oversized/invalid memory | Skip at recall; validate on write |
| Secret detected | `MEMORY_SECRET_DETECTED`; do not store |
| Duplicate | Merge or `MEMORY_DUPLICATE`; no duplicate active row |
| Extraction/model failure | Log/ignore; run remains successful; retry next run |
| Run already wrote memory | Skip extraction for that run |

## Verification

```bash
pnpm exec vitest run apps/server/test/memory-recall.test.ts \
  apps/server/test/user-memories.test.ts \
  apps/server/test/memory-extraction.test.ts \
  apps/server/test/memory-routes.test.ts \
  apps/server/test/agent-e2e.test.ts
```

A recall change needs a budget/scope test; an extraction change needs a test where
extraction fails without changing the run result.
