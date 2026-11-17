import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trace } from "./Trace";
import { TraceLine } from "./TraceLine";

function steps() {
  return (
    <>
      <TraceLine title="思考" status="done" durationMs={8_200} />
      <TraceLine title="执行查询" status="done" durationMs={1_200}>
        <pre>select 1</pre>
      </TraceLine>
    </>
  );
}

describe("Trace", () => {
  it("summarises a settled turn and stays collapsed until asked", async () => {
    const user = userEvent.setup();
    render(
      <Trace label="本轮完成" stepCount={2} durationMs={23_400}>
        {steps()}
      </Trace>,
    );

    const summary = screen.getByRole("button", { name: /本轮完成/ });
    expect(summary).toHaveTextContent("2 步");
    expect(summary).toHaveTextContent("23.4s");
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("执行查询")).not.toBeInTheDocument();

    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("执行查询")).toBeInTheDocument();
  });

  it("unfolds while running and folds itself once the run settles", () => {
    const { rerender } = render(
      <Trace label="本轮执行中" status="running" stepCount={2}>
        {steps()}
      </Trace>,
    );

    expect(screen.getByRole("button", { name: /本轮执行中/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("执行查询")).toBeInTheDocument();

    rerender(
      <Trace label="本轮完成" stepCount={2}>
        {steps()}
      </Trace>,
    );

    expect(screen.getByRole("button", { name: /本轮完成/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("执行查询")).not.toBeInTheDocument();
  });

  it("opens a failed run so the broken step is visible immediately", () => {
    render(
      <Trace label="本轮失败" status="error" stepCount={1} durationMs={9_800}>
        <TraceLine title="查询失败" status="error">
          <p>column &quot;channel&quot; does not exist</p>
        </TraceLine>
      </Trace>
    );

    expect(screen.getByRole("button", { name: /本轮失败/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText(/does not exist/)).toBeInTheDocument();
  });

  it("keeps a reader's collapse decision while the run keeps streaming", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Trace label="本轮执行中" status="running">
        {steps()}
      </Trace>,
    );

    await user.click(screen.getByRole("button", { name: /本轮执行中/ }));
    expect(screen.queryByText("执行查询")).not.toBeInTheDocument();

    rerender(
      <Trace label="本轮执行中" status="running">
        {steps()}
      </Trace>,
    );
    expect(screen.getByRole("button", { name: /本轮执行中/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("honours a controlled open state", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Trace label="本轮完成" open onOpenChange={onOpenChange}>
        {steps()}
      </Trace>,
    );

    const summary = screen.getByRole("button", { name: /本轮完成/ });
    expect(summary).toHaveAttribute("aria-expanded", "true");

    await user.click(summary);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Controlled: the parent decides, so the list stays open here.
    expect(summary).toHaveAttribute("aria-expanded", "true");
  });

  it("scrolls a long run instead of growing the page", async () => {
    const user = userEvent.setup();
    render(
      <Trace label="本轮完成" stepCount={12}>
        <TraceLine title="执行查询" />
        <TraceLine title="生成图表" />
      </Trace>,
    );

    await user.click(screen.getByRole("button", { name: /本轮完成/ }));
    const list = screen.getByTestId("trace-steps");
    expect(list.className).toContain("max-h-72");
    expect(list.className).toContain("overflow-y-auto");
  });

  it("follows the newest step while it streams", () => {
    const { rerender } = render(
      <Trace label="本轮执行中" status="running" stepCount={1}>
        <TraceLine title="第一步" />
      </Trace>,
    );
    const list = screen.getByTestId("trace-steps");
    Object.defineProperty(list, "scrollHeight", { value: 600, configurable: true });

    rerender(
      <Trace label="本轮执行中" status="running" stepCount={2}>
        <TraceLine title="第一步" />
        <TraceLine title="第二步" />
      </Trace>,
    );

    expect(list.scrollTop).toBe(600);
  });

  it("leaves one loading indicator to the running step", () => {
    render(
      <Trace label="本轮执行中" status="running" stepCount={1}>
        <TraceLine title="执行查询" status="running" />
      </Trace>,
    );

    // Only the step spins; the summary line already shimmers.
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("puts the token count at the end of the summary", async () => {
    const user = userEvent.setup();
    render(
      <Trace label="本轮完成" stepCount={7} durationMs={23_000} tokens={26_800} tokensHint="输入 20000">
        <TraceLine title="执行查询" />
      </Trace>,
    );

    expect(screen.getByRole("button", { name: /本轮完成/ })).toHaveTextContent(
      "7 步 · 23s · 26.8k tokens",
    );

    // The breakdown is a shared tooltip, not a native title on the button.
    const count = screen.getByText("26.8k tokens");
    expect(count).not.toHaveAttribute("title");
    expect(screen.getByRole("button", { name: /本轮完成/ })).not.toHaveAttribute("title");

    await user.hover(count);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("输入 20000");
  });

  it("drops the toggle when there is nothing to unfold", () => {
    render(<Trace label="本轮完成" stepCount={0} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/步/)).not.toBeInTheDocument();
  });
});

describe("TraceLine", () => {
  it("renders title, description and duration without a toggle", () => {
    render(
      <ul>
        <TraceLine title="读取表结构" description="public.users" durationMs={420} />
      </ul>,
    );

    expect(screen.getByText("读取表结构")).toBeInTheDocument();
    expect(screen.getByText("public.users")).toBeInTheDocument();
    expect(screen.getByText("420ms")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("expands its SQL detail on click", async () => {
    const user = userEvent.setup();
    render(
      <ul>
        <TraceLine title="执行查询" durationMs={1_200}>
          <pre>select 1</pre>
        </TraceLine>
      </ul>,
    );

    const line = screen.getByRole("button", { name: /执行查询/ });
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("select 1")).not.toBeInTheDocument();

    await user.click(line);
    expect(line).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("select 1")).toBeInTheDocument();
  });

  it("marks a failed step, keeps the error text in the detail and opens it", () => {
    render(
      <ul>
        <TraceLine title="查询失败" status="error">
          <p>syntax error at or near &quot;selct&quot;</p>
        </TraceLine>
      </ul>,
    );

    expect(screen.getByLabelText("失败")).toBeInTheDocument();
    expect(screen.getByText("查询失败")).toHaveClass("text-danger");
    expect(screen.getByRole("button", { name: /查询失败/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText(/syntax error/)).toBeInTheDocument();
  });

  it("keeps a running step folded unless the caller says it holds the live output", () => {
    const { rerender } = render(
      <ul>
        <TraceLine title="生成图表" status="running">
          <p>正在渲染…</p>
        </TraceLine>
      </ul>,
    );

    expect(screen.getByRole("button", { name: /生成图表/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    rerender(
      <ul>
        <TraceLine title="生成图表" status="running" defaultOpen>
          <p>正在渲染…</p>
        </TraceLine>
      </ul>,
    );

    expect(screen.getByRole("button", { name: /生成图表/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("正在渲染…")).toBeInTheDocument();
  });
});
