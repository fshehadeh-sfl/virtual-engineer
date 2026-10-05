import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentEngineStateStore,
  INSTALLED_ENGINES_FILE,
  REQUESTED_ENGINES_FILE,
  agentEngineImage,
  agentEngineUnavailableMessage,
  describeAgentEngines,
  initializeAgentEngineState,
  normalizeRequestedEngines,
  parseEngineList,
} from "../../src/agents/agentEngines.js";

describe("agentEngineImage", () => {
  it.each([
    ["virtual-engineer-workspace:latest", "copilot", "virtual-engineer-workspace:latest"],
    ["virtual-engineer-workspace:latest", undefined, "virtual-engineer-workspace:latest"],
    ["virtual-engineer-workspace:latest", "unknown", "virtual-engineer-workspace:latest"],
    ["virtual-engineer-workspace:latest", "aider", "virtual-engineer-workspace-aider:latest"],
    ["virtual-engineer-workspace", "claude", "virtual-engineer-workspace-claude"],
    ["registry.local:5000/ve/workspace:1.2", "codex", "registry.local:5000/ve/workspace-codex:1.2"],
    ["registry.local:5000/ve/workspace", "goose", "registry.local:5000/ve/workspace-goose"],
    ["ve/workspace:1@sha256:abc", "cursor", "ve/workspace-cursor:1"],
  ])("maps %s + %s to %s", (base, engine, expected) => {
    expect(agentEngineImage(base, engine)).toBe(expected);
  });
});

describe("engine lists", () => {
  it("parses ids in catalog order, ignoring comments, blanks, duplicates and unknown ids", () => {
    expect(parseEngineList("# header\ncursor\n\naider # note\nbogus\naider\r\n")).toEqual(["aider", "cursor"]);
  });

  it("always includes the default engine", () => {
    expect(normalizeRequestedEngines(["gemini"])).toEqual(["copilot", "gemini"]);
  });
});

describe("agentEngineUnavailableMessage", () => {
  it("does not gate when install state is unknown, for the default engine, or for non-engine providers", () => {
    expect(agentEngineUnavailableMessage("aider", undefined)).toBeUndefined();
    expect(agentEngineUnavailableMessage("copilot", [])).toBeUndefined();
    expect(agentEngineUnavailableMessage("gerrit", [])).toBeUndefined();
    expect(agentEngineUnavailableMessage("aider", ["aider"])).toBeUndefined();
  });

  it("explains how to install a missing engine", () => {
    expect(agentEngineUnavailableMessage("aider", ["copilot"])).toMatch(/Aider.*not installed.*start\.sh/u);
  });
});

describe("describeAgentEngines", () => {
  it("reports request, install and usage state per engine", () => {
    const rows = describeAgentEngines({
      requested: ["copilot", "aider"],
      installed: ["copilot"],
      integrationCounts: new Map([["aider", 2]]),
    });
    expect(rows.find((row) => row.id === "copilot")).toMatchObject({ isDefault: true, requested: true, installed: true });
    expect(rows.find((row) => row.id === "aider")).toMatchObject({ requested: true, installed: false, integrationCount: 2 });
    expect(rows.find((row) => row.id === "cursor")).toMatchObject({ requested: false, installed: false, integrationCount: 0 });
  });

  it("reports unknown install state as null", () => {
    const rows = describeAgentEngines({ requested: [], installed: undefined, integrationCounts: new Map() });
    expect(rows.every((row) => row.installed === null)).toBe(true);
  });
});

describe("AgentEngineStateStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ve-engines-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined when nothing was written", async () => {
    const store = new AgentEngineStateStore(dir);
    expect(await store.readRequested()).toBeUndefined();
    expect(await store.readInstalled()).toBeUndefined();
  });

  it("writes a launcher-readable requested list", async () => {
    const store = new AgentEngineStateStore(join(dir, "nested"));
    expect(await store.writeRequested(["cursor", "aider"])).toEqual(["copilot", "aider", "cursor"]);
    const text = await readFile(join(dir, "nested", REQUESTED_ENGINES_FILE), "utf8");
    expect(text.split("\n").filter((line) => line && !line.startsWith("#"))).toEqual(["copilot", "aider", "cursor"]);
    expect(await store.readRequested()).toEqual(["copilot", "aider", "cursor"]);
  });

  it("reads the installed list reported by the launcher", async () => {
    await writeFile(join(dir, INSTALLED_ENGINES_FILE), "copilot\nclaude\n");
    expect(await new AgentEngineStateStore(dir).readInstalled()).toEqual(["copilot", "claude"]);
  });

  it("seeds only when no selection exists", async () => {
    const store = new AgentEngineStateStore(dir);
    expect(await store.seedRequested(["goose"])).toEqual(["copilot", "goose"]);
    expect(await store.seedRequested(["codex"])).toEqual(["copilot", "goose"]);
  });

  it("seeds the selection from existing agent integrations and reports missing engines", async () => {
    await writeFile(join(dir, INSTALLED_ENGINES_FILE), "copilot\n");
    const state = await initializeAgentEngineState(new AgentEngineStateStore(dir), [
      { provider: "aider", name: "Aider", enabled: true },
      { provider: "codex", name: "Codex", enabled: false },
      { provider: "gerrit", name: "Gerrit", enabled: true },
      { provider: "copilot", name: "Copilot", enabled: true },
    ]);
    expect(state.requested).toEqual(["copilot", "aider", "codex"]);
    expect(state.installed).toEqual(["copilot"]);
    expect(state.missing).toEqual([{ integrationName: "Aider", engine: "aider" }]);
  });
});
