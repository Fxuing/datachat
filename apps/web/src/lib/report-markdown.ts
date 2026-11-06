export type ReportSegment =
  | { type: "markdown"; content: string }
  | { type: "artifact"; artifactId: string };

const ARTIFACT_PLACEHOLDER = /\[\[artifact:([^\]\s]+)\]\]/g;

/**
 * Split report markdown into prose and artifact placeholders so the page can
 * render each `[[artifact:<id>]]` as a chart/table card instead of literal text.
 */
export function parseReportMarkdown(markdown: string): ReportSegment[] {
  const segments: ReportSegment[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(ARTIFACT_PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ type: "markdown", content: markdown.slice(cursor, index) });
    }
    const artifactId = match[1]?.trim();
    if (artifactId) {
      segments.push({ type: "artifact", artifactId });
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
