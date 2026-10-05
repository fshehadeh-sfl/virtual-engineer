/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationFormModal } from "../../../src/admin/ui/views/ConfigView/IntegrationFormModal.js";
import type { ApiPlugin } from "../../../src/admin/ui/types.js";

function plugin(provider: string, name: string, unavailableReason?: string): ApiPlugin {
  return {
    provider,
    name,
    capabilities: ["agent_execution"],
    domainCapabilities: ["agent_execution"],
    requiredFields: [],
    agentConfigFields: [],
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
  };
}

afterEach(() => cleanup());

describe("Add integration provider picker", () => {
  it("disables agent engines that are not installed and lists them last", () => {
    const onDirtyChange = vi.fn();
    render(
      <IntegrationFormModal
        plugins={[plugin("aider", "Aider", "Agent engine \"Aider\" is not installed."), plugin("copilot", "GitHub Copilot")]}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    const aider = screen.getByRole("button", { name: /Aider/u }) as HTMLButtonElement;
    const copilot = screen.getByRole("button", { name: /GitHub Copilot/u }) as HTMLButtonElement;
    expect(aider.disabled).toBe(true);
    expect(aider.title).toBe("");
    expect(screen.getByText(/Greyed-out agent engines are not installed/u).textContent).toContain("Configuration → System → Agent engines");
    expect(aider.textContent).toContain("Not installed");
    expect(copilot.disabled).toBe(false);
    expect(copilot.compareDocumentPosition(aider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(aider);
    expect(onDirtyChange).not.toHaveBeenCalled();
  });

  it("keeps the default description when every engine is installed", () => {
    render(
      <IntegrationFormModal plugins={[plugin("copilot", "GitHub Copilot")]} onClose={vi.fn()} onSaved={vi.fn()} onDirtyChange={vi.fn()} />,
    );
    expect(screen.getByText("Choose the provider type to configure.")).toBeTruthy();
    expect(screen.queryByText(/Greyed-out/u)).toBeNull();
  });
});
