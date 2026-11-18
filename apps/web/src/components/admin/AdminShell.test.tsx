import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminShell } from "./AdminShell";
import type { SessionUser } from "../../lib/api";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

function renderShell(path: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ notifications: [], unread: 0 }))),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/admin/*"
            element={
              <AdminShell user={admin}>
                <div>内容</div>
              </AdminShell>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminShell", () => {
  it("collapses the access group and expands it on demand", async () => {
    const browser = userEvent.setup();
    renderShell("/admin/datasources");

    const toggle = screen.getByRole("button", { name: "权限管理" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "角色" })).not.toBeInTheDocument();

    await browser.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "角色" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "部门" })).toBeInTheDocument();
  });

  it("opens the access group when a child route is active", () => {
    renderShell("/admin/departments");

    expect(screen.getByRole("button", { name: "权限管理" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("link", { name: "部门" })).toHaveAttribute("aria-current", "page");
  });
});
