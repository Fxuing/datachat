export interface ReportHeading {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

function cleanHeadingText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

export function headingId(text: string): string {
  const slug = cleanHeadingText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `section-${slug || "untitled"}`;
}

/** Extract h1–h3 headings, ignoring fenced code blocks. */
export function extractReportHeadings(markdown: string): ReportHeading[] {
  const headings: ReportHeading[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = cleanHeadingText(match[2] ?? "");
    if (!text) continue;
    headings.push({ id: headingId(text), text, level: match[1]!.length as 1 | 2 | 3 });
  }
  return headings;
}
