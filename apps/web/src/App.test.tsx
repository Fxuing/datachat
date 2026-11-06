import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { Conversation, ConversationDetail, DatasourceSummary, SessionUser } from "./lib/api";

const user: SessionUser = {
  id: "u-1",
  username: "alice",
  displayName: "Alice",
  role: "user",
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

const conversation: Conversation = {
  id: "c-1",
  datasourceId: datasource.id,
  title: "第一会话",
  modelId: null,
  thinkingLevel: "medium",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  lastMessageAt: null,
};

const detail: ConversationDetail = {
  conversation,
  messages: [],
  activeRun: { id: "run-1", status: "running" },
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener() {}
  close() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  window.history.pushState({}, "", "/chat");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app routes", () => {
  it("creates a conversation, lands on /chat/:id and resumes its active run", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") return jsonResponse({ user });
      if (url === "/api/models") {
        return jsonResponse({ configured: false, models: [], defaultId: null });
      }
      if (url === "/api/conversations" && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ items: [], nextCursor: null });
      }
      if (url === "/api/datasources") return jsonResponse({ datasources: [datasource] });
      if (url === "/api/conversations" && init?.method === "POST") {
        return jsonResponse({ conversation }, 201);
      }
      if (url === `/api/conversations/${conversation.id}`) return jsonResponse(detail);
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const browser = userEvent.setup();

    render(<App />);

    await browser.click(
      await screen.findByRole("button", { name: "新建对话" }, { timeout: 5_000 }),
    );
    const createButton = await screen.findByRole(
      "button",
      { name: "创建并开始对话" },
      { timeout: 5_000 },
    );
    await waitFor(() => expect(createButton).toBeEnabled());
    await browser.click(createButton);

    expect(await screen.findByText("第一会话", {}, { timeout: 5_000 })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${conversation.id}`));
    await waitFor(() =>
      expect(FakeEventSource.instances.map((instance) => instance.url)).toContain(
        "/api/runs/run-1/stream",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
