import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LoginPage from "./LoginPage";

const user = {
  id: "u-1",
  username: "alice",
  displayName: "Alice",
  role: "user" as const,
  status: "active" as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderLoginPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/chat" element={<div>聊天页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockFetch(loginResponse: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/auth/login") return loginResponse();
    if (url === "/api/auth/me") return jsonResponse({ user, permissions: [], roles: [] });
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("LoginPage", () => {
  it("logs in, loads the session and redirects to /chat", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ user, permissions: [], roles: [] }));
    const browser = userEvent.setup();

    renderLoginPage();
    await browser.type(screen.getByLabelText("用户名"), "alice");
    await browser.type(screen.getByLabelText("密码"), "secret");
    await browser.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByText("聊天页")).toBeInTheDocument();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual(["/api/auth/login", "/api/auth/me"]);
    const loginInit = fetchMock.mock.calls[0]![1];
    expect(loginInit?.method).toBe("POST");
    expect(JSON.parse(String(loginInit?.body))).toEqual({ username: "alice", password: "secret" });
  });

  it("shows the server error inline and stays on the login page", async () => {
    mockFetch(() =>
      jsonResponse({ error: { code: "AUTH_FAILED", message: "用户名或密码错误" } }, 401),
    );
    const browser = userEvent.setup();

    renderLoginPage();
    await browser.type(screen.getByLabelText("用户名"), "alice");
    await browser.type(screen.getByLabelText("密码"), "wrong");
    await browser.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("用户名或密码错误");
    expect(screen.queryByText("聊天页")).not.toBeInTheDocument();
  });

  it("validates empty fields without calling the server", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ user, permissions: [], roles: [] }));
    const browser = userEvent.setup();

    renderLoginPage();
    await browser.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请输入用户名和密码");
    expect(fetchMock).not.toHaveBeenCalled();

    await browser.type(screen.getByLabelText("用户名"), "a");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("toggles password visibility", async () => {
    mockFetch(() => jsonResponse({ user, permissions: [], roles: [] }));
    const browser = userEvent.setup();

    renderLoginPage();
    const passwordInput = screen.getByLabelText("密码");
    expect(passwordInput).toHaveAttribute("type", "password");

    await browser.click(screen.getByRole("button", { name: "显示密码" }));
    expect(passwordInput).toHaveAttribute("type", "text");

    await browser.click(screen.getByRole("button", { name: "隐藏密码" }));
    expect(passwordInput).toHaveAttribute("type", "password");
  });

  it("keeps both desktop backdrops mounted and reveals the dark curtain on theme toggle", async () => {
    mockFetch(() => jsonResponse({ user, permissions: [], roles: [] }));
    const browser = userEvent.setup();
    const { container } = renderLoginPage();

    const sources = Array.from(container.querySelectorAll('source[type="image/webp"]')).map((el) =>
      el.getAttribute("srcset"),
    );
    expect(sources).toEqual(["/login-bg.webp", "/login-bg-dark.webp"]);

    const darkLayer = screen.getByTestId("login-bg-dark-layer");
    const initial = darkLayer.getAttribute("data-revealed");
    expect(initial).toMatch(/^(true|false)$/);

    await browser.click(screen.getByRole("button", { name: /切换到(深|浅)色主题/ }));
    expect(darkLayer.getAttribute("data-revealed")).toBe(initial === "true" ? "false" : "true");

    // Restore initial theme so later tests are unaffected.
    await browser.click(screen.getByRole("button", { name: /切换到(深|浅)色主题/ }));
  });
});
