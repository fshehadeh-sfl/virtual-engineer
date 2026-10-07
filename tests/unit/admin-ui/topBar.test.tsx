/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TopBar } from "../../../src/admin/ui/shell/TopBar.js";

describe("TopBar tutorial launcher", () => {
  it("places an accessible tutorial button between password and logout", async () => {
    const user = userEvent.setup();
    const onStartTutorial = vi.fn();

    render(
      <TopBar
        view="overview"
        setView={() => undefined}
        theme="dark"
        toggleTheme={() => undefined}
        user={{ id: "user-1", username: "admin", role: "admin" }}
        canViewConfig
        onChangePassword={() => undefined}
        onStartTutorial={onStartTutorial}
        onLogout={() => undefined}
        taskCount={0}
        activeCount={0}
        projectCount={0}
        pollingRunning={false}
      />,
    );

    const changePassword = screen.getByTitle("Change password");
    const tutorial = screen.getByRole("button", { name: "Start tutorial" });
    const logout = screen.getByRole("button", { name: "Sign out" });

    expect(tutorial.getAttribute("data-tour")).toBe("tutorial-launcher");
    expect(changePassword.nextElementSibling).toBe(tutorial);
    expect(tutorial.nextElementSibling).toBe(logout);

    await user.click(tutorial);
    expect(onStartTutorial).toHaveBeenCalledOnce();
  });

  it("shows task, active, and project counters without integrations", () => {
    const { container } = render(
      <TopBar
        view="overview"
        setView={() => undefined}
        theme="dark"
        toggleTheme={() => undefined}
        user={{ id: "user-1", username: "admin", role: "admin" }}
        canViewConfig
        onChangePassword={() => undefined}
        onStartTutorial={() => undefined}
        onLogout={() => undefined}
        taskCount={7}
        activeCount={2}
        projectCount={3}
        pollingRunning={false}
      />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("7 tasks");
    expect(text).toContain("2 active");
    expect(text).toContain("3 projects");
    expect(text).not.toContain("integrations");
  });
});