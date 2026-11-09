import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("keeps the textarea editable while a run is active", async () => {
    const onSend = vi.fn(async () => undefined);
    const browser = userEvent.setup();
    render(
      <Composer
        conversationReady
        active
        canStop={false}
        thinkingLevel="off"
        onThinkingChange={() => undefined}
        onSend={onSend}
        onStop={() => undefined}
      />,
    );

    const textarea = screen.getByLabelText("输入问题");
    expect(textarea).toBeEnabled();
    await browser.type(textarea, "next question");
    expect(textarea).toHaveValue("next question");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});
