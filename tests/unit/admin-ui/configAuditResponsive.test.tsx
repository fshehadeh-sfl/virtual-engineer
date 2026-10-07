/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/admin/ui/api.js";
import { AuditSection } from "../../../src/admin/ui/views/ConfigView/AuditSection.js";
import type { ApiAuditPage } from "../../../src/admin/ui/types.js";

const page = (id: number, actorName: string): ApiAuditPage => ({
  entries: [{
    id, actorName, actorUserId: "u", action: "agent.create",
    targetType: "agent", targetId: String(id), details: {},
    createdAt: "2026-09-01T00:00:00Z",
  }],
  actions: ["agent.create"], total: 1, offset: 0, limit: 50,
});
afterEach(() => { vi.restoreAllMocks(); });

describe("Audit filters", () => {
  it("ignores an older response after a new actor filter is selected", async () => {
    let resolveOld: ((value: ApiAuditPage) => void) | undefined;
    const get = vi.spyOn(api, "get").mockImplementation(async (path) => {
      if (String(path).includes("actor=old")) return new Promise<ApiAuditPage>((resolve) => { resolveOld = resolve; });
      return String(path).includes("actor=new") ? page(2, "new") : page(0, "initial");
    });
    render(<AuditSection />);
    await screen.findByText("initial");
    fireEvent.change(screen.getByPlaceholderText("Filter by actor…"), { target: { value: "old" } });
    await waitFor(() => expect(get).toHaveBeenCalledWith(expect.stringContaining("actor=old")));
    fireEvent.change(screen.getByPlaceholderText("Filter by actor…"), { target: { value: "new" } });
    await screen.findByText("new");
    resolveOld?.(page(1, "old"));
    await waitFor(() => expect(screen.queryByText("old", { selector: "button" })).toBeNull());
    expect(screen.getByText("new", { selector: "button" })).toBeDefined();
  });

  it("wraps filters and allows the audit table to scroll on narrow viewports", () => {
    vi.spyOn(api, "get").mockResolvedValue(page(1, "user"));
    render(<AuditSection />);
    expect(screen.getByTestId("audit-filters").style.flexWrap).toBe("wrap");
    expect(screen.getByTestId("audit-table").style.overflowX).toBe("auto");
  });
});
