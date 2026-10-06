import { describe, it, expect, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createAdminServer, type AdminServerDependencies } from "../../src/admin/adminServer.js";
import { makeTaskId, makeTicketId } from "../../src/interfaces.js";
import type { AgentCycle, Task, TaskState } from "../../src/interfaces.js";

async function rest(server: Server | null, path: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  if (!server) throw new Error("Server not started");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Server not bound");
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return { status: res.status, body: parsed };
}

const NOW = Date.now();

function makeTask(id: string, state: TaskState, updatedAt: Date): Task {
  return {
    taskId: makeTaskId(id),
    ticketId: makeTicketId(`ticket-${id}`),
    ticketSourceLabel: "redmine",
    ticketTitle: `Task ${id}`,
    ticketDescription: "",
    state,
    taskType: state.startsWith("REVIEW_") ? "code-review" : "code-gen",
    externalChangeId: null,
    currentPatchset: 0,
    reviewedPatchset: null,
    cycleCount: 0,
    createdAt: updatedAt,
    updatedAt,
    failureReason: null,
    ticketUrl: null,
    reviewUrl: null,
    displayId: null,
  };
}

function makeDeps(tasks: Task[]): AdminServerDependencies {
  return {
    stateStore: {
      getActiveTasks: vi.fn(async () => []),
      getAllTasks: vi.fn(async () => tasks),
      getTask: vi.fn(async () => null),
      getAgentCycles: vi.fn(async () => []),
      getAgentCycleEvents: vi.fn(async () => []),
      getStateTransitions: vi.fn(async () => []),
      pauseTask: vi.fn(async () => { throw new Error("not impl"); }),
      resumeTask: vi.fn(async () => { throw new Error("not impl"); }),
      retryTask: vi.fn(async () => { throw new Error("not impl"); }),
      abandonTask: vi.fn(async () => { throw new Error("not impl"); }),
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

describe("Admin API — Overview route stats bucketing", () => {
  let server: Server | null = null;

  async function start(tasks: Task[]): Promise<void> {
    server = createAdminServer(makeDeps(tasks));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((err) => err ? reject(err) : resolve()));
      server = null;
    }
  });

  it("counts a DETECTED task as active (previously fell into no bucket)", async () => {
    await start([makeTask("t1", "DETECTED", new Date(NOW))]);
    const r = await rest(server, "/api/admin/overview");
    expect(r.status).toBe(200);
    expect((r.body?.["stats"] as Record<string, unknown>)["activeTasks"]).toBe(1);
  });

  it("counts a recently-updated ABANDONED task as failed (previously fell into no bucket)", async () => {
    await start([makeTask("t1", "ABANDONED", new Date(NOW))]);
    const r = await rest(server, "/api/admin/overview");
    expect(r.status).toBe(200);
    expect((r.body?.["stats"] as Record<string, unknown>)["failedLast7d"]).toBe(1);
  });

  it("buckets one representative state per remaining category", async () => {
    await start([
      makeTask("gen", "AGENT_RUNNING", new Date(NOW)),
      makeTask("watch", "IN_REVIEW", new Date(NOW)),
      makeTask("done", "MERGED", new Date(NOW)),
      makeTask("fail", "FAILED", new Date(NOW)),
    ]);
    const r = await rest(server, "/api/admin/overview");
    expect(r.status).toBe(200);
    const stats = r.body?.["stats"] as Record<string, unknown>;
    expect(stats["activeTasks"]).toBe(1);
    expect(stats["watchingTasks"]).toBe(1);
    expect(stats["completedLast7d"]).toBe(1);
    expect(stats["failedLast7d"]).toBe(1);
  });

  it("excludes done/failed tasks updated more than 7 days ago from the 7-day counters", async () => {
    const eightDaysAgo = new Date(NOW - 8 * 24 * 60 * 60 * 1000);
    await start([
      makeTask("old-done", "DONE", eightDaysAgo),
      makeTask("old-fail", "FAILED", eightDaysAgo),
    ]);
    const r = await rest(server, "/api/admin/overview");
    expect(r.status).toBe(200);
    const stats = r.body?.["stats"] as Record<string, unknown>;
    expect(stats["completedLast7d"]).toBe(0);
    expect(stats["failedLast7d"]).toBe(0);
  });
});

describe("Admin API — Review votes period filter", () => {
  let server: Server | null = null;
  const DAY = 24 * 60 * 60 * 1000;

  function cycle(taskId: string, score: number, createdAt: Date): AgentCycle {
    return {
      id: 1,
      taskId: makeTaskId(taskId),
      cycleNumber: 1,
      result: { metadata: { score } } as unknown as AgentCycle["result"],
      validationResult: null,
      createdAt,
    };
  }

  async function start(): Promise<void> {
    const tasks = [
      makeTask("r-today", "REVIEW_DONE", new Date(NOW - 60 * 60 * 1000)),
      makeTask("r-3d", "REVIEW_DONE", new Date(NOW - 3 * DAY)),
      makeTask("r-20d", "REVIEW_DONE", new Date(NOW - 20 * DAY)),
      makeTask("r-90d", "REVIEW_DONE", new Date(NOW - 90 * DAY)),
    ];
    const cycles: Record<string, AgentCycle[]> = {
      "r-today": [cycle("r-today", 2, new Date(NOW - 60 * 60 * 1000))],
      "r-3d": [cycle("r-3d", 1, new Date(NOW - 3 * DAY))],
      "r-20d": [cycle("r-20d", -1, new Date(NOW - 20 * DAY))],
      "r-90d": [cycle("r-90d", -2, new Date(NOW - 90 * DAY))],
    };
    const deps = makeDeps(tasks);
    deps.stateStore.getAgentCycles = vi.fn(async (id) => cycles[id] ?? []);
    server = createAdminServer(deps);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((err) => err ? reject(err) : resolve()));
      server = null;
    }
  });

  it.each([
    ["?days=1", { plus2: 1, plus1: 0, minus1: 0, minus2: 0 }],
    ["?days=7", { plus2: 1, plus1: 1, minus1: 0, minus2: 0 }],
    ["?days=30", { plus2: 1, plus1: 1, minus1: 1, minus2: 0 }],
    ["", { plus2: 1, plus1: 1, minus1: 1, minus2: 1 }],
  ])("counts votes within %s", async (query, expected) => {
    await start();
    const r = await rest(server, `/api/admin/review-votes${query}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expected);
  });
});
