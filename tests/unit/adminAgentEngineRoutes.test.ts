import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import { AgentEngineStateStore } from "../../src/agents/agentEngines.js";
import type { Integration } from "../../src/interfaces.js";
import type { PluginManager } from "../../src/plugins/pluginManager.js";
import { registerBuiltinPlugins } from "../../src/plugins/init.js";

registerBuiltinPlugins();

interface Result {
  status: number;
  body: Record<string, unknown> | null;
}

async function rest(server: Server, path: string, opts: { method?: string; body?: unknown } = {}): Promise<Result> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server not bound");
  const init: RequestInit = { method: opts.method ?? "GET" };
  if (opts.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch(`http://127.0.0.1:${addr.port}${path}`, init);
  const text = await r.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return { status: r.status, body: parsed };
}

function makeBaseDeps(): AdminServerDependencies {
  return {
    stateStore: {
      getActiveTasks: vi.fn(async () => []),
      getAllTasks: vi.fn(async () => []),
      getTask: vi.fn(async () => null),
      getAgentCycles: vi.fn(async () => []),
      getAgentCycleEvents: vi.fn(async () => []),
      getStateTransitions: vi.fn(async () => []),
      pauseTask: vi.fn(async () => { throw new Error("nimpl"); }),
      resumeTask: vi.fn(async () => { throw new Error("nimpl"); }),
      retryTask: vi.fn(async () => { throw new Error("nimpl"); }),
      abandonTask: vi.fn(async () => { throw new Error("nimpl"); }),
      deleteTask: vi.fn(async () => {}),
      getChangesForTask: vi.fn(async () => []),
      getChangesForTasks: vi.fn(async () => []),
      deleteTaskGroup: vi.fn(async () => {}),
      getCostSummary: vi.fn(async () => ({ totalUsd: 0, totalAiCredits: 0, totalPremiumRequests: 0, totalRuns: 0, totalTokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 }, totalRunsWithTokens: 0, perProject: [], sinceEpochSeconds: null })),
      getModelUsageSummary: vi.fn(async () => ({ byModel: [], perProject: [], totalRuns: 0, totalUsd: 0, totalTokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 }, sinceEpochSeconds: null })),
    },
    allowUnauthenticatedAdmin: true,
    config: {
      nodeEnv: "test",
      logLevel: "error",
      maxAgentCycles: 3,
      maxRetryAttempts: 5,
      pollingIntervalMs: 30000,
      agentTimeoutMs: 3600000,
    },
    polling: { isRunning: () => false, getIntervals: () => ({ intervalMs: 30000 }) },
    providers: [],
  };
}

function integration(id: string, provider: string, enabled = true): Integration {
  return { id, provider, name: `${provider}-${id}`, configJson: "{}", enabled } as unknown as Integration;
}

