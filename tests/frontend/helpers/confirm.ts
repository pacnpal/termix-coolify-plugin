import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

/**
 * Answers the confirm a click just asked for with `label`, whether it shows
 * as a dialog or as a window.confirm the test spied to say yes. It waits for
 * whichever comes (#105): a fixed 200 ms wait for the dialog left a dialog
 * that showed late on a busy machine unanswered.
 */
export async function acceptConfirm(label: string): Promise<void> {
  const asked = () =>
    vi.isMockFunction(window.confirm) &&
    vi.mocked(window.confirm).mock.calls.length > 0;
  const dialog = await waitFor(() => {
    const shown = screen.queryByRole("alertdialog");
    if (shown || asked()) return shown;
    throw new Error("No confirm was asked");
  });
  if (dialog) {
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
  }
}
