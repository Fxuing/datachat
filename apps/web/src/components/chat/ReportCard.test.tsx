import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ReportCard } from "./ReportCard";

const mocks = vi.hoisted(() => ({
  getReport: vi.fn(),
  exportReportById: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    getReport: mocks.getReport,
  };
});

vi.mock("../../lib/report-offscreen-export", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/report-offscreen-export")>();
  return {
    ...actual,
    exportReportById: mocks.exportReportById,
  };
});

describe("ReportCard", () => {
  beforeEach(() => {
    mocks.getReport.mockReset();
    mocks.exportReportById.mockReset();
  });

  it("renders title, detail link, one-click Word export and format menu for HTML/Markdown", async () => {
    const user = userEvent.setup();
    mocks.exportReportById.mockResolvedValue({ title: "2026年7月经营分析" });

    render(
      <MemoryRouter>
        <ReportCard reportId="rep-1" title="2026年7月经营分析" />
      </MemoryRouter>,
    );

    expect(screen.getByText("2026年7月经营分析")).toBeInTheDocument();
    expect(mocks.getReport).not.toHaveBeenCalled();

    const detailLink = screen.getByRole("link", { name: /查看详情/ });
    expect(detailLink).toHaveAttribute("href", "/reports/rep-1");

    await user.click(screen.getByRole("button", { name: "导出 Word" }));
    await waitFor(() => {
      expect(mocks.exportReportById).toHaveBeenCalledWith("rep-1", "docx");
    });

    await user.click(screen.getByRole("button", { name: "更多导出格式" }));
    await user.click(await screen.findByRole("button", { name: /导出 HTML/ }));
    await waitFor(() => {
      expect(mocks.exportReportById).toHaveBeenCalledWith("rep-1", "html");
    });

    await user.click(screen.getByRole("button", { name: "更多导出格式" }));
    await user.click(await screen.findByRole("button", { name: /导出 Markdown/ }));
    await waitFor(() => {
      expect(mocks.exportReportById).toHaveBeenCalledWith("rep-1", "md");
    });
  });

  it("loads title lazily when omitted and surfaces export errors cleanly", async () => {
    const user = userEvent.setup();
    mocks.getReport.mockResolvedValue({
      report: {
        id: "rep-2",
        conversationId: "c-1",
        title: "懒加载报告标题",
        markdown: "# 标题",
        artifactIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    });
    mocks.exportReportById.mockRejectedValue(new Error("export exploded"));

    render(
      <MemoryRouter>
        <ReportCard reportId="rep-2" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("懒加载报告标题")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "导出 Word" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("导出失败，请稍后重试。");
  });
});
