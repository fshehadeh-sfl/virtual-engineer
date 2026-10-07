/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/admin/ui/api.js";
import { ProjectStatisticsView } from "../../../src/admin/ui/views/ConfigView/ProjectStatisticsView.js";
import type { ApiProject, ApiProjectStatistics } from "../../../src/admin/ui/types.js";

const project: ApiProject = {
  id: "p", name: "One", type: "coding", enabled: true, agentId: "a",
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};
const states: ApiProjectStatistics["current"]["byState"] = {
  DETECTED: 0, CONTEXT_BUILDING: 0, AGENT_RUNNING: 0, IN_REVIEW: 0,
  FEEDBACK_PROCESSING: 0, RETRY_CYCLE: 0, MERGED: 0, CLOSING: 0,
  DONE: 0, FAILED: 0, ABANDONED: 0, REVIEW_PENDING: 0,
  REVIEW_RUNNING: 0, REVIEW_COMMENTING: 0, REVIEW_WATCHING: 0,
  REVIEW_DONE: 0, REVIEW_FAILED: 0,
};
const stats: ApiProjectStatistics = {
  projectId: "p", sinceEpochSeconds: 0,
  current: { taskCount: 123, byState: states, byBucket: { active: 0, watching: 0, done: 0, failed: 0 } },
  period: { tasksCreated: 123, terminalTasks: 0, terminalByState: states, terminalByBucket: { active: 0, watching: 0, done: 0, failed: 0 } },
  execution: { cycles: 0, tasksWithCycles: 0, retryTasks: 0, averageCyclesPerTask: null, validation: { samples: 0, passed: 0, failed: 0, skipped: 0 } },
  cost: { totalUsd: 0, totalAiCredits: 0, totalPremiumRequests: 0, totalRuns: 0, totalRunsWithTokens: 0, totalTokens: { input: 0, output: 0, cached: 0, cacheWrite: 0 }, byBucket: [] },
  models: [], timing: { samples: 0, averageSeconds: null, medianSeconds: null }, liveConcurrency: null,
};

afterEach(() => { vi.restoreAllMocks(); });
describe("Statistics request freshness", () => {
  it("hides old period metrics while loading and after a failed period change", async () => {
    let rejectNew: ((error: Error) => void) | undefined;
    vi.spyOn(api, "get").mockImplementation(async (path) => {
      if (String(path).includes("days=30")) return stats;
      return new Promise<ApiProjectStatistics>((_resolve, reject) => { rejectNew = reject; });
    });
    render(<ProjectStatisticsView project={project} onBack={vi.fn()} />);
    await screen.findAllByText("123");
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.queryAllByText("123")).toHaveLength(0);
    await waitFor(() => expect(rejectNew).toBeDefined());
    rejectNew?.(new Error("Network failed"));
    await screen.findByText("Network failed");
    expect(screen.queryAllByText("123")).toHaveLength(0);
  });

  it("hides previous project metrics when the project prop changes", async () => {
    let resolveNew: ((value: ApiProjectStatistics) => void) | undefined;
    vi.spyOn(api, "get").mockImplementation(async (path) => {
      if (String(path).includes("/p/")) return stats;
      return new Promise<ApiProjectStatistics>((resolve) => { resolveNew = resolve; });
    });
    const { rerender } = render(<ProjectStatisticsView project={project} onBack={vi.fn()} />);
    await screen.findAllByText("123");
    rerender(<ProjectStatisticsView project={{ ...project, id: "q", name: "Two" }} onBack={vi.fn()} />);
    expect(screen.queryAllByText("123")).toHaveLength(0);
    await waitFor(() => expect(resolveNew).toBeDefined());
    resolveNew?.({ ...stats, projectId: "q", current: { ...stats.current, taskCount: 4 } });
    await screen.findByText("4", { selector: ".project-stat-value" });
  });
});
