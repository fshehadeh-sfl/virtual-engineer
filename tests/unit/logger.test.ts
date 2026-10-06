import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { childLogger, rootLogger, pinoMock } = vi.hoisted(() => {
  const childLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  const rootLogger = {
    child: vi.fn(() => childLogger),
  };
  const pinoMock = vi.fn(() => rootLogger);

  return { childLogger, rootLogger, pinoMock };
});

vi.mock("pino", () => ({
  default: pinoMock,
}));

describe("getLogger", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv["NODE_ENV"] = process.env["NODE_ENV"];
    savedEnv["LOG_LEVEL"] = process.env["LOG_LEVEL"];

    delete process.env["NODE_ENV"];
    delete process.env["LOG_LEVEL"];

    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    vi.resetModules();
  });

  it("defaults to a silent logger in test when LOG_LEVEL is not set", async () => {
    process.env["NODE_ENV"] = "test";

    const { getLogger } = await import("../../src/logger.js");
    const logger = getLogger("polling-loop");

    expect(logger).toBe(childLogger);
    expect(pinoMock).toHaveBeenCalledWith(expect.objectContaining({
      level: "silent",
      base: { pid: process.pid },
    }));
    expect(rootLogger.child).toHaveBeenCalledWith({ component: "polling-loop" });
  });

  it("honors an explicit LOG_LEVEL override in test", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["LOG_LEVEL"] = "debug";

    const { getLogger } = await import("../../src/logger.js");
    getLogger("orchestrator");

    expect(pinoMock).toHaveBeenCalledWith(expect.objectContaining({
      level: "debug",
    }));
  });

  it("adds entity names right after integration, project, agent, user, and prompt IDs", async () => {
    const { enrichLogFields, setLogContextResolver } = await import("../../src/logger.js");
    setLogContextResolver((kind, id) => ({ [`${kind}Name`]: `${id}-name` }));

    const enriched = enrichLogFields({ integrationId: "i1", projectId: "p1", agentId: "a1", userId: "u1", promptId: "pr1", other: 1 });
    expect(Object.entries(enriched)).toEqual([
      ["integrationId", "i1"], ["integrationName", "i1-name"],
      ["projectId", "p1"], ["projectName", "p1-name"],
      ["agentId", "a1"], ["agentName", "a1-name"],
      ["userId", "u1"], ["userName", "u1-name"],
      ["promptId", "pr1"], ["promptName", "pr1-name"],
      ["other", 1],
    ]);
  });

  it("adds ticket and project context for task IDs, resolving the task's project name", async () => {
    const { enrichLogFields, setLogContextResolver } = await import("../../src/logger.js");
    setLogContextResolver((kind, id) => {
      if (kind === "task") return { ticketId: "#42", projectId: "p1" };
      if (kind === "project") return { projectName: `${id}-name` };
      return undefined;
    });

    expect(enrichLogFields({ taskId: "t1", msgField: "x" })).toEqual({
      taskId: "t1", ticketId: "#42", projectId: "p1", projectName: "p1-name", msgField: "x",
    });
    // Explicit fields on the record win over resolved context.
    expect(enrichLogFields({ taskId: "t1", ticketId: "explicit" })).toEqual({
      taskId: "t1", projectId: "p1", projectName: "p1-name", ticketId: "explicit",
    });
  });

  it.each([
    { taskId: "t1", projectId: "p2" },
    { projectId: "p2", taskId: "t1" },
  ])("resolves the explicit project's name regardless of field order: %j", async (fields) => {
    const { enrichLogFields, setLogContextResolver } = await import("../../src/logger.js");
    const resolver = vi.fn((kind: string, id: string) => {
      if (kind === "task") return { ticketId: "#42", projectId: "p1", projectName: "Original" };
      if (kind === "project") return { projectName: id === "p2" ? "Selected" : "Original" };
      return undefined;
    });
    setLogContextResolver(resolver);

    expect(enrichLogFields(fields)).toEqual(expect.objectContaining({
      taskId: "t1", ticketId: "#42", projectId: "p2", projectName: "Selected",
    }));
    expect(resolver).toHaveBeenCalledWith("project", "p2");
    expect(resolver).not.toHaveBeenCalledWith("project", "p1");
  });

  it("reuses the joined task project name without querying the project again", async () => {
    const { enrichLogFields, setLogContextResolver } = await import("../../src/logger.js");
    const resolver = vi.fn((kind: string) => {
      if (kind === "task") return { ticketId: "#42", projectId: "p1", projectName: "Original" };
      if (kind === "project") return { projectName: "Should not be used" };
      return undefined;
    });
    setLogContextResolver(resolver);

    expect(enrichLogFields({ taskId: "t1" })).toEqual({
      taskId: "t1", ticketId: "#42", projectId: "p1", projectName: "Original",
    });
    expect(enrichLogFields({ taskId: "t1", projectId: "p1" })).toEqual({
      taskId: "t1", ticketId: "#42", projectName: "Original", projectId: "p1",
    });
    expect(resolver).not.toHaveBeenCalledWith("project", "p1");
  });

  it("keeps explicit names, skips unknown IDs, and survives resolver failures", async () => {
    const { enrichLogFields, setLogContextResolver } = await import("../../src/logger.js");
    setLogContextResolver((kind) => {
      if (kind === "agent") throw new Error("db closed");
      return kind === "project" ? undefined : { integrationName: "resolved" };
    });

    const input = { integrationId: "i1", integrationName: "explicit", projectId: "p1", agentId: "a1" };
    expect(enrichLogFields(input)).toEqual(input);

    setLogContextResolver(null);
    expect(enrichLogFields({ projectId: "p1" })).toEqual({ projectId: "p1" });
  });

  it("wires name enrichment into the pino log formatter", async () => {
    const { setLogContextResolver, getLogger } = await import("../../src/logger.js");
    setLogContextResolver(() => ({ projectName: "Main" }));
    getLogger("main");

    const options = (pinoMock.mock.calls[0] as unknown as [{ formatters: { log: (o: Record<string, unknown>) => Record<string, unknown> } }])[0];
    expect(options.formatters.log({ projectId: "p1" })).toEqual({ projectId: "p1", projectName: "Main" });
  });
});
