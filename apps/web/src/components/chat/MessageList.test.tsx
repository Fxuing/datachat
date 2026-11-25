import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MessageList } from "./MessageList";
import { initialRunStreamState, type RunStreamState } from "../../lib/run-events";

function stream(overrides: Partial<RunStreamState>): RunStreamState {
  return { ...initialRunStreamState, ...overrides };
}

const chart = {
  chartArtifactId: "chart-1",
  title: "月度趋势",
  points: 2,
  spec: {
    chart: { title: "月度趋势" },
    option: { series: [{ type: "line", data: [1, 2] }] },
  },
};

function renderList(state: RunStreamState) {
  return render(
    <MemoryRouter>
      <MessageList messages={[]} stream={state} showStream optimisticText={null} />
    </MemoryRouter>,
  );
}

describe("MessageList charts", () => {
  it("does not duplicate the active turn when history already contains it", () => {
    render(
      <MemoryRouter>
        <MessageList
          messages={[
            {
              runId: "run-1",
              status: "running",
              user: { content: "这个库有哪些表？" },
              assistant: null,
              tools: [],
              results: [],
              sqls: [],
              error: null,
              createdAt: 1,
            },
          ]}
          stream={stream({ status: "running" })}
          showStream
          optimisticText="这个库有哪些表？"
          activeRunId="run-1"
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("这个库有哪些表？")).toHaveLength(1);
  });

  it("starts a chat from the empty state via a datasource and example", async () => {
    const user = userEvent.setup();
    const onExample = vi.fn();
    render(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={initialRunStreamState}
          showStream={false}
          optimisticText={null}
          datasources={[
            {
              id: "ds-1",
              name: "业务库",
              type: "mysql",
              host: "db.local",
              port: 3306,
              database: "biz",
              username: "reader",
              sslMode: "disable",
              status: "ok",
              readOnlyVerified: true,
              allowWriteAccount: false,
              lastCheckedAt: null,
            },
          ]}
          selectedDatasourceId="ds-1"
          modelsStatus="ready"
          modelsCount={1}
          onExample={onExample}
        />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("选择数据源")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /先了解数据结构/ }));
    expect(onExample).toHaveBeenCalledWith("这个库有哪些表？分别做什么？");
  });

  it("uses the bound datasource for an empty existing conversation", async () => {
    const user = userEvent.setup();
    const onExample = vi.fn();
    render(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={initialRunStreamState}
          showStream={false}
          optimisticText={null}
          datasourceLocked
          boundDatasource={{
            id: "ds-1",
            name: "业务库",
            type: "mysql",
            host: "db.local",
            port: 3306,
            database: "biz",
            username: "reader",
            sslMode: "disable",
            status: "ok",
            readOnlyVerified: true,
            allowWriteAccount: false,
            lastCheckedAt: null,
          }}
          modelsStatus="ready"
          modelsCount={1}
          onExample={onExample}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("开始提问")).toBeInTheDocument();
    expect(screen.queryByLabelText("选择数据源")).not.toBeInTheDocument();
    expect(screen.queryByText("业务库 · MySQL")).not.toBeInTheDocument();
    expect(screen.queryByText("还没有可用的数据源")).not.toBeInTheDocument();
    expect(screen.queryByText("尚未配置模型服务")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /先了解数据结构/ }));
    expect(onExample).toHaveBeenCalledWith("这个库有哪些表？分别做什么？");
  });

  it("shows model and datasource configuration problems instead of guessing", async () => {
    const user = userEvent.setup();
    const onRetryModels = vi.fn();
    const onRetryDatasources = vi.fn();
    render(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={initialRunStreamState}
          showStream={false}
          optimisticText={null}
          datasources={[]}
          datasourcesError="网络错误"
          onRetryDatasources={onRetryDatasources}
          modelsStatus="error"
          modelsCount={0}
          onRetryModels={onRetryModels}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("数据源加载失败")).toBeInTheDocument();
    expect(screen.getByText("模型列表加载失败")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "重试" })[0]!);
    expect(onRetryDatasources).toHaveBeenCalled();
    expect(onRetryModels).not.toHaveBeenCalled();
  });

  it("renders a loading model state and a configuration hint when no models exist", () => {
    const { rerender } = render(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={initialRunStreamState}
          showStream={false}
          optimisticText={null}
          modelsStatus="loading"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("正在加载模型服务…")).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={initialRunStreamState}
          showStream={false}
          optimisticText={null}
          modelsStatus="ready"
          modelsCount={0}
          isAdmin
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("尚未配置模型服务")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去配置模型服务/ })).toHaveAttribute(
      "href",
      "/admin/settings",
    );
  });

  it("switches to Excel/CSV mode without DB datasources and starts via file examples", async () => {
    const user = userEvent.setup();
    const onNewChatModeChange = vi.fn();
    const onExample = vi.fn();

    const { rerender } = render(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={initialRunStreamState}
          showStream={false}
          optimisticText={null}
          datasources={[]}
          newChatMode="datasource"
          onNewChatModeChange={onNewChatModeChange}
          modelsStatus="ready"
          modelsCount={1}
          onExample={onExample}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("tab", { name: /Excel \/ CSV 文件/ }));
    expect(onNewChatModeChange).toHaveBeenCalledWith("file");

    rerender(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={initialRunStreamState}
          showStream={false}
          optimisticText={null}
          datasources={[]}
          newChatMode="file"
          onNewChatModeChange={onNewChatModeChange}
          fileReady
          fileUploadProps={{
            files: [],
            headerRows: [],
            preview: null,
            previewLoading: false,
            previewError: null,
            onAddFiles: vi.fn(),
            onRemoveFile: vi.fn(),
            onHeaderRowChange: vi.fn(),
            onClearAll: vi.fn(),
          }}
          modelsStatus="ready"
          modelsCount={1}
          onExample={onExample}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText("拖拽 Excel 或 CSV 文件到这里，或点击选择"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /先了解文件数据结构/ }));
    expect(onExample).toHaveBeenCalledWith("这些表里有哪些字段？数据大致是什么情况？");
  });

  it("renders a chat result reference as an inline link while streaming", () => {
    const result = {
      artifactId: "result-1",
      columns: [{ name: "total", type: "number" as const }],
      rows: [[42]],
      rowCount: 1,
      truncated: false,
    };
    renderList(
      stream({
        status: "ok",
        text: "汇总如下。\n\n[[result:result-1]]",
        results: [result],
      }),
    );

    expect(screen.queryByText(/\[\[result:/)).not.toBeInTheDocument();
    expect(screen.queryByText("查询结果")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /查看完整结果\s*1 行/ })).toBeInTheDocument();
  });

  it("groups multiple streaming results horizontally and hides partial labelled markers", () => {
    const res1 = {
      artifactId: "result-1",
      columns: [{ name: "类目", type: "string" as const }],
      rows: [["服饰"]],
      rowCount: 6,
      truncated: false,
    };
    const res2 = {
      artifactId: "result-2",
      columns: [
        { name: "月份", type: "string" as const },
        { name: "订单数", type: "number" as const },
      ],
      rows: [["8月", 12]],
      rowCount: 12,
      truncated: false,
    };
    renderList(
      stream({
        status: "running",
        text: "汇总如下。\n\n[[result:result-1|按类目明细]]\n[[result:result-2]]\n汇总中 [[result:result-3|正在输出",
        results: [res1, res2],
      }),
    );

    const first = screen.getByRole("button", { name: /按类目明细\s*6 行/ });
    const second = screen.getByRole("button", { name: /月份 · 订单数\s*12 行/ });
    expect(first.parentElement).toBe(second.parentElement);
    expect(first.parentElement).toHaveClass("flex-wrap");
    expect(screen.queryByText(/\[\[result:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/正在输出/)).not.toBeInTheDocument();
  });

  it("waits for the run to finish before showing charts", () => {
    const text = "趋势如下。\n\n[[chart:chart-1]]\n\n结论。";
    const { rerender } = renderList(
      stream({ status: "running", text, charts: [chart] }),
    );

    expect(screen.queryByText("月度趋势")).not.toBeInTheDocument();
    expect(screen.queryByText(/\[\[chart:/)).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={stream({ status: "ok", text, charts: [chart] })}
          showStream
          optimisticText={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("月度趋势")).toHaveLength(1);
  });

  it("suppresses fallback charts in a completed stream when included in a succeeded report", () => {
    const secondChart = {
      chartArtifactId: "chart-2",
      title: "渠道对比",
      points: 5,
      spec: {
        chart: { title: "渠道对比" },
        option: { series: [{ type: "bar", data: [3, 4] }] },
      },
    };
    renderList(
      stream({
        status: "ok",
        text: "趋势如下。\n\n[[chart:chart-1]]\n\n[查看完整报告](/reports/r-1)",
        charts: [chart, secondChart],
        tools: [
          {
            toolCallId: "tc-report",
            name: "create_report",
            status: "ok",
            args: { artifactIds: ["chart-1", "chart-2"] },
          },
        ],
      }),
    );

    expect(screen.getAllByText("月度趋势")).toHaveLength(1);
    expect(screen.queryByText("渠道对比")).not.toBeInTheDocument();
  });
});


describe("MessageList scrolling", () => {
  const message = {
    runId: "run-1",
    status: "ok" as const,
    user: { content: "统计订单" },
    assistant: { content: "共 20 单" },
    tools: [],
    results: [],
    sqls: [],
    error: null,
    createdAt: 1,
  };

  it("restores a saved reading position for the conversation", () => {
    window.sessionStorage.setItem(
      "datachat:scroll:c-1",
      JSON.stringify({ scrollTop: 240, atBottom: false }),
    );
    render(
      <MemoryRouter>
        <MessageList
          conversationId="c-1"
          messages={[message]}
          stream={initialRunStreamState}
          showStream={false}
          optimisticText={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("message-scroll").scrollTop).toBe(240);
  });

  it("marks new live content while the reader is scrolled up", () => {
    const { rerender } = render(
      <MemoryRouter>
        <MessageList
          conversationId="c-1"
          messages={[message]}
          stream={stream({ status: "running" })}
          showStream
          optimisticText={null}
        />
      </MemoryRouter>,
    );
    const container = screen.getByTestId("message-scroll");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    container.scrollTop = 100;
    fireEvent.scroll(container);

    rerender(
      <MemoryRouter>
        <MessageList
          conversationId="c-1"
          messages={[message]}
          stream={stream({ status: "running", text: "正在整理结果" })}
          showStream
          optimisticText={null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("有新内容")).toBeInTheDocument();

    Object.defineProperty(container, "scrollTo", { configurable: true, value: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "回到底部" }));
    expect(screen.queryByText("有新内容")).not.toBeInTheDocument();
  });

  it("returns to the bottom when a new question is sent", () => {
    const { rerender } = render(
      <MemoryRouter>
        <MessageList
          conversationId="c-1"
          messages={[message]}
          stream={initialRunStreamState}
          showStream={false}
          optimisticText={null}
        />
      </MemoryRouter>,
    );
    const container = screen.getByTestId("message-scroll");
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 400 });
    container.scrollTop = 100;
    fireEvent.scroll(container);

    rerender(
      <MemoryRouter>
        <MessageList
          conversationId="c-1"
          messages={[message]}
          stream={initialRunStreamState}
          showStream
          optimisticText="再统计一次"
        />
      </MemoryRouter>,
    );
    expect(container.scrollTop).toBe(1000);
  });
});

describe("MessageList excel and cross-turn results", () => {
  const excelItem = {
    excelArtifactId: "xls-stream-1",
    filename: "实时销售工作簿",
    sheets: [{ name: "汇总", artifactId: "res-1", rowCount: 8 }],
    totalRows: 8,
  };

  it("hides incomplete excel markers while running, renders inline excel immediately when complete, and appends unreferenced excels at end", () => {
    const { rerender } = renderList(
      stream({
        status: "running",
        text: "正在准备\n\n[[excel:xls-stream",
        excels: [excelItem],
      }),
    );

    expect(screen.queryByText(/\[\[excel:/)).not.toBeInTheDocument();
    expect(screen.queryByText("实时销售工作簿.xlsx")).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={stream({
            status: "running",
            text: "已生成：\n\n[[excel:xls-stream-1]]",
            excels: [excelItem],
          })}
          showStream
          optimisticText={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("实时销售工作簿.xlsx")).toBeInTheDocument();

    // Unreferenced excel shows up once the run completes
    rerender(
      <MemoryRouter>
        <MessageList
          messages={[]}
          stream={stream({
            status: "ok",
            text: "已完成汇总。",
            excels: [excelItem],
          })}
          showStream
          optimisticText={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("实时销售工作簿.xlsx")).toHaveLength(1);
  });

  it("resolves cross-turn result links in both persisted messages and active streams", () => {
    render(
      <MemoryRouter>
        <MessageList
          messages={[
            {
              runId: "run-1",
              status: "ok",
              user: { content: "查第一轮明细" },
              assistant: { content: "已查询完成。" },
              tools: [],
              sqls: [],
              results: [
                {
                  artifactId: "res-turn-1",
                  columns: [{ name: "city", type: "string" }],
                  rows: [["上海"]],
                  rowCount: 1,
                  truncated: false,
                },
              ],
              error: null,
              createdAt: 1,
            },
            {
              runId: "run-2",
              status: "ok",
              user: { content: "引用第一轮结果" },
              assistant: { content: "第二轮引用：\n\n[[result:res-turn-1|上海明细]]" },
              tools: [],
              sqls: [],
              results: [],
              error: null,
              createdAt: 2,
            },
          ]}
          stream={stream({
            status: "running",
            text: "流式引用：\n\n[[result:res-turn-1|历史城市场景]]",
          })}
          showStream
          optimisticText={null}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: /上海明细\s*1 行/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /历史城市场景\s*1 行/ })).toBeInTheDocument();
    expect(screen.queryByText(/结果引用不可用/)).not.toBeInTheDocument();
  });
});
