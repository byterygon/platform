import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { focus, key } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Chart, ChartSparkline, decimate, niceTicks } from "./chart";

afterEach(cleanup);

const data = [
  { m: "Jan", reads: 10, writes: 4 },
  { m: "Feb", reads: 25, writes: 6 },
  { m: "Mar", reads: 18, writes: 9 },
];
const series = [
  { key: "reads", label: "Reads" },
  { key: "writes", label: "Writes" },
];

describe("Chart", () => {
  test("niceTicks covers the range with 1/2/5 steps", () => {
    expect(niceTicks(0, 25)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(niceTicks(0, 520)).toEqual([0, 200, 400, 600]);
    expect(niceTicks(-3, 7)).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });

  test("decimate keeps every point when they fit, and min/max per column otherwise", () => {
    expect(decimate([1, 2, 3], 100)).toEqual([0, 1, 2]);
    const values = Array.from({ length: 10_000 }, (_, i) => (i === 5000 ? 999 : i % 7));
    const kept = decimate(values, 100);
    expect(kept.length).toBeLessThanOrEqual(200);
    expect(kept).toContain(5000);
  });

  test("a bar chart: a focusable, labelled group, one rect per value, a legend and a hidden table", async () => {
    const { container } = render(<Chart aria-label="Statements" data={data} x="m" series={series} />);
    const plot = container.querySelector('[data-slot="chart-plot"]') as HTMLElement;
    expect(plot.getAttribute("role")).toBe("group");
    expect(plot.getAttribute("aria-roledescription")).toBe("chart");
    expect(plot.tabIndex).toBe(0);
    expect(container.querySelectorAll('[data-slot="chart-plot"] svg rect.fill-chart-1')).toHaveLength(3);
    expect(container.querySelectorAll('[data-slot="chart-plot"] svg rect.fill-chart-2')).toHaveLength(3);
    expect(container.querySelector('[data-slot="chart-legend"]')!.textContent).toBe("ReadsWrites");
    const table = container.querySelector(`#${CSS.escape(plot.getAttribute("aria-describedby")!)}`)!;
    expect(table.tagName).toBe("TABLE");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("arrow keys move the guide; the tooltip and the live region say the values", async () => {
    const onActiveIndexChange = vi.fn();
    const { container } = render(<Chart aria-label="Statements" data={data} x="m" series={series} onActiveIndexChange={onActiveIndexChange} />);
    const plot = container.querySelector('[data-slot="chart-plot"]') as HTMLElement;
    await focus(plot);
    await key("ArrowRight", plot);
    await key("ArrowRight", plot);
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(1);
    expect(container.querySelector('[data-slot="chart-tooltip"]')!.textContent).toContain("Feb");
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Feb: Reads 25, Writes 6");
    await key("End", plot);
    expect(onActiveIndexChange).toHaveBeenLastCalledWith(2);
    await key("Escape", plot);
    expect(container.querySelector('[data-slot="chart-tooltip"]')).toBeNull();
  });

  test("lines differ by dash pattern and marker, not only colour", () => {
    const { container } = render(<Chart type="line" aria-label="Lines" data={data} x="m" series={series} />);
    const lines = [...container.querySelectorAll<SVGPathElement>('svg path[fill="none"]')];
    expect(lines).toHaveLength(2);
    expect(lines[0]!.getAttribute("stroke-dasharray")).toBeNull();
    expect(lines[1]!.getAttribute("stroke-dasharray")).toBe("6 3");
    expect(container.querySelectorAll("svg circle")).toHaveLength(3);
    expect(container.querySelectorAll("svg rect.stroke-surface")).toHaveLength(3);
  });

  test("a long series is decimated and summarized instead of tabulated", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ t: i, v: i % 100 }));
    const { container } = render(<Chart type="line" aria-label="Big" data={big} x="t" series={[{ key: "v", label: "V" }]} />);
    const d = container.querySelector('svg path[fill="none"]')!.getAttribute("d")!;
    expect(d.split("L").length).toBeLessThan(2000);
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("5,000 points");
  });

  test("stacked areas, an empty chart, and the ref", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<Chart ref={ref} type="area" stacked aria-label="Stack" data={data} x="m" series={series} />);
    expect(container.querySelectorAll("svg path.fill-chart-1\\/20, svg path.fill-chart-2\\/20")).toHaveLength(2);
    expect(ref.current?.dataset.type).toBe("area");
    cleanup();
    const empty = render(<Chart aria-label="Locks" data={[]} series={series} />);
    expect(empty.container.querySelector('[data-slot="chart-empty"]')!.getAttribute("aria-label")).toBe("Locks: no data");
  });

  test("ChartSparkline is an image whose label states the range", () => {
    const { container } = render(<ChartSparkline aria-label="Inserts" values={[3, 9, 1, 7]} />);
    const svg = container.querySelector('[data-slot="chart-sparkline"]')!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Inserts: from 3 to 7, lowest 1, highest 9");
  });
});
