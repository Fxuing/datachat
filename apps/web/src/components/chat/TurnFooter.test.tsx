import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TurnFooter } from "./TurnFooter";

const usage = { input: 20_000, output: 6_800, cacheRead: 0, cacheWrite: 0 };

describe("TurnFooter", () => {
  it("reads as duration / tokens", () => {
    render(<TurnFooter runId="run-1" status="ok" durationMs={13_000} usage={usage} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("13s");
    expect(text).toContain("26.8k tokens");
    expect(text.indexOf("13s")).toBeLessThan(text.indexOf("26.8k tokens"));
    expect(text).toMatch(/13s\s*\/\s*26\.8k tokens/);
  });

  it("drops the separator when the trace already carries the duration", () => {
    render(<TurnFooter runId="run-1" status="ok" usage={usage} />);

    expect(screen.getByText("26.8k tokens")).toBeInTheDocument();
    expect(screen.queryByText("/")).not.toBeInTheDocument();
  });

  it("keeps the rating buttons out of the way until the turn is hovered", () => {
    render(<TurnFooter runId="run-1" status="ok" />);

    const group = screen.getByRole("button", { name: "有帮助" }).parentElement;
    expect(group?.className).toContain("opacity-0");
    expect(group?.className).toContain("group-hover/turn:opacity-100");
    expect(group?.className).toContain("focus-within:opacity-100");
  });

  it("keeps a rated turn showing which way it went", () => {
    render(
      <TurnFooter runId="run-1" status="ok" feedback={{ rating: 1, comment: null }} />,
    );

    const liked = screen.getByRole("button", { name: "有帮助" });
    expect(liked).toHaveAttribute("aria-pressed", "true");
    expect(liked.parentElement?.className).not.toContain("opacity-0");
  });
});
