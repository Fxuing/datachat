import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn(async () => undefined);
  render(
    <Composer
      conversationReady
      active={false}
      canStop={false}
      models={[]}
      modelId=""
      modelPickerDisabled
      thinkingLevel="off"
      skills={[]}
      onModelChange={() => undefined}
      onThinkingChange={() => undefined}
      onSend={onSend}
      onStop={() => undefined}
      {...overrides}
    />,
  );
  return { onSend };
}

describe("Composer", () => {
  it("keeps the textarea editable while a run is active", async () => {
    const { onSend } = renderComposer({ active: true });
    const browser = userEvent.setup();

    const textarea = screen.getByLabelText("输入问题");
    expect(textarea).toBeEnabled();
    await browser.type(textarea, "next question");
    expect(textarea).toHaveValue("next question");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("invokes a skill from the slash menu and sends it with the question", async () => {
    const { onSend } = renderComposer({
      skills: [
        { name: "monthly-revenue", description: "月度收入口径", scope: "global" },
        { name: "churn", description: "流失分析", scope: "datasource" },
      ],
    });
    const browser = userEvent.setup();

    const textarea = screen.getByLabelText("输入问题");
    await browser.type(textarea, "/");
    expect(screen.getByRole("listbox", { name: "选择技能" })).toBeInTheDocument();

    await browser.type(textarea, "month");
    await browser.click(screen.getByRole("option", { name: /monthly-revenue/ }));
    expect(screen.getByText(/技能 · monthly-revenue/)).toBeInTheDocument();
    expect(textarea).toHaveValue("");

    await browser.type(textarea, "本月收入多少");
    await browser.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).toHaveBeenCalledWith("本月收入多少", "monthly-revenue");
  });

  it("removes a selected skill before sending", async () => {
    const { onSend } = renderComposer({
      skills: [{ name: "churn", description: "流失分析", scope: "global" }],
    });
    const browser = userEvent.setup();

    const textarea = screen.getByLabelText("输入问题");
    await browser.type(textarea, "/");
    await browser.type(textarea, "churn");
    await browser.keyboard("{Enter}");
    expect(screen.getByText(/技能 · churn/)).toBeInTheDocument();

    await browser.click(screen.getByRole("button", { name: "移除技能" }));
    expect(screen.queryByText(/技能 · churn/)).not.toBeInTheDocument();

    await browser.type(textarea, "近三个月流失");
    await browser.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("近三个月流失", undefined);
  });
});
