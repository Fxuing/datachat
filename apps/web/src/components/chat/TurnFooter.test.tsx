import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TurnFooter } from "./TurnFooter";

const mocks = vi.hoisted(() => ({
  saveRunFeedback: vi.fn(),
  deleteRunFeedback: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  ...mocks,
}));

const usage = { input: 20_000, output: 6_800, cacheRead: 0, cacheWrite: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveRunFeedback.mockResolvedValue(undefined);
  mocks.deleteRunFeedback.mockResolvedValue(undefined);
});

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

  it("copies the assistant reply text", async () => {
    const user = userEvent.setup();
    render(<TurnFooter runId="run-1" status="ok" copyText="共 42 条记录" />);

    await user.click(screen.getByRole("button", { name: "复制回答" }));
    expect(await navigator.clipboard.readText()).toBe("共 42 条记录");
    expect(screen.getByRole("button", { name: "已复制回答" })).toBeInTheDocument();
  });

  it("saves a positive rating in one click and deletes it when clicked again", async () => {
    const user = userEvent.setup();
    render(<TurnFooter runId="run-1" status="ok" />);

    const like = screen.getByRole("button", { name: "有帮助" });
    await user.click(like);

    await waitFor(() =>
      expect(mocks.saveRunFeedback).toHaveBeenCalledWith("run-1", { rating: 1 }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(like).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "补充说明" })).toBeInTheDocument();

    await user.click(like);
    await waitFor(() => expect(mocks.deleteRunFeedback).toHaveBeenCalledWith("run-1"));
    expect(like).toHaveAttribute("aria-pressed", "false");
  });

  it("opens the comment dialog on negative feedback", async () => {
    const user = userEvent.setup();
    render(<TurnFooter runId="run-1" status="ok" />);

    await user.click(screen.getByRole("button", { name: "没有帮助" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/补充说明/), "口径不对");
    await user.click(screen.getByRole("button", { name: "保存评价" }));

    await waitFor(() =>
      expect(mocks.saveRunFeedback).toHaveBeenCalledWith("run-1", {
        rating: -1,
        comment: "口径不对",
      }),
    );
  });
});
