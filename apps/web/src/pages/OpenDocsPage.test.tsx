import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import OpenDocsPage from "./OpenDocsPage";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "59" },
  });
}

describe("OpenDocsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders public developer docs without login, injects API key into snippets, and runs Try-It-Out", async () => {
    const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer dc_open_demo_key_123");
      expect(init?.credentials).toBe("omit");

      if (url === "/api/open/v1/datasources") {
        return jsonResponse({
          items: [
            { id: "ds-100", name: "电商主库", type: "mysql", status: "ok", dataScopeMode: "off" },
          ],
        });
      }
      if (url === "/api/open/v1/mcp") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "ask_data" }] },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/open-docs"]}>
        <Routes>
          <Route path="/open-docs" element={<OpenDocsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("DataChat 开放平台接入文档")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /OpenAPI 3\.1 JSON/ })).toHaveAttribute(
      "href",
      "/api/open/v1/openapi.json",
    );

    // Fill API key -> updates snippets and enables Try-It-Out
    const keyInput = screen.getByPlaceholderText("dc_open_...");
    await user.type(keyInput, "dc_open_demo_key_123");
    expect(screen.getAllByText(/dc_open_demo_key_123/).length).toBeGreaterThan(0);

    // Run "1. 获取可用数据源"
    await user.click(screen.getByRole("button", { name: /1\. 获取可用数据源/ }));
    expect((await screen.findAllByText(/电商主库/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("HTTP 200")).toBeInTheDocument();

    // Run "2. 探测 MCP 工具列表"
    await user.click(screen.getByRole("button", { name: /2\. 探测 MCP 工具列表/ }));
    expect(await screen.findByText("POST /api/open/v1/mcp (tools/list)")).toBeInTheDocument();
    expect((await screen.findAllByText(/ask_data/)).length).toBeGreaterThanOrEqual(2);
  });
});
