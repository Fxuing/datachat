import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const htmlExportMock = vi.hoisted(() => ({
  exportConversationHtml: vi.fn(async () => undefined),
}));

vi.mock("../lib/conversation-html-export", () => ({
  exportConversationHtml: htmlExportMock.exportConversationHtml,
}));

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
    if (url === "/api/datasources/ds-1/catalog") {
      return jsonResponse({
        datasourceId: "ds-1",
        refreshedAt: null,
        stale: false,
        tableCount: 0,
        scopeNotice: null,
        metrics: [],
        relations: [],
        starterQuestions: [],
      });
    }
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
      if (url === "/api/datasources/ds-1/catalog") {
        return jsonResponse({
          datasourceId: "ds-1",
          refreshedAt: null,
          stale: false,
          tableCount: 0,
          scopeNotice: null,
          metrics: [],
          relations: [],
          starterQuestions: [],
        });
      }
    if (url === "/api/datasources/ds-1/catalog") {
      return jsonResponse({
        datasourceId: "ds-1",
        refreshedAt: null,
        stale: false,
        tableCount: 0,
        scopeNotice: null,
        metrics: [],
        relations: [],
        starterQuestions: [],
      });
    }
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

  it("shows file tables badge and supports appending files in an existing file conversation", async () => {
    const fileConv: Conversation = {
      id: "c-file",
      sourceKind: "file",
      datasourceId: null,
      title: "8月销售分析",
      modelId: null,
      thinkingLevel: "off",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      lastMessageAt: null,
    };
    const file1 = {
      id: "f-1",
      conversationId: "c-file",
      fileName: "orders.csv",
      fileType: "csv" as const,
      sizeBytes: 512,
      headerRow: 1,
      tableCount: 1,
      rowCount: 2,
      createdAt: 1,
    };
    const table1 = {
      id: "t-1",
      conversationId: "c-file",
      fileId: "f-1",
      tableName: "orders",
      displayName: "orders",
      sheetName: null,
      rowCount: 2,
      columns: [
        {
          name: "订单号",
          originalName: "订单号",
          type: "TEXT" as const,
          nullable: false,
          sampleValues: ["001"],
        },
      ],
      sampleRows: [["001"]],
      warnings: [],
      createdAt: 1,
    };
    const file2 = { ...file1, id: "f-2", fileName: "targets.csv" };
    const table2 = { ...table1, id: "t-2", fileId: "f-2", tableName: "targets", displayName: "targets" };

    let appended = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") {
        return jsonResponse({ user, permissions: FUNCTIONAL_PERMISSIONS, roles: [], departmentNames: ["研发部"] });
      }
      if (url === "/api/conversations") {
        return jsonResponse({ items: [fileConv], nextCursor: null });
      }
      if (url === "/api/datasources") return jsonResponse({ datasources: [] });
      if (url === "/api/models") {
        return jsonResponse({ configured: false, models: [], defaultId: null });
      }
      if (url === "/api/conversations/c-file") {
        return jsonResponse({
          conversation: fileConv,
          messages: [],
          artifacts: [],
          files: appended ? [file1, file2] : [file1],
          tables: appended ? [table1, table2] : [table1],
          activeRun: null,
        });
      }
      if (url === "/api/conversations/c-file/skills") {
        return jsonResponse({ skills: [] });
      }
      if (url === "/api/conversations/c-file/files" && init?.method === "POST") {
        appended = true;
        return jsonResponse(
          {
            files: [file1, file2],
            tables: [table1, table2],
            addedFiles: [file2],
            addedTables: [table2],
          },
          201,
        );
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const browser = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/chat/c-file"]}>
          <Routes>
            <Route path="/chat/:conversationId" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const badge = await screen.findByRole("button", { name: /Excel \/ CSV · 1 张表/ });
    expect(screen.queryByText(/范围：研发部/)).not.toBeInTheDocument();

    await browser.click(badge);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();

    const extraFile = new File(["部门,目标\n华东,100"], "targets.csv", { type: "text/csv" });
    await browser.upload(screen.getByLabelText("追加上传 Excel 或 CSV 文件"), extraFile);

    expect(await screen.findByText("targets")).toBeInTheDocument();
    await browser.click(screen.getAllByRole("button", { name: "关闭" })[0]!);
    expect(
      await screen.findByRole("button", { name: /Excel \/ CSV · 2 张表/ }),
    ).toBeInTheDocument();
  });

  it("previews uploaded files and creates a file conversation from /chat", async () => {
    const createdConv: Conversation = {
      id: "c-new-file",
      sourceKind: "file",
      datasourceId: null,
      title: "新文件分析",
      modelId: null,
      thinkingLevel: "off",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      lastMessageAt: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") {
        return jsonResponse({ user, permissions: FUNCTIONAL_PERMISSIONS, roles: [] });
      }
      if (url === "/api/conversations") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/api/datasources") return jsonResponse({ datasources: [] });
      if (url === "/api/models") {
        return jsonResponse({
          configured: true,
          models: [
            {
              id: "m1",
              modelId: "m1",
              providerId: "p1",
              providerName: "P1",
              name: "Model 1",
              contextWindow: 64_000,
              maxTokens: 4096,
            },
          ],
          defaultId: "m1",
        });
      }
      if (url === "/api/skills/global") return jsonResponse({ skills: [] });
      if (url === "/api/file-datasets") return jsonResponse({ datasets: [] });
      if (url === "/api/files/preview" && init?.method === "POST") {
        return jsonResponse({
          files: [
            {
              fileName: "sales.csv",
              fileType: "csv",
              sizeBytes: 120,
              headerRow: 1,
              detectedHeaderRow: 1,
              tableCount: 1,
              rowCount: 1,
              tables: [
                {
                  tableName: "sales",
                  displayName: "sales",
                  sheetName: null,
                  rowCount: 1,
                  columns: [
                    {
                      name: "金额",
                      originalName: "金额",
                      type: "INTEGER",
                      nullable: false,
                      sampleValues: ["100"],
                    },
                  ],
                  sampleRows: [[100]],
                  warnings: [],
                },
              ],
            },
          ],
          totalTables: 1,
          totalRows: 1,
        });
      }
      if (url === "/api/conversations/file" && init?.method === "POST") {
        return jsonResponse(
          { conversation: createdConv, files: [], tables: [] },
          201,
        );
      }
      if (url === "/api/conversations/c-new-file/messages" && init?.method === "POST") {
        return jsonResponse({ runId: "run-new", position: 1 }, 202);
      }
      if (url === "/api/conversations/c-new-file") {
        return jsonResponse({
          conversation: createdConv,
          messages: [],
          artifacts: [],
          files: [],
          tables: [],
          activeRun: null,
        });
      }
      if (url === "/api/conversations/c-new-file/skills") {
        return jsonResponse({ skills: [] });
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const browser = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/chat"]}>
          <Routes>
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/:conversationId" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await browser.click(await screen.findByRole("tab", { name: /Excel \/ CSV 文件/ }));
    const file = new File(["金额\n100"], "sales.csv", { type: "text/csv" });
    await browser.upload(screen.getByLabelText("选择 Excel 或 CSV 文件"), file);

    expect(await screen.findByText("sales.csv")).toBeInTheDocument();
    const composer = screen.getByRole("textbox", { name: "输入问题" });
    expect(composer).toBeEnabled();
    await browser.type(composer, "总金额多少");
    await browser.click(screen.getByRole("button", { name: "发送" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/file",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/c-new-file/messages",
      expect.objectContaining({ method: "POST" }),
    );
    expect(await screen.findByText("新文件分析")).toBeInTheDocument();
  });
});

describe("ChatPage suggested questions", () => {
  it("renders cached suggestions above the composer and sends immediately on click", async () => {
    const detailWithSuggestions: ConversationDetail = {
      conversation,
      messages: [
        {
          ...message,
          suggestions: ["按月拆解趋势", "查看高退货类目"],
        },
      ],
      artifacts: [],
      activeRun: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") {
        return jsonResponse({ user, permissions: FUNCTIONAL_PERMISSIONS, roles: [] });
      }
      if (url === "/api/conversations") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/api/datasources") return jsonResponse({ datasources: [datasource] });
      if (url === "/api/datasources/ds-1/catalog") {
        return jsonResponse({
          datasourceId: "ds-1",
          refreshedAt: null,
          stale: false,
          tableCount: 0,
          scopeNotice: null,
          metrics: [],
          relations: [],
          starterQuestions: [],
        });
      }
    if (url === "/api/datasources/ds-1/catalog") {
      return jsonResponse({
        datasourceId: "ds-1",
        refreshedAt: null,
        stale: false,
        tableCount: 0,
        scopeNotice: null,
        metrics: [],
        relations: [],
        starterQuestions: [],
      });
    }
      if (url === "/api/models") {
        return jsonResponse({ configured: false, models: [], defaultId: null });
      }
      if (url === "/api/conversations/c-1") return jsonResponse(detailWithSuggestions);
      if (url === "/api/conversations/c-1/skills") return jsonResponse({ skills: [] });
      if (url === "/api/conversations/c-1/messages" && init?.method === "POST") {
        return jsonResponse({ runId: "run-2", position: 1 }, 202);
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const browser = userEvent.setup();
    renderChatPage();

    const suggestion = await screen.findByRole("button", { name: "按月拆解趋势" });
    expect(screen.getByRole("button", { name: "查看高退货类目" })).toBeInTheDocument();
    await browser.click(suggestion);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversations/c-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "按月拆解趋势" }),
      }),
    );
    const urls = fetchMock.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input.toString(),
    );
    expect(urls).not.toContain("/api/runs/run-1/suggestions");
  });

  it("lazily fetches uncached suggestions when models are configured and hides on dismiss", async () => {
    const detailNeedsFetch: ConversationDetail = {
      conversation,
      messages: [{ ...message, suggestions: null }],
      artifacts: [],
      activeRun: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") {
        return jsonResponse({ user, permissions: FUNCTIONAL_PERMISSIONS, roles: [] });
      }
      if (url === "/api/conversations") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/api/datasources") return jsonResponse({ datasources: [datasource] });
      if (url === "/api/datasources/ds-1/catalog") {
        return jsonResponse({
          datasourceId: "ds-1",
          refreshedAt: null,
          stale: false,
          tableCount: 0,
          scopeNotice: null,
          metrics: [],
          relations: [],
          starterQuestions: [],
        });
      }
    if (url === "/api/datasources/ds-1/catalog") {
      return jsonResponse({
        datasourceId: "ds-1",
        refreshedAt: null,
        stale: false,
        tableCount: 0,
        scopeNotice: null,
        metrics: [],
        relations: [],
        starterQuestions: [],
      });
    }
      if (url === "/api/models") {
        return jsonResponse({
          configured: true,
          models: [
            {
              id: "m1",
              modelId: "m1",
              providerId: "p1",
              providerName: "P1",
              name: "Model 1",
              contextWindow: 64_000,
              maxTokens: 4096,
            },
          ],
          defaultId: "m1",
        });
      }
      if (url === "/api/conversations/c-1") return jsonResponse(detailNeedsFetch);
      if (url === "/api/conversations/c-1/skills") return jsonResponse({ skills: [] });
      if (url === "/api/runs/run-1/suggestions") {
        return jsonResponse({ suggestions: ["按地区对比转化", "拆解客单价波动"] });
      }
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const browser = userEvent.setup();
    renderChatPage();

    expect(await screen.findByRole("button", { name: "按地区对比转化" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拆解客单价波动" })).toBeInTheDocument();

    await browser.click(screen.getByRole("button", { name: "隐藏建议问题" }));
    expect(screen.queryByLabelText("建议追问")).not.toBeInTheDocument();
  });

  it("does not fetch suggestions without chat.use or for failed turns", async () => {
    let permissions: Permission[] = [];
    let turnStatus: ChatMessage["status"] = "ok";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") {
        return jsonResponse({ user, permissions, roles: [] });
      }
      if (url === "/api/conversations") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/api/datasources") return jsonResponse({ datasources: [datasource] });
      if (url === "/api/datasources/ds-1/catalog") {
        return jsonResponse({
          datasourceId: "ds-1",
          refreshedAt: null,
          stale: false,
          tableCount: 0,
          scopeNotice: null,
          metrics: [],
          relations: [],
          starterQuestions: [],
        });
      }
    if (url === "/api/datasources/ds-1/catalog") {
      return jsonResponse({
        datasourceId: "ds-1",
        refreshedAt: null,
        stale: false,
        tableCount: 0,
        scopeNotice: null,
        metrics: [],
        relations: [],
        starterQuestions: [],
      });
    }
      if (url === "/api/models") {
        return jsonResponse({
          configured: true,
          models: [
            {
              id: "m1",
              modelId: "m1",
              providerId: "p1",
              providerName: "P1",
              name: "Model 1",
              contextWindow: 64_000,
              maxTokens: 4096,
            },
          ],
          defaultId: "m1",
        });
      }
      if (url === "/api/conversations/c-1") {
        return jsonResponse({
          conversation,
          messages: [{ ...message, status: turnStatus, suggestions: null }],
          artifacts: [],
          activeRun: null,
        });
      }
      if (url === "/api/conversations/c-1/skills") return jsonResponse({ skills: [] });
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstRender = renderChatPage();

    expect(await screen.findByText("权限测试会话")).toBeInTheDocument();
    expect(screen.queryByLabelText("建议追问")).not.toBeInTheDocument();
    firstRender.unmount();

    permissions = FUNCTIONAL_PERMISSIONS;
    turnStatus = "error";
    renderChatPage();
    expect(await screen.findByText("权限测试会话")).toBeInTheDocument();
    expect(screen.queryByLabelText("建议追问")).not.toBeInTheDocument();

    const requested = fetchMock.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input.toString(),
    );
    expect(requested).not.toContain("/api/runs/run-1/suggestions");
  });
});

