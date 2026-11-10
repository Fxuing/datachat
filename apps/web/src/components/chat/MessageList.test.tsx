import { describe, expect, it } from "vitest";
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
