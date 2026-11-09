import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** Opens a Radix Select trigger and clicks the option with the given visible text. */
export async function pickSelectOption(
  user: UserEvent,
  trigger: HTMLElement,
  optionName: string,
): Promise<void> {
  await user.click(trigger);
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByRole("option", { name: optionName }));
}
