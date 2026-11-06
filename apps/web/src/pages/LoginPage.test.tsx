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
    if (url === "/api/auth/me") return jsonResponse({ user });
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("LoginPage", () => {
  it("logs in, loads the session and redirects to /chat", async () => {
    const fetchMock = mockFetch(() => jsonResponse({ user }));
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
    const fetchMock = mockFetch(() => jsonResponse({ user }));
    const browser = userEvent.setup();

    renderLoginPage();
    await browser.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请输入用户名和密码");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
