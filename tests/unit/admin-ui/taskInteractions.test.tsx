/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/admin/ui/api.js";
import { CurrentUserProvider } from "../../../src/admin/ui/authContext.js";
import { TaskDetail } from "../../../src/admin/ui/views/TasksView/TaskDetail.js";
import { TaskList } from "../../../src/admin/ui/views/TasksView/TaskList.js";
import { TasksView } from "../../../src/admin/ui/views/TasksView/index.js";
import type { ApiTask } from "../../../src/admin/ui/types.js";

const task: ApiTask = {
  taskId: "task-1",
  taskType: "code-gen",
  ticketId: "ticket-1",
  ticketSourceLabel: "github",
  ticketTitle: "Fix task",
  ticketDescription: "",
  state: "FAILED",
  gerritChangeId: null,
  currentPatchset: 0,
  reviewedPatchset: null,
  cycleCount: 0,
  failureReason: null,
  ticketUrl: null,
  reviewUrl: null,
  displayId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("task interactions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks before permanently deleting a terminal task", () => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(api, "get").mockResolvedValue({ task, cycles: [], transitions: [] });
    const deleteTask = vi.spyOn(api, "delete").mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <CurrentUserProvider value={{ user: { id: "u", username: "admin", role: "admin" }, isAdmin: true, canOperate: true, can: () => true }}>
        <TaskDetail task={task} onRefresh={vi.fn()} onDeleted={vi.fn()} />
      </CurrentUserProvider>,
    );

    fireEvent.click(screen.getByTitle("Delete task"));

    expect(confirm).toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("uses effective task permissions, not just the operator role, for actions", () => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(api, "get").mockResolvedValue({ task, cycles: [], transitions: [] });
    const { rerender } = render(
      <CurrentUserProvider value={{ user: { id: "u", username: "operator", role: "operator" }, isAdmin: false, canOperate: true, can: () => false }}>
        <TaskDetail task={{ ...task, permissions: { operate: true, delete: false } }} onRefresh={vi.fn()} onDeleted={vi.fn()} />
      </CurrentUserProvider>,
    );
    expect(screen.getByTitle("Retry")).toBeTruthy();
    expect(screen.queryByTitle("Delete task")).toBeNull();

    rerender(
      <CurrentUserProvider value={{ user: { id: "u", username: "operator", role: "operator" }, isAdmin: false, canOperate: true, can: () => true }}>
        <TaskDetail task={{ ...task, permissions: { operate: false, delete: false } }} onRefresh={vi.fn()} onDeleted={vi.fn()} />
      </CurrentUserProvider>,
    );
    expect(screen.queryByTitle("Retry")).toBeNull();
    expect(screen.queryByTitle("Delete task")).toBeNull();
  });

  it("classifies detected tasks as active and closing tasks as active", () => {
    render(
      <TaskList
        tasks={[
          { ...task, taskId: "detected", ticketTitle: "Detected task", state: "DETECTED" },
          { ...task, taskId: "closing", ticketTitle: "Closing task", state: "CLOSING" },
        ]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    expect(screen.getByText("Detected task")).toBeTruthy();
    expect(screen.getByText("Closing task")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Watching" }));
    expect(screen.queryByText("Detected task")).toBeNull();
  });

  it("exposes the external ticket link separately from the task selection button", () => {
    render(<TaskList tasks={[{ ...task, ticketUrl: "https://example.test/ticket/1" }]} selectedId={null} onSelect={vi.fn()} />);
    const link = screen.getByRole("link", { name: /TICKET-1/i });
    expect(link.closest("button")).toBeNull();
  });

  it("distinguishes failed cycle and timeline requests from empty results", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.spyOn(api, "get").mockImplementation((path) =>
      path.endsWith("/cycles") || path.endsWith("/transitions")
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ task }));
    render(<TaskDetail task={task} onRefresh={vi.fn()} onDeleted={vi.fn()} />);

    expect(await screen.findByText("Failed to load agent cycles.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /State timeline/ }));
    expect(await screen.findByText("Failed to load state timeline.")).toBeTruthy();
  });

  it("lets a narrow screen switch between the queue and task detail", () => {
    window.history.replaceState({}, "", "#tasks");
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.spyOn(api, "get").mockResolvedValue({ task, cycles: [], transitions: [] });
    render(<TasksView tasks={[task]} onRefresh={vi.fn()} />);

    expect(screen.getByText("Task queue")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Fix task/ }));
    expect(screen.queryByText("Task queue")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to tasks" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
    expect(screen.getByText("Task queue")).toBeTruthy();
  });
});
