import { Children, isValidElement, type ReactNode } from "react";

const MERMAID_CLASS = "language-mermaid";

/**
 * Returns the chart source when a rendered `pre` holds a ```mermaid fence.
 *
 * `rehype-highlight` leaves unknown languages alone, so the code payload is
 * still a plain string instead of a tree of highlight spans.
 */
export function mermaidSourceOf(children: ReactNode): string | null {
  const [child] = Children.toArray(children);
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null;
  if (!child.props.className?.split(/\s+/).includes(MERMAID_CLASS)) return null;

  const source = child.props.children;
  return typeof source === "string" ? source.trim() : null;
}
