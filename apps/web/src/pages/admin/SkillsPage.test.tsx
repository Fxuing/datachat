import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SkillsPage from "./SkillsPage";
import type {
  AdminSkill,
  AdminSkillDetail,
  DatasourceSummary,
  SessionUser,
} from "../../lib/api";

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

const globalSkill: AdminSkill = {
  id: "s-1",
  name: "sales-rules",
  description: "销售口径",
  scope: "global",
  datasourceId: null,
  enabled: true,
  updatedAt: 1_760_000_000_000,
};

const datasourceSkill: AdminSkill = {
  id: "s-2",
  name: "mysql-notes",
  description: "MySQL 口径",
  scope: "datasource",
  datasourceId: datasource.id,
  enabled: false,
  updatedAt: 1_760_000_000_000,
};

const detail: AdminSkillDetail = {
  ...globalSkill,
  content: "---\nname: sales-rules\ndescription: 销售口径\n---\n\n按月份统计订单金额。",
  createdAt: 1_759_000_000_000,
};

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
    if (url === "/api/admin/skills" && method === "GET") {
      return jsonResponse({ skills: [globalSkill, datasourceSkill] });
    }
    if (url === "/api/admin/skills" && method === "POST") {
      return jsonResponse({ skill: { ...detail, name: "team-rules" } }, 201);
    }
    if (url === "/api/admin/skills/seed" && method === "POST") {
      return jsonResponse({ imported: 3, skipped: 1 });
    }
    if (url === "/api/admin/skills/s-1" && method === "GET") {
      return jsonResponse({ skill: detail });
    }
    if (url === "/api/admin/skills/s-1" && method === "DELETE") {
      return jsonResponse({ ok: true });
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
      <MemoryRouter initialEntries={["/admin/skills"]}>
        <Routes>
          <Route path="/admin/skills" element={<SkillsPage />} />
          <Route path="/chat" element={<div>聊天页</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SkillsPage", () => {
  it("renders skills with datasource names and filters by scope", async () => {
    stubApi();
    const browser = userEvent.setup();
    renderPage();

    expect(await screen.findByText("sales-rules")).toBeInTheDocument();
    expect(screen.getByText("mysql-notes")).toBeInTheDocument();
    expect(screen.getByText("demo")).toBeInTheDocument();
    expect(screen.getByText("启用")).toBeInTheDocument();
    expect(screen.getByText("停用")).toBeInTheDocument();

    await browser.selectOptions(screen.getByLabelText("按范围筛选"), "datasource");
    expect(screen.getByText("mysql-notes")).toBeInTheDocument();
    expect(screen.queryByText("sales-rules")).not.toBeInTheDocument();
    expect(screen.getByText("共 1 个技能")).toBeInTheDocument();

    await browser.selectOptions(screen.getByLabelText("按范围筛选"), "global");
    expect(screen.getByText("sales-rules")).toBeInTheDocument();
    expect(screen.queryByText("mysql-notes")).not.toBeInTheDocument();
  });

  it("creates a skill with the expected request body", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "新建技能" }));
    const dialog = await screen.findByRole("dialog", { name: "新建技能" });

    await browser.type(within(dialog).getByLabelText("名称"), "team-rules");
    await browser.type(within(dialog).getByLabelText("描述"), "团队口径");
    await browser.type(within(dialog).getByLabelText("内容（SKILL.md）"), "按周统计");
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === "/api/admin/skills" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    const call = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/admin/skills" && init?.method === "POST",
    );
    expect(JSON.parse(String(call![1]!.body))).toEqual({
      name: "team-rules",
      description: "团队口径",
      content: "按周统计",
      scope: "global",
      datasourceId: null,
      enabled: true,
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "新建技能" })).not.toBeInTheDocument(),
    );
  });

  it("clears datasourceId when switching back to a global scope", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "新建技能" }));
    const dialog = await screen.findByRole("dialog", { name: "新建技能" });

    await browser.type(within(dialog).getByLabelText("名称"), "team-rules");
    await browser.type(within(dialog).getByLabelText("描述"), "团队口径");
    await browser.type(within(dialog).getByLabelText("内容（SKILL.md）"), "按周统计");
    await browser.selectOptions(within(dialog).getByLabelText("范围"), "datasource");
    await browser.selectOptions(within(dialog).getByLabelText("数据源"), datasource.id);
    expect(within(dialog).getByLabelText("数据源")).toHaveValue(datasource.id);

    await browser.selectOptions(within(dialog).getByLabelText("范围"), "global");
    expect(within(dialog).getByLabelText("数据源")).toHaveValue("");

    await browser.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input) === "/api/admin/skills" && init?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({
        scope: "global",
        datasourceId: null,
      });
    });
  });

  it("asks for confirmation before deleting a skill", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await screen.findByText("sales-rules");
    await browser.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
    const editor = await screen.findByRole("dialog", { name: "编辑技能" });
    await waitFor(() =>
      expect(within(editor).getByLabelText("内容（SKILL.md）")).toHaveValue(detail.content),
    );

    await browser.click(within(editor).getByRole("button", { name: "删除" }));
    const confirm = await screen.findByRole("dialog", { name: "删除技能" });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/admin/skills/s-1" && init?.method === "DELETE",
      ),
    ).toBe(false);

    await browser.click(within(confirm).getByRole("button", { name: "确认删除" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/skills/s-1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("prompts before discarding unsaved changes", async () => {
    stubApi();
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "新建技能" }));
    const dialog = await screen.findByRole("dialog", { name: "新建技能" });
    await browser.type(within(dialog).getByLabelText("名称"), "draft-skill");

    await browser.click(within(dialog).getByRole("button", { name: "取消" }));
    const discard = await screen.findByRole("dialog", { name: "放弃未保存的修改？" });
    await browser.click(within(discard).getByRole("button", { name: "放弃修改" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "新建技能" })).not.toBeInTheDocument(),
    );
  });

  it("shows server validation errors inline", async () => {
    stubApi((url, method) => {
      if (url === "/api/admin/skills" && method === "POST") {
        return jsonResponse(
          {
            error: {
              code: "VALIDATION",
              message: "参数不合法",
              details: { fieldErrors: { name: ["名称需为 2-64 位小写字母、数字或短横线"] } },
            },
          },
          400,
        );
      }
      return undefined;
    });
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "新建技能" }));
    const dialog = await screen.findByRole("dialog", { name: "新建技能" });
    await browser.type(within(dialog).getByLabelText("名称"), "Bad Name");
    await browser.type(within(dialog).getByLabelText("描述"), "描述");
    await browser.type(within(dialog).getByLabelText("内容（SKILL.md）"), "正文");
    await browser.click(within(dialog).getByRole("button", { name: "保存" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("参数不合法");
    expect(alert.textContent).toContain("名称需为 2-64 位小写字母");
    expect(screen.getByRole("dialog", { name: "新建技能" })).toBeInTheDocument();
  });

  it("seeds built-in skills after confirmation", async () => {
    const fetchMock = stubApi();
    const browser = userEvent.setup();
    renderPage();

    await browser.click(await screen.findByRole("button", { name: "恢复内置技能" }));
    const confirm = await screen.findByRole("dialog", { name: "恢复内置技能" });
    await browser.click(within(confirm).getByRole("button", { name: "确认恢复" }));

    expect(await screen.findByRole("status")).toHaveTextContent("已导入 3 个，跳过 1 个");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/skills/seed",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
