import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./AppShell";
import type { SessionUser } from "../lib/api";

const user: SessionUser = {
  id: "u-1",
  username: "alice",
  displayName: "Alice",
  role: "user",
  status: "active",
};

function renderShell(options?: { withTopbar?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ notifications: [], unread: 0 }))),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/chat"]}>
        <AppShell
          user={user}
          sidebar={<div>会话侧栏</div>}
          topbar={options?.withTopbar === false ? undefined : <span>顶栏标题</span>}
        >
          <div>主内容</div>
        </AppShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("AppShell desktop sidebar collapse", () => {
  it("collapses and expands the desktop sidebar and persists the preference", async () => {
    const browser = userEvent.setup();
    const { container, unmount } = renderShell();

    const aside = container.querySelector("aside");
    expect(aside).toHaveAttribute("data-collapsed", "false");
    expect(screen.queryByRole("button", { name: "展开侧边栏" })).not.toBeInTheDocument();

    await browser.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(aside).toHaveAttribute("data-collapsed", "true");
    expect(window.localStorage.getItem("datachat:sidebar-collapsed")).toBe("1");
    expect(screen.getByRole("button", { name: "展开侧边栏" })).toBeInTheDocument();

    // Reloading the shell honors the stored collapsed state.
    unmount();
    const remounted = renderShell();
    expect(remounted.container.querySelector("aside")).toHaveAttribute("data-collapsed", "true");

    await browser.click(screen.getByRole("button", { name: "展开侧边栏" }));
    expect(remounted.container.querySelector("aside")).toHaveAttribute("data-collapsed", "false");
    expect(window.localStorage.getItem("datachat:sidebar-collapsed")).toBe("0");
  });

  it("still exposes an expand button when topbar is omitted", async () => {
    window.localStorage.setItem("datachat:sidebar-collapsed", "1");
    const browser = userEvent.setup();
    const { container } = renderShell({ withTopbar: false });

    expect(container.querySelector("aside")).toHaveAttribute("data-collapsed", "true");
    await browser.click(screen.getByRole("button", { name: "展开侧边栏" }));
    expect(container.querySelector("aside")).toHaveAttribute("data-collapsed", "false");
  });
});
