import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ShareDialog } from "./ShareDialog";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const share = {
  id: "s-1",
  token: "tok-abc",
  url: "/s/tok-abc",
  expiresAt: 1_760_000_000_000,
};

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/shares" && init?.method === "POST") {
      return jsonResponse({ share }, 201);
    }
    if (url === "/api/shares/s-1" && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ShareDialog target={{ conversationId: "c-1", label: "第一会话" }} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShareDialog", () => {
  it("creates a link and copies it", async () => {
    const fetchMock = stubFetch();
    const browser = userEvent.setup();
    renderDialog();

    expect(screen.getByText("分享“第一会话”")).toBeInTheDocument();
    await browser.click(screen.getByRole("button", { name: "创建分享链接" }));

    const url = `${window.location.origin}/s/tok-abc`;
    expect(await screen.findByDisplayValue(url)).toBeInTheDocument();
    expect(screen.getByText(/链接仅显示一次/)).toBeInTheDocument();

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      conversationId: "c-1",
      expiresInDays: 7,
    });

    await browser.click(screen.getByRole("button", { name: "复制" }));
    expect(await screen.findByText("已复制")).toBeInTheDocument();
    // user-event owns the clipboard stub; reading it proves the link was copied.
    expect(await navigator.clipboard.readText()).toBe(url);
  });

  it("uses the selected expiry and revokes the created share", async () => {
    const fetchMock = stubFetch();
    const browser = userEvent.setup();
    renderDialog();

    await browser.selectOptions(screen.getByLabelText("有效期"), "30");
    await browser.click(screen.getByRole("button", { name: "创建分享链接" }));

    await screen.findByDisplayValue(`${window.location.origin}/s/tok-abc`);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      conversationId: "c-1",
      expiresInDays: 30,
    });

    await browser.click(screen.getByRole("button", { name: "撤销链接" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/shares/s-1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(await screen.findByText(/链接已撤销/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制" })).toBeDisabled();
  });

  it("shows the server error when creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "NOT_FOUND", message: "分享目标不存在" } }, 404),
      ),
    );
    const browser = userEvent.setup();
    renderDialog();

    await browser.click(screen.getByRole("button", { name: "创建分享链接" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("分享目标不存在");
  });
});
