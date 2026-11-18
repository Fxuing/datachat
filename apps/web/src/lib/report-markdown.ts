export type ReportSegment =
  | { type: "markdown"; content: string }
  | { type: "artifact"; artifactId: string }
  | { type: "chart"; artifactId: string };

export type ResultSegment = { type: "result"; artifactId: string };
export type ChatSegment = ReportSegment | ResultSegment;

const INLINE_PLACEHOLDER = /\[\[(artifact|chart|result):([^\]\s]+)\]\]/g;

function parseSegments(markdown: string, includeResults: boolean): ChatSegment[] {
  const segments: ChatSegment[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(INLINE_PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ type: "markdown", content: markdown.slice(cursor, index) });
    }
    const kind = match[1];
    const artifactId = match[2]?.trim();
    if (!artifactId || (kind === "result" && !includeResults)) {
      segments.push({ type: "markdown", content: match[0] });
    } else if (kind === "chart") {
      segments.push({ type: "chart", artifactId });
    } else if (kind === "result") {
      segments.push({ type: "result", artifactId });
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

/**
 * Split report markdown into prose and artifact placeholders so the page can
 * render each `[[artifact:<id>]]` / `[[chart:<id>]]` as a card instead of
 * literal text. `[[result:<id>]]` is chat-only and stays literal here.
 */
export function parseReportMarkdown(markdown: string): ReportSegment[] {
  return parseSegments(markdown, false) as ReportSegment[];
}

/**
 * Split a chat reply into prose, artifact/chart placeholders, and chat-only
 * `[[result:<id>]]` links that open the complete result table.
 */
export function parseChatMarkdown(markdown: string): ChatSegment[] {
  return parseSegments(markdown, true);
}
