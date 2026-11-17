import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownText } from "../chat/MessageItem";
import { MermaidDiagram } from "./MermaidDiagram";
import { clearSvgCache } from "./mermaid-cache";

const { renderMock } = vi.hoisted(() => ({ renderMock: vi.fn() }));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: (id: string, text: string) => renderMock(id, text),
  },
}));

const SOURCE = "erDiagram\n  channels ||--o{ orders : channel_id";

describe("MermaidDiagram", () => {
  beforeEach(() => {
    renderMock.mockReset();
    clearSvgCache();
  });

  it("renders the chart once the source is complete", async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="chart"></svg>' });

    render(<MermaidDiagram source={SOURCE} />);

    expect(await screen.findByTestId("chart")).toBeInTheDocument();
    expect(renderMock).toHaveBeenCalledWith(expect.any(String), SOURCE);
  });

  it("paints a cached diagram again instead of blinking through the placeholder", async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="chart"></svg>' });

    const first = render(<MermaidDiagram source={SOURCE} />);
    await screen.findByTestId("chart");
    first.unmount();

    render(<MermaidDiagram source={SOURCE} />);

    // No placeholder frame: the cached svg is there on the first render.
    expect(screen.queryByText(/正在渲染图表/)).not.toBeInTheDocument();
    expect(screen.getByTestId("chart")).toBeInTheDocument();
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the source when the diagram does not parse", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));

    render(<MermaidDiagram source={"graph TD; A-->; B"} />);

    expect(await screen.findByText(/图表语法有误/)).toBeInTheDocument();
    expect(screen.getByText(/graph TD; A-->; B/)).toBeInTheDocument();
  });

  it("toggles between the chart and its source", async () => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="chart"></svg>' });
    const user = userEvent.setup();

    render(<MermaidDiagram source={SOURCE} />);
    await screen.findByTestId("chart");

    await user.click(screen.getByRole("button", { name: "源码" }));
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    expect(screen.getByText(/channels \|\|--o\{ orders/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "图表" }));
    expect(await screen.findByTestId("chart")).toBeInTheDocument();
  });
});

describe("MarkdownText with a mermaid fence", () => {
  beforeEach(() => {
    renderMock.mockReset();
    clearSvgCache();
    renderMock.mockResolvedValue({ svg: '<svg data-testid="chart"></svg>' });
  });

  it("turns a ```mermaid block into a diagram", async () => {
    render(<MarkdownText content={"表关系：\n\n```mermaid\nerDiagram\n  a ||--o{ b : ref\n```\n"} />);

    expect(await screen.findByTestId("chart")).toBeInTheDocument();
  });

  it("keeps other fences as copyable code", () => {
    render(<MarkdownText content={"```ts\nconst a = 1;\n```\n"} />);

    expect(screen.getByRole("button", { name: "复制代码" })).toBeInTheDocument();
    expect(renderMock).not.toHaveBeenCalled();
  });
});
