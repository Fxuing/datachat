import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import McpPage from "./McpPage";
import type { AdminMcpServer, DatasourceSummary, SessionUser } from "../../lib/api";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

const datasource: DatasourceSummary = {
  id: "ds-1",
  name: "demo",
  type: "mysql",
  host: "127.0.0.1",
  port: 3306,
  database: "demo",
  username: "demo",
  sslMode: "disable",
  status: "ok",
  readOnlyVerified: true,
  lastCheckedAt: null,
};

const stdioServer: AdminMcpServer = {
  id: "m-1",
  name: "github-tools",
  transport: "stdio",
  scope: "global",
  datasourceId: null,
  command: "node",
  args: ["server.mjs", "--flag"],
  url: null,
  env: [{ key: "API_TOKEN", hasValue: true }],
  headers: [],
  enabled: true,
  createdAt: "2026-11-01T00:00:00.000Z",
};

const testTools = [
  { name: "echo", description: "Echo the given text" },
  { name: "add", description: "Add two numbers" },
  { name: "now", description: "" },
  { name: "search", description: "Search repositories" },
  { name: "fetch", description: "Fetch a file" },
  { name: "hidden", description: "Should not be listed" },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Override = (url: string, method: string) => Response | undefined;

function stubApi(override?: Override) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const custom = override?.(url, method);
    if (custom) return custom;

    if (url === "/api/auth/me") return jsonResponse({ user: admin });
    if (url === "/api/datasources") return jsonResponse({ datasources: [datasource] });
    if (url === "/api/admin/mcp-servers" && method === "GET") {
      return jsonResponse({ servers: [stdioServer] });
    }
    if (url === "/api/admin/mcp-servers" && method === "POST") {
      return jsonResponse({ server: { ...stdioServer, id: "m-2", name: "local-tools" } }, 201);
    }
    if (url === "/api/admin/mcp-servers/m-1" && method === "GET") {
      return jsonResponse({ server: stdioServer });
    }
    if (url === "/api/admin/mcp-servers/m-1" && method === "PATCH") {
      return jsonResponse({ server: stdioServer });
    }
    if (url === "/api/admin/mcp-servers/m-1" && method === "DELETE") {
      return jsonResponse({ ok: true });
    }
    if (url === "/api/admin/mcp-servers/m-1/test" && method === "POST") {
      return jsonResponse({
        ok: true,
        tools: testTools,
        serverInfo: { name: "fake-mcp", version: "0.1.0" },
      });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/admin/mcp"]}>
        <Routes>
          <Route path="/admin/mcp" element={<McpPage />} />
          <Route path="/chat" element={<div>聊天页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function requestCall(
  fetchMock: ReturnType<typeof stubApi>,
  path: string,
  method: string,
): [RequestInfo | URL, RequestInit?] | undefined {
  return fetchMock.mock.calls.find(
    ([input, init]) => String(input) === path && (init?.method ?? "GET") === method,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("McpPage", () => {
  it("lists servers and switches the editor between transports", async () => {
    stubApi();
    const browser = userEvent.setup();
    renderPage();

    expect(await screen.findByText("github-tools")).toBeInTheDocument();
    expect(screen.getByText("node server.mjs --flag")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();

    await browser.click(screen.getByRole("button", { name: "新建 MCP 服务器" }));
    const dialog = await screen.findByRole("dialog", { name: "新建 MCP 服务器" });

    expect(within(dialog).getByLabelText("命令")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("参数（每行一个）")).toBeInTheDocument();
    expect(within(dialog).getByText("环境变量")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("URL")).not.toBeInTheDocument();

    await browser.click(within(dialog).getByRole("button", { name: "HTTP（远程地址）" }));
    expect(within(dialog).getByLabelText("URL")).toBeInTheDocument();
    expect(within(dialog).getByText("请求头")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("命令")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("环境变量")).not.toBeInTheDocument();

    await browser.click(within(dialog).getByRole("button", { name: "stdio（本地命令）" }));
    expect(within(dialog).getByLabelText("命令")).toBeInTheDocument();
  });

  it("creates a stdio server with args, env and a datasource scope", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "新建 MCP 服务器" }));
    const dialog = await screen.findByRole("dialog", { name: "新建 MCP 服务器" });

    await browser.type(within(dialog).getByLabelText("名称"), "local-tools");
    await browser.type(within(dialog).getByLabelText("命令"), "node");
    await browser.type(within(dialog).getByLabelText("参数（每行一个）"), "server.mjs{enter}--verbose");
    await browser.type(within(dialog).getByLabelText("环境变量键 1"), "API_TOKEN");
    await browser.type(within(dialog).getByLabelText("环境变量值 1"), "s3cret");
    await browser.selectOptions(within(dialog).getByLabelText("数据源"), datasource.id);
    await browser.click(within(dialog).getByLabelText("启用"));

    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(requestCall(fetchMock, "/api/admin/mcp-servers", "POST")).toBeDefined();
    });
    const call = requestCall(fetchMock, "/api/admin/mcp-servers", "POST");
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      name: "local-tools",
      transport: "stdio",
      enabled: false,
      datasourceId: datasource.id,
      command: "node",
      args: ["server.mjs", "--verbose"],
      env: { API_TOKEN: "s3cret" },
      url: null,
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "新建 MCP 服务器" })).not.toBeInTheDocument(),
    );
  });

  it("keeps stored env values when the field stays blank and appends new keys", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });

    expect(within(dialog).getByLabelText("环境变量键 1")).toHaveValue("API_TOKEN");
    expect(within(dialog).getByLabelText("环境变量键 1")).toBeDisabled();
    expect(within(dialog).getByLabelText("环境变量值 1")).toHaveValue("");

    await browser.click(within(dialog).getByRole("button", { name: "添加环境变量" }));
    await browser.type(within(dialog).getByLabelText("环境变量键 2"), "NEW_KEY");
    await browser.type(within(dialog).getByLabelText("环境变量值 2"), "new-value");

    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(requestCall(fetchMock, "/api/admin/mcp-servers/m-1", "PATCH")).toBeDefined();
    });
    const call = requestCall(fetchMock, "/api/admin/mcp-servers/m-1", "PATCH");
    const body = JSON.parse(String(call![1]!.body)) as Record<string, unknown>;
    expect(body.env).toEqual({ API_TOKEN: null, NEW_KEY: "new-value" });
    expect(body.transport).toBe("stdio");
    expect(body.command).toBe("node");
    expect(body.args).toEqual(["server.mjs", "--flag"]);
  });

  it("renders the tool count and the first five tools after a connection test", async () => {
    stubApi();
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });

    await browser.click(within(dialog).getByRole("button", { name: "测试连接" }));

    expect(await within(dialog).findByText(/发现 6 个工具/)).toBeInTheDocument();
    expect(within(dialog).getByText(/fake-mcp 0\.1\.0/)).toBeInTheDocument();
    for (const tool of testTools.slice(0, 5)) {
      expect(within(dialog).getByText(tool.name)).toBeInTheDocument();
    }
    expect(within(dialog).queryByText("hidden")).not.toBeInTheDocument();
    expect(within(dialog).getByText("仅显示前 5 个。")).toBeInTheDocument();
  });

  it("shows a sanitized failure message when the connection test fails", async () => {
    stubApi((url, method) =>
      url === "/api/admin/mcp-servers/m-1/test" && method === "POST"
        ? jsonResponse({
            ok: false,
            tools: [],
            error: "连接超时：15 秒内未完成 tools/list",
          })
        : undefined,
    );
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP 服务器" });

    await browser.click(within(dialog).getByRole("button", { name: "测试连接" }));

    expect(
      await within(dialog).findByText("连接失败：连接超时：15 秒内未完成 tools/list"),
    ).toBeInTheDocument();
  });
});