describe("Admin API — agent engine routes", () => {
  let server: Server;
  let dir: string;
  let integrations: Integration[];
  let enablePlugin: ReturnType<typeof vi.fn>;

  async function start(): Promise<void> {
    enablePlugin = vi.fn(async () => {});
    const deps: AdminServerDependencies = {
      ...makeBaseDeps(),
      integrationStore: {
        getIntegrations: vi.fn(async () => integrations),
        getIntegration: vi.fn(async (id: string) => integrations.find((item) => item.id === id) ?? null),
        upsertIntegration: vi.fn(async (input: Integration) => {
          integrations = [...integrations, input];
          return input;
        }),
      } as unknown as NonNullable<AdminServerDependencies["integrationStore"]>,
      pluginManager: { enablePlugin, isIntegrationActive: () => false } as unknown as PluginManager,
      agentEngines: new AgentEngineStateStore(dir),
    };
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ve-engine-routes-"));
    integrations = [];
    await start();
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("GET reports the default selection with unknown install state", async () => {
    const r = await rest(server, "/api/admin/agent-engines");
    expect(r.status).toBe(200);
    expect(r.body?.["installStateKnown"]).toBe(false);
    expect(r.body?.["rebuildRequired"]).toBe(false);
    const engines = r.body?.["engines"] as Array<Record<string, unknown>>;
    expect(engines.filter((engine) => engine["requested"]).map((engine) => engine["id"])).toEqual(["copilot"]);
  });

  it("PUT saves the selection for the launcher and flags a pending rebuild", async () => {
    await writeFile(join(dir, "agent-engines.installed"), "copilot\n");
    const r = await rest(server, "/api/admin/agent-engines", { method: "PUT", body: { requested: ["aider"] } });
    expect(r.status).toBe(200);
    expect(r.body?.["rebuildRequired"]).toBe(true);
    const engines = r.body?.["engines"] as Array<Record<string, unknown>>;
    expect(engines.find((engine) => engine["id"] === "aider")).toMatchObject({ requested: true, installed: false });
    expect(await readFile(join(dir, "agent-engines.requested"), "utf8")).toContain("\naider\n");
  });

  it("does not report engines kept by AGENT_ENGINES as pending removal", async () => {
    await writeFile(join(dir, "agent-engines.requested"), "copilot\n");
    await writeFile(join(dir, "agent-engines.installed"), "copilot\ngoose\n");
    await writeFile(join(dir, "agent-engines.forced"), "goose\n");
    const r = await rest(server, "/api/admin/agent-engines");
    expect(r.body?.["rebuildRequired"]).toBe(false);
    const engines = r.body?.["engines"] as Array<Record<string, unknown>>;
    expect(engines.find((engine) => engine["id"] === "goose")).toMatchObject({ requested: false, installed: true, forced: true });
  });

  it("PUT rejects unknown engines", async () => {
    const r = await rest(server, "/api/admin/agent-engines", { method: "PUT", body: { requested: ["bogus"] } });
    expect(r.status).toBe(400);
  });

  it("PUT refuses to remove an engine an integration still uses", async () => {
    integrations = [integration("a1", "aider")];
    await new AgentEngineStateStore(dir).writeRequested(["aider"]);
    const r = await rest(server, "/api/admin/agent-engines", { method: "PUT", body: { requested: [] } });
    expect(r.status).toBe(409);
    expect(String(r.body?.["error"])).toContain("aider-a1");
  });

  it("refuses to create an agent integration whose engine is not installed", async () => {
    await writeFile(join(dir, "agent-engines.installed"), "copilot\n");
    const r = await rest(server, "/api/admin/integrations", { method: "POST", body: { provider: "aider", name: "Aider", config: {} } });
    expect(r.status).toBe(409);
    expect(String(r.body?.["error"])).toMatch(/Aider.*not installed/u);
  });

  it("keeps a newly used engine requested and protected from pruning", async () => {
    await writeFile(join(dir, "agent-engines.installed"), "copilot\ngoose\n");
    await writeFile(join(dir, "agent-engines.requested"), "copilot\n");
    const r = await rest(server, "/api/admin/integrations", { method: "POST", body: { provider: "goose", name: "Goose", config: {} } });
    expect(r.status).toBe(201);
    expect(await readFile(join(dir, "agent-engines.requested"), "utf8")).toMatch(/\ngoose\n$/u);
    expect(await readFile(join(dir, "agent-engines.in-use"), "utf8")).toMatch(/\ngoose\n$/u);
  });

  it("refuses to enable an agent integration whose engine is not installed", async () => {
    integrations = [integration("c1", "cursor", false)];
    await writeFile(join(dir, "agent-engines.installed"), "copilot\n");
    const r = await rest(server, "/api/admin/integrations/c1/enable", { method: "PATCH" });
    expect(r.status).toBe(409);
    expect(enablePlugin).not.toHaveBeenCalled();
  });

  it("enables an agent integration once its engine is installed", async () => {
    integrations = [integration("c1", "cursor", false)];
    await writeFile(join(dir, "agent-engines.installed"), "copilot\ncursor\n");
    const r = await rest(server, "/api/admin/integrations/c1/enable", { method: "PATCH" });
    expect(r.status).toBe(200);
    expect(enablePlugin).toHaveBeenCalledWith("c1");
  });

  it("flags plugins whose agent engine is not installed", async () => {
    await writeFile(join(dir, "agent-engines.installed"), "copilot\ngoose\n");
    const r = await rest(server, "/api/admin/plugins");
    const plugins = r.body?.["plugins"] as Array<Record<string, unknown>>;
    const reason = (provider: string): unknown => plugins.find((plugin) => plugin["provider"] === provider)?.["unavailableReason"];
    expect(reason("aider")).toMatch(/not installed/u);
    expect(reason("goose")).toBeUndefined();
    expect(reason("copilot")).toBeUndefined();
    expect(reason("gerrit")).toBeUndefined();
  });
});
