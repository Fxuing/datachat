import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SettingsPage from "./SettingsPage";
import type { AdminSettings, SessionUser } from "../../lib/api";
import { pickSelectOption } from "../../test/select";

const admin: SessionUser = {
  id: "u-admin",
  username: "root",
  displayName: "管理员",
  role: "admin",
  status: "active",
};

const settings: AdminSettings = {
  defaultModelId: "siliconflow::zai-org/GLM-5.3",
  queryMaxRows: 1_000,
  queryPreviewRows: 200,
  queryTimeoutMs: 5_000,
  shareMaxDays: 30,
  retentionConversationDays: 0,
  retentionAuditDays: 0,
};

function chatModel(modelId: string, name: string, contextWindow = 128_000, maxTokens = 8_192) {
  return {
    id: `siliconflow::${modelId}`,
    modelId,
    providerId: "siliconflow",
    providerName: "SiliconFlow",
    name,
    contextWindow,
    maxTokens,
  };
}

const models = [
  chatModel("deepseek-ai/DeepSeek-V3.2", "DeepSeek V3.2"),
  chatModel("zai-org/GLM-5.3", "GLM 5.3"),
  chatModel("Qwen/Qwen3.8-27B", "Qwen3.8 27B", 32_000, 4_096),
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Override = (url: string, method: string) => Response | undefined;

function stubApi(override?: Override) {
  const putBodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const custom = override?.(url, method);
    if (custom) return custom;

    if (url === "/api/auth/me") return jsonResponse({ user: admin, permissions: [], roles: [] });
    if (url === "/api/models") {
      return jsonResponse({ configured: true, models, defaultId: settings.defaultModelId });
    }
    if (url === "/api/admin/settings" && method === "GET") {
      return jsonResponse({ settings });
    }
    if (url === "/api/admin/settings" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Partial<AdminSettings>;
      putBodies.push(body);
      return jsonResponse({ settings: { ...settings, ...body } });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, putBodies };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/admin/settings"]}>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  it("renders the effective settings and model options", async () => {
    stubApi();
    renderPage();

    const user = userEvent.setup();
    const modelSelect = await screen.findByRole("combobox", { name: "默认模型" });
    expect(modelSelect).toHaveTextContent("GLM 5.3");

    await user.click(modelSelect);
    expect(await screen.findByRole("option", { name: /Qwen3.8 27B/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("link", { name: "查询限制" }));
    expect(
      (screen.getByRole("spinbutton", { name: "查询最大行数" }) as HTMLInputElement).value,
    ).toBe("1000");
    expect(
      (screen.getByRole("spinbutton", { name: "查询超时（毫秒）" }) as HTMLInputElement).value,
    ).toBe("5000");

    await userEvent.setup().click(screen.getByRole("link", { name: "分享" }));
    expect(
      (screen.getByRole("spinbutton", { name: "分享最长有效期（天）" }) as HTMLInputElement)
        .value,
    ).toBe("30");
  });

  it("saves the edited values as numbers and reports success", async () => {
    const { putBodies } = stubApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("combobox", { name: "默认模型" });
    await user.click(screen.getByRole("link", { name: "查询限制" }));
    const maxRows = await screen.findByRole("spinbutton", { name: "查询最大行数" });
    await user.clear(maxRows);
    await user.type(maxRows, "2000");

    await user.click(screen.getByRole("link", { name: "分享" }));
    const shareDays = screen.getByRole("spinbutton", { name: "分享最长有效期（天）" });
    await user.clear(shareDays);
    await user.type(shareDays, "14");

    await user.click(screen.getByRole("link", { name: "通用" }));
    await pickSelectOption(
      user,
      screen.getByRole("combobox", { name: "默认模型" }),
      "Qwen3.8 27B",
    );
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await screen.findByText("设置已保存");
    expect(putBodies).toEqual([
      {
        defaultModelId: "siliconflow::Qwen/Qwen3.8-27B",
        queryMaxRows: 2_000,
        queryPreviewRows: 200,
        queryTimeoutMs: 5_000,
        shareMaxDays: 14,
      },
    ]);
  });

  it("validates numbers inline before calling the API", async () => {
    const { putBodies } = stubApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("combobox", { name: "默认模型" });
    await user.click(screen.getByRole("link", { name: "查询限制" }));
    const maxRows = await screen.findByRole("spinbutton", { name: "查询最大行数" });
    await user.clear(maxRows);
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByText("请输入整数，范围 1 到 100000")).toBeDefined();

    await user.type(maxRows, "100001");
    await user.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByText("需在 1 到 100000 之间")).toBeDefined();
    expect(putBodies).toEqual([]);
  });

  it("restores defaults by clearing every override", async () => {
    const { putBodies } = stubApi();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("combobox", { name: "默认模型" });
    await user.click(screen.getByRole("button", { name: "恢复默认" }));

    await screen.findByText("已恢复默认设置");
    expect(putBodies).toEqual([
      {
        defaultModelId: null,
        queryMaxRows: null,
        queryPreviewRows: null,
        queryTimeoutMs: null,
        shareMaxDays: null,
      },
    ]);
  });

  it("surfaces server validation errors", async () => {
    stubApi((url, method) =>
      url === "/api/admin/settings" && method === "PUT"
        ? jsonResponse({ error: { code: "VALIDATION", message: "模型不在白名单中" } }, 400)
        : undefined,
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("combobox", { name: "默认模型" });
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("模型不在白名单中");
    });
  });
});
