/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider, makeCan } from "../../../src/admin/ui/authContext.js";
import { api } from "../../../src/admin/ui/api.js";
import { ConfigView, type ConfigViewData } from "../../../src/admin/ui/views/ConfigView/index.js";
import type { ApiAgent, ApiMe, ApiProject } from "../../../src/admin/ui/types.js";

const admin: ApiMe = {
  id: "admin-1", username: "admin", role: "admin",
  capabilities: { superuser: true, grants: {} },
};
const agent: ApiAgent = {
  id: "a", name: "Alpha", type: "coding", integrationId: "i", enabled: true,
  maxConcurrent: 1, model: "auto", reviewStrategy: "ve_direct",
  systemPromptId: "sys", instructionsPromptId: "inst", feedbackInstructionsPromptId: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const project: ApiProject = {
  id: "p", name: "Project", type: "coding", agentId: "a", enabled: true,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const props: ConfigViewData = {
  agents: [agent, { ...agent, id: "b", name: "Beta" }],
  projects: [project], integrations: [{
    id: "i", name: "Agent provider", provider: "copilot", enabled: true,
    capabilities: [], domainCapabilities: ["agent_execution"],
  }], plugins: [], prompts: [
    { id: "sys", label: "System", promptType: "system", content: "System", updatedAt: "2026-01-01" },
    { id: "inst", label: "Instructions", promptType: "instructions", content: "Instructions", updatedAt: "2026-01-01" },
  ], oauthApps: [],
  config: {
    nodeEnv: "test", logLevel: "silent", pollingIntervalMs: 30000,
    maxAgentCycles: 3, maxRetryAttempts: 5, agentTimeoutMs: 3600000,
    ticketCloseMaxRetries: 5, ticketCloseRetryMinTimeoutMs: 5000,
  },
  status: null, onRefresh: vi.fn(),
};

function open(hash: string, overrides: Partial<ConfigViewData> = {}) {
  window.history.replaceState({}, "", hash);
  return render(
    <CurrentUserProvider value={{ user: admin, isAdmin: true, canOperate: true, can: makeCan(admin) }}>
      <ConfigView {...props} {...overrides} />
    </CurrentUserProvider>,
  );
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Configuration audit regressions", () => {
  it("does not submit agent A's form when the edit URL changes directly to agent B", async () => {
    const get = vi.spyOn(api, "get").mockImplementation(async (path) => {
      const id = String(path).split("/").at(-1);
      return { agent: id === "a" ? agent : { ...agent, id: "b", name: "Beta" } };
    });
    const put = vi.spyOn(api, "put").mockResolvedValue({});
    open("#config/agents/a/edit");
    await screen.findByDisplayValue("Alpha");
    window.history.replaceState({}, "", "#config/agents/b/edit");
    fireEvent(window, new HashChangeEvent("hashchange"));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/admin/agents/b"));
    expect(screen.queryByDisplayValue("Alpha")).toBeNull();
    await screen.findByDisplayValue("Beta");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/api/admin/agents/b", expect.objectContaining({ name: "Beta" })));
  });

  it("guards unsaved runtime policy YAML when switching sections", async () => {
    vi.spyOn(api, "get").mockImplementation(async (path) => {
      if (path === "/api/admin/runtime/policies") return { policies: [] };
      if (path === "/api/admin/projects") return { projects: [] };
      if (path === "/api/admin/agents") return { agents: [] };
      return { driver: "docker", gatewayConfigured: false, gatewayAddress: null, gatewayHealthy: false };
    });
    open("#config/runtime-policies");
    fireEvent.click(await screen.findByRole("button", { name: "New policy" }));
    fireEvent.change(screen.getByLabelText("Policy YAML"), { target: { value: "unsaved: yaml" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: /Projects/ }));
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes?");
    expect(window.location.hash).toBe("#config/runtime-policies");
    expect(screen.getByDisplayValue("unsaved: yaml")).toBeDefined();
  });

  it("shows project access load errors and retries to load groups", async () => {
    const get = vi.spyOn(api, "get").mockImplementation(async (path) => {
      if (String(path).endsWith("/access")) {
        if (get.mock.calls.filter(([url]) => String(url).endsWith("/access")).length === 1) throw new Error("Groups unavailable");
        return { grants: [], availableGroups: [{ id: "writers", name: "Writers" }] };
      }
      return { project };
    });
    open("#config/projects/p");
    fireEvent.click(screen.getByRole("button", { name: "Access" }));
    expect(await screen.findByText("Groups unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("option", { name: "Writers" });
  });

  it("shows project access mutation failures without closing the editor", async () => {
    vi.spyOn(api, "get").mockResolvedValue({ grants: [], availableGroups: [{ id: "writers", name: "Writers" }] });
    vi.spyOn(api, "put").mockRejectedValue(new Error("Access denied"));
    open("#config/projects/p");
    fireEvent.click(screen.getByRole("button", { name: "Access" }));
    await screen.findByRole("option", { name: "Writers" });
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    expect(await screen.findByText("Access denied")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save access" })).toBeDefined();
  });

  it("preserves an unsaved system field on a parent config refresh", async () => {
    const { rerender } = open("#config/system");
    fireEvent.change(screen.getByLabelText("Polling interval (seconds)"), { target: { value: "45" } });
    rerender(
      <CurrentUserProvider value={{ user: admin, isAdmin: true, canOperate: true, can: makeCan(admin) }}>
        <ConfigView {...props} config={{ ...props.config!, pollingIntervalMs: 60000 }} />
      </CurrentUserProvider>,
    );
    expect(screen.getByDisplayValue("45")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled")).toBe(false);
  });

  it.each(["agents", "projects", "integrations"] as const)("reports %s toggle failures", async (section) => {
    vi.spyOn(api, "patch").mockRejectedValue(new Error("Toggle denied"));
    open(`#config/${section}`, { integrations: [{
      id: "i", name: "Integration", provider: "github", enabled: true,
      capabilities: [], domainCapabilities: [],
    }] });
    fireEvent.click(screen.getByRole("switch", { name: new RegExp(`${section === "agents" ? "Agent Alpha" : section === "projects" ? "Project Project" : "Integration Integration"} enabled`) }));
    expect((await screen.findByRole("alert")).textContent).toContain("Toggle denied");
  });
});
