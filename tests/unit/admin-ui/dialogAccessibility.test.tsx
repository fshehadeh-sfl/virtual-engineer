/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, it, vi } from "vitest";
import { Modal } from "../../../src/admin/ui/components/Modal.js";
import { Drawer } from "../../../src/admin/ui/components/Drawer.js";
import { AuthScreen } from "../../../src/admin/ui/shell/AuthScreen.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([Modal, Drawer])("keeps focus in the dialog and returns it to its opener", async (Dialog) => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        {open && (
          <Dialog title="Settings" onClose={() => setOpen(false)}>
            <button>Last control</button>
          </Dialog>
        )}
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  const lastControl = screen.getByRole("button", { name: "Last control" });
  lastControl.focus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("labels username and password without relying on placeholders", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ needsSetup: false, credentialEncryptionConfigured: true }),
  }));
  render(<AuthScreen onAuthenticated={vi.fn()} />);
  expect(await screen.findByRole("textbox", { name: "Username" })).toBeTruthy();
  expect(screen.getByLabelText("Password")).toBeTruthy();
});
