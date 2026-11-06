import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, setUnauthorizedHandler } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(undefined);
});

describe("apiRequest", () => {
  it("maps the server error envelope to ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "VALIDATION", message: "参数不合法" } }, 400),
      ),
    );

    await expect(apiRequest("/api/conversations")).rejects.toMatchObject({
      name: "ApiError",
      code: "VALIDATION",
      message: "参数不合法",
      status: 400,
    });
  });

  it("falls back to a generic message for non-JSON failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );

    const error = await apiRequest("/api/conversations").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "HTTP_502", message: "请求失败，请稍后重试", status: 502 });
  });

  it("sends cookies and JSON bodies", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ datasourceId: "ds-1" }),
    });

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/conversations");
    expect(init?.credentials).toBe("include");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
  });

  it("returns undefined for 204 responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    await expect(apiRequest("/api/runs/1/abort", { method: "POST" })).resolves.toBeUndefined();
  });

  it("notifies the unauthorized handler on 401", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "UNAUTHORIZED", message: "请先登录" } }, 401),
      ),
    );

    await expect(apiRequest("/api/auth/me")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not notify the unauthorized handler on other failures", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "NOT_FOUND", message: "会话不存在" } }, 404)),
    );

    await expect(apiRequest("/api/conversations/x")).rejects.toMatchObject({ status: 404 });
    expect(handler).not.toHaveBeenCalled();
  });
});
