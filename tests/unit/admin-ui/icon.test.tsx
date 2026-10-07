/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon } from "../../../src/admin/ui/components/Icon.js";

describe("Icon", () => {
  it("renders every path of multi-path SVG icons", () => {
    const { container } = render(<Icon name="clock" />);
    expect(container.querySelectorAll("path")).toHaveLength(2);
  });

  it("renders the statistics bar-chart icon", () => {
    const { container } = render(<Icon name="bar-chart" />);
    expect(container.querySelector("path")?.getAttribute("d")).toMatch(/^M4 19h16v2H4z/);
  });
});
