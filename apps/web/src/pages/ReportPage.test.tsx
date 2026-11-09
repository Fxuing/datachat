import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReportDetail } from "@datachat/shared";
import ReportPage from "./ReportPage";
import type { ArtifactDetail, SessionUser } from "../lib/api";

const user: SessionUser = {
  id: "u-1",
  username: "alice",
  displayName: "Alice",
  role: "user",
  status: "active",
};

const report: ReportDetail = {
  id: "r-1",
  conversationId: "c-1",
  title: "分析报告 2026-11-06 09:05",
  markdown: "## 概览\n\n[[artifact:art-1]]\n\n以上是本周数据。",
  artifactIds: ["art-1"],
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_000,
};

const artifact: ArtifactDetail = {
  id: "art-1",
  kind: "result",
  conversationId: "c-1",
  rowCount: 2,
  truncated: false,
  columns: [
    { name: "name", type: "string" },
    { name: "amount", type: "number" },
  ],
  createdAt: 1_760_000_000_000,
  spec: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface MockOptions {
  reportStatus?: number;
  confirmDelete?: boolean;
}

function stubFetch(options: MockOptions = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/auth/me") return jsonResponse({ user });
    if (url === "/api/conversations") {
      return jsonResponse({ items: [], nextCursor: null });
    }
    if (url.startsWith("/api/reports/") && (init?.method ?? "GET") === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url === "/api/reports/r-1") {
      if (options.reportStatus && options.reportStatus !== 200) {
        return jsonResponse(
          { error: { code: "NOT_FOUND", message: "报告不存在" } },
          options.reportStatus,
        );
      }
      return jsonResponse({ report });
    }
    if (url.startsWith("/api/reports/")) {
      return jsonResponse({ error: { code: "NOT_FOUND", message: "报告不存在" } }, 404);
    }
    if (url === "/api/artifacts/art-1") return jsonResponse(artifact);
    if (url === "/api/artifacts/art-1/rows?limit=100") {
      return jsonResponse({
        columns: artifact.columns,
        rows: [
          ["alice", 42],
          ["bob", 7],
        ],
        total: 2,
      });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  if (options.confirmDelete !== undefined) {
    vi.spyOn(window, "confirm").mockReturnValue(options.confirmDelete);
  }
  return fetchMock;
}

function renderPage(path = "/reports/r-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reports/:id" element={<ReportPage />} />
          <Route path="/chat" element={<div>chat-home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(window, "print").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReportPage", () => {
  it("renders the title and replaces artifact placeholders with a table", async () => {
    stubFetch();
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "分析报告 2026-11-06 09:05" }),
    ).toBeInTheDocument();
    expect(await screen.findByRole("columnheader", { name: "amount" })).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("以上是本周数据。")).toBeInTheDocument();
    expect(screen.queryByText(/\[\[artifact:/)).not.toBeInTheDocument();
  });

  it("shows a placeholder for an unknown artifact", async () => {
    stubFetch();
    const unknownReport: ReportDetail = {
      ...report,
      markdown: "[[artifact:missing-artifact]]",
      artifactIds: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") return jsonResponse({ user });
      if (url === "/api/conversations") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/api/reports/r-1") return jsonResponse({ report: unknownReport });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    expect(await screen.findByText("结果不可用，可能已被删除。")).toBeInTheDocument();
    expect(screen.getByText(/missing-artifact/)).toBeInTheDocument();
  });

  it("calls window.print from the toolbar", async () => {
    stubFetch();
    const browser = userEvent.setup();
    renderPage();

    await screen.findByRole("heading", { name: report.title });
    await browser.click(screen.getByRole("button", { name: "打印" }));

    expect(window.print).toHaveBeenCalledTimes(1);
  });

  it("confirms before deleting and returns to chat", async () => {
    const fetchMock = stubFetch({ confirmDelete: true });
    const browser = userEvent.setup();
    renderPage();

    await screen.findByRole("heading", { name: report.title });
    await browser.click(screen.getByRole("button", { name: "删除" }));

    const dialog = await screen.findByRole("dialog", { name: "删除报告" });
    await browser.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/reports/r-1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(await screen.findByText("chat-home")).toBeInTheDocument();
  });

  it("does not delete when the confirmation is cancelled", async () => {
    const fetchMock = stubFetch({ confirmDelete: false });
    const browser = userEvent.setup();
    renderPage();

    await screen.findByRole("heading", { name: report.title });
    await browser.click(screen.getByRole("button", { name: "删除" }));

    const dialog = await screen.findByRole("dialog", { name: "删除报告" });
    await browser.click(within(dialog).getByRole("button", { name: "取消" }));

    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/reports/r-1" &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("shows the not-found state for a missing report", async () => {
    stubFetch({ reportStatus: 404 });
    renderPage("/reports/r-1");

    expect(await screen.findByText("报告不存在或已被删除。")).toBeInTheDocument();
  });
});
