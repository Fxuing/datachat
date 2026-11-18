# Chat UI: messages, segments, results and scrolling

The chat page renders one conversation, consumes the live run stream, and turns
assistant markdown into text, charts, reports, artifacts and inline result links.
Server-side queue/events are in [Chat runtime](chat-runtime.md).

## Responsibilities and sources of truth

| Part | Responsibility | Source |
| --- | --- | --- |
| Page state | Conversation/messages/run queries, composer, active stream | [`ChatPage.tsx`](../../apps/web/src/pages/ChatPage.tsx) |
| Stream | Reconnect, replay, merge events by sequence, cancel/cleanup | [`useRunStream.ts`](../../apps/web/src/hooks/useRunStream.ts) |
| Message list | Ordering, scroll anchoring, streaming tail, “new content” | [`MessageList.tsx`](../../apps/web/src/components/chat/MessageList.tsx), [`message-scroll.ts`](../../apps/web/src/lib/message-scroll.ts) |
| One message | Markdown, segments, trace, usage, actions | [`MessageItem.tsx`](../../apps/web/src/components/chat/MessageItem.tsx) |
| Parser | Split markdown/artifact/chart/result segments | [`report-markdown.ts`](../../apps/web/src/lib/report-markdown.ts) |
| Data table | Preview, load more, export, SQL details | [`ResultTable.tsx`](../../apps/web/src/components/chat/ResultTable.tsx), [`ResultDetailDialog.tsx`](../../apps/web/src/components/chat/ResultDetailDialog.tsx) |
| Inline result | Link + detail dialog | [`ResultLink.tsx`](../../apps/web/src/components/chat/ResultLink.tsx) |
| Charts | Render validated chart spec | [`ChartCard.tsx`](../../apps/web/src/components/chat/ChartCard.tsx) |
| Reports | Report artifact card/link | [`ReportPage.tsx`](../../apps/web/src/pages/ReportPage.tsx) |

React Query is the server-state cache; use `queryKeys` from `lib/query.ts` and
`apiRequest` from `lib/api.ts`. Do not fetch in effects when a query/mutation fits.

## Runtime path

1. `ChatPage` loads the conversation and message history. The server returns
   messages assembled from `runs`/`run_events`; active runs include replayable
   events for reload.
2. Sending a message enqueues a run (202), sets the active run id, and lets
   `useRunStream` open the SSE stream. The composer stays disabled until terminal.
3. Events are merged by `seq`: text/thinking deltas append to the streaming turn;
   tool events become trace rows; artifacts/charts/reports are attached to the run;
   `run_end` finalizes status/usage/error.
4. On reload/reconnect the hook replays after the last seen sequence, so persisted
   and live events are not duplicated. A disconnected stream shows reconnect UI;
   the run continues server-side.
5. The completed turn is invalidated/refetched; the persisted message replaces the
   local streaming representation. MessageList keeps the reader’s scroll anchor
   unless the user was pinned to the bottom.

## Message segment contract

Assistant text is split by `parseChatMarkdown` into:

- `markdown` — prose, tables, Mermaid, ordinary code fences;
- `artifact` — `[[artifact:<id>]]`, rendered as a result/report card;
- `chart` — `[[chart:<id>]]`, rendered from the chart artifact;
- `result` — `[[result:<id>]]`, chat-only inline link to a current result.

`parseReportMarkdown` intentionally leaves `[[result:...]]` as literal text
(reports use artifacts). When adding a marker or segment:

1. Extend the parser and its types.
2. Update `MessageItem` and the streaming branch in `MessageList`; update
   `parseReportMarkdown` behavior if reports/shares can receive it.
3. Handle incomplete/unknown ids without crashing: fall back to visible text or a
   controlled “unavailable” card.
4. Ensure a referenced artifact is not also rendered as a standalone card.
5. Add parser tests, one render test per consumer, and a streaming test.

Mermaid fences are rendered by `MermaidDiagram` in chat, report and public share;
keep the source fallback and strict security level.

## Layout and interaction contracts

- The message area is the scroll owner. The composer is not sticky inside it; it
  sits below and must not cover the last row.
- While streaming: stay pinned only if the user was at/near the bottom. If the user
  scrolls up, freeze and show “new content”; clicking returns to bottom. Switching
  conversations restores each conversation’s saved position.
- Long tables scroll horizontally; use `min-w-0`/`overflow-x-auto` on every flex/grid
  ancestor. Do not rely on `truncate` alone to shrink a table.
- Result preview is bounded; “load more” appends pages and export streams the full
  artifact. Never fetch all rows to render the initial card.
- Streaming text may contain a partial `[[artifact:`/`[[chart:`/`[[result:` token;
  hide it until complete instead of rendering raw syntax.
- Use the shared `Button`/`Dialog`/`Sheet` primitives, native `title` only via the
  `Tooltip` component, and accessible names for icon-only buttons.

## Failure behavior

- SSE 401/404: stop reconnecting, surface an error; do not spin.
- Network drop: retry with backoff; replay from last sequence; keep the partial
  turn visible.
- Unknown artifact/result id: show an unavailable state, not a blank card.
- Failed run: keep the trace, show error and retry/change-model actions; retry
  replaces the failed turn via `retry_of_run_id`.
- Malformed chart/report JSON: show the error/fallback; one bad artifact must not
  crash the message list.

## Verification

```bash
pnpm --filter @datachat/web exec vitest run \
  src/lib/report-markdown.test.ts \
  src/components/chat/MessageItem.test.tsx \
  src/components/chat/MessageList.test.tsx \
  src/components/chat/ConversationSidebar.test.tsx \
  src/pages/ChatPage.test.tsx
pnpm --filter @datachat/web typecheck
```

For a visual change, check at desktop and narrow widths, with a long table, while
streaming, and after reload. A segment change needs a streaming partial-marker test.