describe("ChatPage data catalog and dynamic starters", () => {
  it("renders dynamic datasource starter questions and opens DataCatalogDrawer from topbar", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/auth/me") {
        return jsonResponse({ user, permissions: FUNCTIONAL_PERMISSIONS, roles: [] });
      }
      if (url === "/api/conversations") return jsonResponse({ items: [], nextCursor: null });
      if (url === "/api/datasources") return jsonResponse({ datasources: [datasource] });
      if (url === "/api/datasources/ds-1/catalog") {
        return jsonResponse({
          datasourceId: "ds-1",
          refreshedAt: 1_700_000_000_000,
          stale: false,
          tableCount: 1,
          scopeNotice: null,
          metrics: [
            {
              id: "m-1",
              name: "GMV",
              synonyms: ["成交额"],
              description: "已支付总额",
              tableName: "orders",
              timeColumn: "paid_at",
              unit: "元",
            },
          ],
          relations: [],
          starterQuestions: [
            { title: "上月GMV趋势", body: "统计上月GMV变化趋势", source: "example" },
          ],
        });
      }
      if (url.startsWith("/api/datasources/ds-1/schema")) {
        return jsonResponse({
          tables: [
            {
              schema: "demo",
              name: "orders",
              comment: "订单表",
              rowEstimate: 100,
              columns: [{ name: "id", type: "int", nullable: false, comment: null }],
              primaryKey: ["id"],
              foreignKeys: [],
              indexes: [],
            },
          ],
          refreshedAt: 1_700_000_000_000,
          stale: false,
          error: null,
          total: 1,
        });
      }
      if (url === "/api/datasources/ds-1/skills") return jsonResponse({ skills: [] });
      if (url === "/api/models") {
        return jsonResponse({
          configured: true,
          models: [
            {
              id: "m1",
              modelId: "m1",
              providerId: "p1",
              providerName: "P1",
              name: "Model 1",
              contextWindow: 64_000,
              maxTokens: 4096,
            },
          ],
          defaultId: "m1",
        });
      }
      if (url === "/api/conversations/c-1") return jsonResponse(detail);
      if (url === "/api/conversations/c-1/skills") return jsonResponse({ skills: [] });
      throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const browser = userEvent.setup();

    // First verify dynamic starter questions on /chat empty state.
    const emptyRender = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/chat"]}>
          <Routes>
            <Route path="/chat" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("上月GMV趋势")).toBeInTheDocument();
    expect(screen.getByText("精选问法")).toBeInTheDocument();
    emptyRender.unmount();

    // Then verify clicking topbar datasource button opens DataCatalogDrawer.
    renderChatPage();
    const dsButton = await screen.findByRole("button", { name: /demo · MySQL/ });
    await browser.click(dsButton);
    expect(await screen.findByText("demo.orders")).toBeInTheDocument();
  });

  it("opens topbar export menu with Offline HTML and Markdown options", async () => {
    stubFetch(FUNCTIONAL_PERMISSIONS);
    htmlExportMock.exportConversationHtml.mockClear();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectUrlSpy = vi.fn(() => "blob:mock-md");
    const revokeObjectUrlSpy = vi.fn();
    URL.createObjectURL = createObjectUrlSpy;
    URL.revokeObjectURL = revokeObjectUrlSpy;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    try {
      const browser = userEvent.setup();
      renderChatPage();

      const exportBtn = await screen.findByRole("button", { name: "导出" });
      await browser.click(exportBtn);

      const htmlOption = await screen.findByRole("button", { name: /导出为离线 HTML/ });
      expect(screen.getByRole("button", { name: /导出为 Markdown/ })).toBeInTheDocument();

      await browser.click(htmlOption);
      await waitFor(() => {
        expect(htmlExportMock.exportConversationHtml).toHaveBeenCalledTimes(1);
      });
      expect(htmlExportMock.exportConversationHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "权限测试会话",
          sourceLabel: "demo · MySQL",
        }),
      );

      await browser.click(screen.getByRole("button", { name: "导出" }));
      await browser.click(await screen.findByRole("button", { name: /导出为 Markdown/ }));
      expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      clickSpy.mockRestore();
    }
  });
});
