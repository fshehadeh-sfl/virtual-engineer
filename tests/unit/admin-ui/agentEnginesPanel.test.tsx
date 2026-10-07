/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEnginesPanel } from "../../../src/admin/ui/views/ConfigView/AgentEnginesPanel.js";
import { api } from "../../../src/admin/ui/api.js";
import type { ApiAgentEngine, ApiAgentEngines } from "../../../src/admin/ui/types.js";

vi.mock("../../../src/admin/ui/api.js", () => ({
  api: { get: vi.fn(), put: vi.fn() },
}));

const getMock = vi.mocked(api.get);
const putMock = vi.mocked(api.put);

function engine(id: string, overrides: Partial<ApiAgentEngine> = {}): ApiAgentEngine {
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    isDefault: id === "copilot",
    requested: id === "copilot",
    installed: id === "copilot",
    forced: false,
    integrationCount: 0,
    ...overrides,
  };
}

function state(engines: ApiAgentEngine[], rebuildRequired = false): ApiAgentEngines {
  return { engines, installStateKnown: true, rebuildRequired };
}

beforeEach(() => {
  getMock.mockReset();
  putMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("AgentEnginesPanel", () => {
  it("lays engines out in two columns without a border under the last row", async () => {
    getMock.mockResolvedValue(state([engine("copilot"), engine("aider"), engine("goose")]));
    render(<AgentEnginesPanel canWrite />);
    await waitFor(() => expect(screen.getByLabelText("Goose")).toBeTruthy());
    const grid = screen.getByTestId("agent-engines-grid");
    expect(grid.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    const rows = [...grid.children] as HTMLElement[];
    expect(rows.map((row) => row.style.borderBottomStyle === "none" || row.style.borderBottom === "")).toEqual([false, false, true]);
  });

  it("locks Copilot and engines still used by integrations", async () => {
    getMock.mockResolvedValue(state([
      engine("copilot"),
      engine("aider", { requested: true, installed: true, integrationCount: 1 }),
      engine("goose"),
    ]));
    render(<AgentEnginesPanel canWrite />);
    await waitFor(() => expect(screen.getByLabelText("Copilot")).toBeTruthy());
    expect((screen.getByLabelText("Copilot") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Aider") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Goose") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText("Not installed")).toBeTruthy();
  });

  it("saves the selection and shows the rerun notice", async () => {
    getMock.mockResolvedValue(state([engine("copilot"), engine("goose")]));
    putMock.mockResolvedValue(state([engine("copilot"), engine("goose", { requested: true, installed: false })], true));
    render(<AgentEnginesPanel canWrite />);
    await waitFor(() => expect(screen.getByLabelText("Goose")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Goose"));
    fireEvent.click(screen.getByRole("button", { name: "Save engine selection" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("./scripts/start.sh"));
    expect(putMock).toHaveBeenCalledWith("/api/admin/agent-engines", { requested: ["copilot", "goose"] });
    expect(screen.getByText("Pending rebuild")).toBeTruthy();
  });

  it("reports unsaved selection changes to the discard guard", async () => {
    getMock.mockResolvedValue(state([engine("copilot"), engine("goose")]));
    const onDirtyChange = vi.fn();
    render(<AgentEnginesPanel canWrite onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(screen.getByLabelText("Goose")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Goose"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByLabelText("Goose"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("labels engines kept by the launcher instead of pending removal", async () => {
    getMock.mockResolvedValue(state([engine("copilot"), engine("goose", { installed: true, forced: true })]));
    render(<AgentEnginesPanel canWrite />);
    await waitFor(() => expect(screen.getByText("Kept by launcher")).toBeTruthy());
    expect(screen.queryByText("Removal pending")).toBeNull();
  });

  it("is read-only without system.write", async () => {
    getMock.mockResolvedValue(state([engine("copilot"), engine("goose")]));
    render(<AgentEnginesPanel canWrite={false} />);
    await waitFor(() => expect(screen.getByLabelText("Goose")).toBeTruthy());
    expect((screen.getByLabelText("Goose") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save engine selection" })).toBeNull();
  });
});
