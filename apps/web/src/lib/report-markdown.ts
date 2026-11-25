export type ReportSegment =
  | { type: "markdown"; content: string }
  | { type: "artifact"; artifactId: string }
  | { type: "chart"; artifactId: string };

export type ResultSegment = { type: "result"; artifactId: string; label?: string };
export type ExcelSegment = { type: "excel"; artifactId: string };
export type ChatSegment = ReportSegment | ResultSegment | ExcelSegment;
export type GroupedChatSegment =
  | ReportSegment
  | ExcelSegment
  | { type: "result_group"; items: ResultSegment[] };

const INLINE_PLACEHOLDER = /\[\[(artifact|chart|result|excel):([^\]\s|]+)(?:\|([^\]\r\n]*))?\]\]/g;

function parseSegments(markdown: string, includeChatOnly: boolean): ChatSegment[] {
  const segments: ChatSegment[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(INLINE_PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ type: "markdown", content: markdown.slice(cursor, index) });
    }
    const kind = match[1];
    const artifactId = match[2]?.trim();
    const rawLabel = match[3];
    if (
      !artifactId ||
      (kind !== "result" && rawLabel !== undefined) ||
      ((kind === "result" || kind === "excel") && !includeChatOnly)
    ) {
      segments.push({ type: "markdown", content: match[0] });
    } else if (kind === "chart") {
      segments.push({ type: "chart", artifactId });
    } else if (kind === "excel") {
      segments.push({ type: "excel", artifactId });
    } else if (kind === "result") {
      const label = rawLabel?.trim();
      segments.push(
        label
          ? { type: "result", artifactId, label }
          : { type: "result", artifactId },
      );
    } else {
      segments.push({ type: "artifact", artifactId });
    }
    cursor = index + match[0].length;
  }
  if (cursor < markdown.length) {
    segments.push({ type: "markdown", content: markdown.slice(cursor) });
  }
  return segments;
}

export function groupChatSegments(segments: ChatSegment[]): GroupedChatSegment[] {
  const grouped: GroupedChatSegment[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment.type !== "result") {
      grouped.push(segment);
      continue;
    }
    const items: ResultSegment[] = [segment];
    let cursor = i + 1;
    while (cursor < segments.length) {
      let peek = cursor;
      while (peek < segments.length) {
        const peekSegment = segments[peek];
        if (peekSegment?.type !== "markdown" || peekSegment.content.trim()) {
          break;
        }
        peek += 1;
      }
      const next = segments[peek];
      if (next?.type === "result") {
        items.push(next);
        cursor = peek + 1;
      } else {
        break;
      }
    }
    grouped.push({ type: "result_group", items });
    i = cursor - 1;
  }
  return grouped;
}

/**
 * Split report markdown into prose and artifact placeholders so the page can
 * render each `[[artifact:<id>]]` / `[[chart:<id>]]` as a card instead of
 * literal text. `[[result:<id>]]` and `[[excel:<id>]]` are chat-only and stay
 * literal here.
 */
export function parseReportMarkdown(markdown: string): ReportSegment[] {
  return parseSegments(markdown, false) as ReportSegment[];
}

/**
 * Split a chat reply into prose, artifact/chart/excel placeholders, and chat-only
 * `[[result:<id>]]` links that open the complete result table.
 */
export function parseChatMarkdown(markdown: string): ChatSegment[] {
  return parseSegments(markdown, true);
}

/**
 * Collect artifact/chart ids bundled into succeeded `create_report` tool calls
 * so chat replies don't append unreferenced report-only charts below
 * `[查看完整报告]`.
 */
export function reportArtifactIdsFromTools(
  tools: ReadonlyArray<{ name: string; status: string; args: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const tool of tools) {
    if (tool.name !== "create_report" || tool.status !== "ok") continue;
    if (!tool.args || typeof tool.args !== "object" || Array.isArray(tool.args)) {
      continue;
    }
    const artifactIds = (tool.args as { artifactIds?: unknown }).artifactIds;
    if (!Array.isArray(artifactIds)) continue;
    for (const id of artifactIds) {
      if (typeof id !== "string") continue;
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return ids;
}
