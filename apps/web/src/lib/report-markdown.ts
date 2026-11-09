export type ReportSegment =
  | { type: "markdown"; content: string }
  | { type: "artifact"; artifactId: string }
  | { type: "chart"; artifactId: string };

const ARTIFACT_PLACEHOLDER = /\[\[(artifact|chart):([^\]\s]+)\]\]/g;

/**
 * Split markdown into prose and artifact placeholders so the page can render
 * each `[[artifact:<id>]]` / `[[chart:<id>]]` as a card instead of literal text.
 */
export function parseReportMarkdown(markdown: string): ReportSegment[] {
  const segments: ReportSegment[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(ARTIFACT_PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ type: "markdown", content: markdown.slice(cursor, index) });
    }
    const kind = match[1];
    const artifactId = match[2]?.trim();
    if (artifactId) {
      segments.push({ type: kind === "chart" ? "chart" : "artifact", artifactId });
    } else {
      segments.push({ type: "markdown", content: match[0] });
    }
    cursor = index + match[0].length;
  }
  if (cursor < markdown.length) {
    segments.push({ type: "markdown", content: markdown.slice(cursor) });
  }
  return segments;
}
