import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ChatPage from "./ChatPage";
import type {
  ChatMessage,
  Conversation,
  ConversationDetail,
  DatasourceSummary,
  SessionUser,
} from "../lib/api";
import type { Permission } from "@datachat/shared";

const user: SessionUser = {
  id: "u-1",
  username: "alice",
  displayName: "Alice",
  role: "user",
  status: "active",
};

const conversation: Conversation = {
  id: "c-1",
  datasourceId: "ds-1",
  title: "权限测试会话",
  modelId: null,
  thinkingLevel: "off",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  lastMessageAt: null,
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
  allowWriteAccount: false,
  lastCheckedAt: null,
};

const message: ChatMessage = {
  runId: "run-1",
  status: "ok",
  user: { content: "统计用户" },
  assistant: { content: "共 1 行" },
  tools: [],
  results: [
    {
      artifactId: "art-1",
      columns: [{ name: "name", type: "string" }],
      rows: [["alice"]],
      rowCount: 1,
      truncated: false,
    },
  ],
  sqls: [],
  error: null,
  createdAt: 2,
};

const detail: ConversationDetail = {
  conversation,
  messages: [message],
  artifacts: [],
  activeRun: null,
};

const FUNCTIONAL_PERMISSIONS: Permission[] = [
  "chat.use",
  "skill.use",
  "mcp.use",
  "report.create",
  "share.create",
  "export.data",
];

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(permissions: Permission[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/auth/me") return jsonResponse({ user, permissions, roles: [] });
    if (url === "/api/conversations") return jsonResponse({ items: [], nextCursor: null });
    if (url === "/api/datasources") return jsonResponse({ datasources: [datasource] });
    if (url === "/api/models") {
      return jsonResponse({ configured: false, models: [], defaultId: null });
    }
    if (url === "/api/conversations/c-1") return jsonResponse(detail);
    if (url === "/api/conversations/c-1/skills") {
      return jsonResponse({
        skills: [{ name: "sales-report", description: "销售分析", scope: "global" }],
      });
    }
    if (url === "/api/conversations/c-1/messages" && init?.method === "POST") {
      return jsonResponse({ runId: "run-2", position: 0 }, 201);
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderChatPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/chat/c-1"]}>
        <Routes>
          <Route path="/chat/:conversationId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatPage permission gates", () => {
  it("locks the composer, hides share/report, and disables exports without chat.use", async () => {
    const fetchMock = stubFetch([]);
    const browser = userEvent.setup();
    renderChatPage();

    expect(await screen.findByText("权限测试会话")).toBeInTheDocument();

    const composer = screen.getByRole("textbox", { name: "输入问题" });
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute("placeholder", "当前角色没有对话权限，请联系管理员");
    expect(screen.queryByRole("button", { name: "分享" })).not.toBeInTheDocument();

    await browser.click(screen.getByRole("button", { name: "查看数据" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "alice" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成报告" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "下载 CSV" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 CSV" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载 Excel" })).toBeDisabled();

    const requested = fetchMock.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input.toString(),
    );
    expect(requested).not.toContain("/api/conversations/c-1/skills");
  });

  it("keeps skills, sharing, reports and exports available to functional roles", async () => {
    const fetchMock = stubFetch(FUNCTIONAL_PERMISSIONS);
    const browser = userEvent.setup();
    renderChatPage();

    expect(await screen.findByText("权限测试会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分享" })).toBeInTheDocument();

    const composer = screen.getByRole("textbox", { name: "输入问题" });
    expect(composer).toBeEnabled();
    await browser.type(composer, "/");
    expect(await screen.findByRole("option", { name: /sales-report/ })).toBeInTheDocument();
    await browser.click(screen.getByRole("option", { name: /sales-report/ }));
    await browser.type(composer, "本月销售");
    await browser.click(screen.getByRole("button", { name: "发送" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/c-1/messages",
      expect.objectContaining({ method: "POST" }),
    );

    await browser.click(screen.getByRole("button", { name: "查看数据" }));
    expect(screen.getByRole("button", { name: "生成报告" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 CSV" })).toHaveAttribute(
      "href",
      "/api/artifacts/art-1/download?format=csv",
    );
  });

  it("switches conversations without duplicate React key warnings and resets composer draft", async () => {
    const conversation2: Conversation = {
      ...conversation,
      id: "c-2",
      title: "第二会话",
    };
    const detail2: ConversationDetail = {
      conversation: conversation2,
      messages: [
        {
          ...message,
          runId: "run-2",
          user: { content: "第二个问题" },
          assistant: { content: "第二个回答" },
          results: [],
        },
      ],
      artifacts: [],
      activeRun: null,
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") {
        return jsonResponse({ user, permissions: FUNCTIONAL_PERMISSIONS, roles: [] });
      }
      if (url === "/api/conversations") {
        return jsonResponse({ items: [conversation, conversation2], nextCursor: null });
      }
      if (url === "/api/datasources") return jsonResponse({ datasources: [datasource] });
      if (url === "/api/models") {
        return jsonResponse({ configured: false, models: [], defaultId: null });
      }
      if (url === "/api/notifications") return jsonResponse({ notifications: [], unread: 0 });
      if (url === "/api/conversations/c-1") return jsonResponse(detail);
      if (url === "/api/conversations/c-2") return jsonResponse(detail2);
      if (url === "/api/conversations/c-1/skills" || url === "/api/conversations/c-2/skills") {
        return jsonResponse({ skills: [] });
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const browser = userEvent.setup();
    renderChatPage();

    expect(await screen.findByText("共 1 行")).toBeInTheDocument();
    const composer = screen.getByRole("textbox", { name: "输入问题" });
    await browser.type(composer, "未发送的草稿");
    expect(composer).toHaveValue("未发送的草稿");

    await browser.click(await screen.findByRole("button", { name: /第二会话/ }));

    expect(await screen.findByText("第二个回答")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "输入问题" })).toHaveValue("");
    const duplicateKeyCalls = errorSpy.mock.calls.filter((args) =>
      args.some((arg) => typeof arg === "string" && arg.includes("same key")),
    );
    expect(duplicateKeyCalls).toEqual([]);
    errorSpy.mockRestore();
  });
});
