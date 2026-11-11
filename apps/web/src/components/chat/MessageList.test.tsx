import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
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
});
