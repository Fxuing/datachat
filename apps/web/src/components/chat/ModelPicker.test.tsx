import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelPicker } from "./ModelPicker";
import type { ChatModelInfo } from "../../lib/api";

const models: ChatModelInfo[] = [
  {
    id: "siliconflow::deepseek-ai/DeepSeek-V3.2",
    modelId: "deepseek-ai/DeepSeek-V3.2",
    providerId: "siliconflow",
    providerName: "SiliconFlow",
    name: "DeepSeek V3.2",
    contextWindow: 128000,
    maxTokens: 16384,
  },
  {
    id: "magpie::workbuddy-ai/deepseek-v4.1-flash-sg",
    modelId: "workbuddy-ai/deepseek-v4.1-flash-sg",
    providerId: "magpie",
    providerName: "Magpie",
    name: "DeepSeek-Flash",
    contextWindow: 128000,
    maxTokens: 8192,
  },
];

describe("ModelPicker", () => {
  it("shows the current model and thinking level in one trigger", () => {
    render(
      <ModelPicker
        models={models}
        modelId="magpie::workbuddy-ai/deepseek-v4.1-flash-sg"
        thinkingLevel="high"
        disabled={false}
        onModelChange={() => undefined}
        onThinkingChange={() => undefined}
      />,
    );
    expect(
      screen.getByRole("button", { name: "选择模型与思考等级" }),
    ).toHaveTextContent("DeepSeek-Flash · 高");
  });

  it("switches model and thinking level from the same panel", async () => {
    const onModelChange = vi.fn();
    const onThinkingChange = vi.fn();
    const browser = userEvent.setup();
    render(
      <ModelPicker
        models={models}
        modelId="siliconflow::deepseek-ai/DeepSeek-V3.2"
        thinkingLevel="off"
        disabled={false}
        onModelChange={onModelChange}
        onThinkingChange={onThinkingChange}
      />,
    );

    await browser.click(screen.getByRole("button", { name: "选择模型与思考等级" }));
    await browser.click(screen.getByRole("button", { name: "DeepSeek-Flash" }));
    expect(onModelChange).toHaveBeenCalledWith("magpie::workbuddy-ai/deepseek-v4.1-flash-sg");

    await browser.click(screen.getByRole("button", { name: "选择模型与思考等级" }));
    await browser.click(screen.getByRole("button", { name: "高" }));
    expect(onThinkingChange).toHaveBeenCalledWith("high");
  });
});
