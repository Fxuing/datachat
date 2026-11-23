import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { BrandingProvider } from "./BrandingProvider";
import { BrandMark } from "./BrandMark";
import { useBranding } from "../lib/branding";

function Probe() {
  const branding = useBranding();
  return (
    <div>
      <span data-testid="brand-title">{branding.title}</span>
      <span data-testid="brand-subtitle">{branding.subtitle}</span>
      <BrandMark size={32} />
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.title = "DataChat";
  document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((el) => {
    el.remove();
  });
});

describe("BrandingProvider", () => {
  it("loads custom branding from /api/public/branding and updates document head & BrandMark", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          title: "星云问数",
          subtitle: "内部数据门户",
          iconUrl: "/api/public/branding/icon?v=123",
          faviconUrl: "/api/public/branding/favicon?v=456",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("brand-title")).toHaveTextContent("星云问数");
    });
    expect(screen.getByTestId("brand-subtitle")).toHaveTextContent("内部数据门户");
    expect(document.title).toBe("星云问数");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/public/branding/icon?v=123",
    );
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(
      "/api/public/branding/favicon?v=456",
    );
    expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
      "/api/public/branding/icon?v=123",
    );
  });

  it("falls back to default branding when payload contains unsafe asset URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            title: "安全测试",
            subtitle: "",
            iconUrl: "javascript:alert(1)",
            faviconUrl: "//evil.example/a.ico",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const { container } = render(
      <BrandingProvider>
        <Probe />
      </BrandingProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("brand-title")).toHaveTextContent("安全测试");
    });
    expect(screen.getByTestId("brand-subtitle")).toHaveTextContent("数据工作台");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/logo.svg");
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/favicon.svg");
  });
});
