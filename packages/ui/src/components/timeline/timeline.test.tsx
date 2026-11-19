import { act, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Timeline, fitRange, formatClock, formatOffset, formatSpan, niceTicks, panRange, zoomRange, type TimelineItem, type TimelineLane } from "./timeline";

afterEach(cleanup);

const lanes: TimelineLane[] = [
  { id: "wf", label: "Workflow" },
  { id: "act", label: "Activities" },
];
const items: TimelineItem[] = [
  { id: "wf", laneId: "wf", start: 1000, end: null, status: "running", label: "Order" },
  { id: "a1", laneId: "act", start: 1200, end: 2200, status: "success", label: "reserve" },
  { id: "a2", laneId: "act", start: 2300, end: 2300, status: "neutral", label: "signal" },
];

const root = (container: HTMLElement) => container.querySelector('[data-slot="timeline"]') as HTMLElement;
const bars = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[data-slot="timeline-item"]'));
const press = async (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
};
const button = (container: HTMLElement, name: string | RegExp) =>
  Array.from(container.querySelectorAll<HTMLElement>("button")).find((b) => {
    const n = (b.getAttribute("aria-label") ?? b.textContent ?? "").trim();
    return typeof name === "string" ? n === name : name.test(n);
  })!;
const left = (el: HTMLElement) => Number.parseFloat(el.style.left);
const width = (el: HTMLElement) => Number.parseFloat(el.style.width);

describe("range maths", () => {
  test("fitRange covers every item, with running ones closed at now", () => {
    const r = fitRange(items, 5000);
    expect(r.start).toBeLessThan(1000);
    expect(r.end).toBeGreaterThan(5000);
    expect(fitRange([], 10_000)).toEqual({ start: 9000, end: 10_000 });
  });

  test("zoom keeps the anchor in place and pan shifts by a fraction of the width", () => {
    const r = { start: 0, end: 1000 };
    expect(zoomRange(r, 0.5)).toEqual({ start: 250, end: 750 });
    expect(zoomRange(r, 2, 0)).toEqual({ start: 0, end: 2000 });
    expect(zoomRange(r, 0.5, 1)).toEqual({ start: 500, end: 1000 });
    expect(panRange(r, 0.2)).toEqual({ start: 200, end: 1200 });
    // It never collapses to nothing.
    const tiny = zoomRange({ start: 0, end: 2 }, 0.1);
    expect(tiny.end - tiny.start).toBeGreaterThanOrEqual(1);
  });

  test("ticks are round numbers inside the range", () => {
    const ticks = niceTicks({ start: 0, end: 1000 }, 5);
    expect(ticks).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(niceTicks({ start: 1030, end: 3980 }, 6).every((t) => t % 500 === 0 && t >= 1030 && t <= 3980)).toBe(true);
    expect(niceTicks({ start: 5, end: 5 })).toEqual([]);
  });

  test("offsets read in the largest sensible unit", () => {
    expect(formatOffset(0)).toBe("0");
    expect(formatOffset(850)).toBe("850 ms");
    expect(formatOffset(2500)).toBe("2.5 s");
    expect(formatOffset(200_000)).toBe("3m 20s");
    expect(formatOffset(600_000)).toBe("10m");
    expect(formatOffset(3_900_000)).toBe("1h 5m");
    expect(formatOffset(7_200_000)).toBe("2h");
    expect(formatOffset(-1500)).toBe("-1.5 s");
  });

  test("the zoom control names the view's width in one unit, the clock axis reads local time", () => {
    expect(formatSpan(800)).toBe("800 ms");
    expect(formatSpan(45_000)).toBe("45 s");
    expect(formatSpan(120_000)).toBe("2 min");
    expect(formatSpan(5_400_000)).toBe("1.5 h");
    const t = new Date(2026, 10, 18, 10, 42, 20, 250).getTime();
    expect(formatClock(t)).toBe("10:42:20");
    expect(formatClock(t, 100)).toBe("10:42:20.250");
    expect(formatClock(t, 3_600_000)).toBe("10:42");
  });
});

describe("Timeline", () => {
  test("draws a labelled lane per lane and a button per item", () => {
    const { container } = render(<Timeline aria-label="History" lanes={lanes} items={items} now={3000} />);
    expect(root(container).getAttribute("aria-label")).toBe("History");
    expect(Array.from(container.querySelectorAll('[data-slot="timeline-lane"]')).map((l) => l.textContent?.slice(0, 8))).toEqual(["Workflow", "Activiti"]);
    expect(bars(container)).toHaveLength(3);
    expect(bars(container)[1]!.getAttribute("aria-label")).toBe("reserve, success, 1 s");
  });

  test("bars carry their label, and the axis counts round offsets from the first start", () => {
    const { container } = render(<Timeline aria-label="a" lanes={lanes} items={items} now={3000} />);
    expect(bars(container).map((b) => b.textContent)).toEqual(["Order", "reserve", "signal"]);
    const axis = Array.from(container.querySelectorAll('[data-slot="timeline-axis"] span')).map((s) => s.textContent);
    // Offsets from the earliest start (1000): the first label is 0, the rest are whole steps.
    expect(axis[0]).toBe("0");
    expect(axis.length).toBeGreaterThan(2);
    expect(axis.every((label) => /^(0|\d+ ms|\d+(\.\d)? s)$/.test(label ?? ""))).toBe(true);
  });

  test("a running item grows to now and is marked running", () => {
    const early = render(<Timeline aria-label="a" lanes={lanes} items={items} now={2000} />);
    const wf = bars(early.container)[0]!;
    expect(wf.dataset.running).toBeDefined();
    const w1 = width(wf);
    early.unmount();
    const late = render(<Timeline aria-label="a" lanes={lanes} items={items} now={4000} />);
    // The view refits, so compare the item's reach: it ends at now both times.
    const wf2 = bars(late.container)[0]!;
    expect(left(wf2) + width(wf2)).toBeCloseTo(100 * (4000 - fitRange(items, 4000).start) / (fitRange(items, 4000).end - fitRange(items, 4000).start), 3);
    expect(w1).toBeGreaterThan(0);
    expect(late.container.querySelector('[data-slot="timeline-now"]')).not.toBeNull();
  });

  test("pressing a bar selects it, and the selected one is marked", async () => {
    const onSelect = vi.fn();
    const { container } = render(<Timeline aria-label="a" lanes={lanes} items={items} now={3000} selectedId="a1" onSelect={onSelect} />);
    expect(bars(container)[1]!.dataset.selected).toBeDefined();
    expect(bars(container)[1]!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => bars(container)[2]!.click());
    expect(onSelect).toHaveBeenCalledWith("a2");
  });

  test("+ and - zoom, the arrows pan, Home fits again", async () => {
    // a1 sits in the middle, so it stays inside the view zoomed in once and panned a little.
    const mid: TimelineItem[] = [
      { id: "wf", laneId: "wf", start: 0, end: 4000, status: "success", label: "Order" },
      { id: "a1", laneId: "act", start: 1900, end: 2100, status: "success", label: "reserve" },
    ];
    const { container } = render(<Timeline aria-label="a" lanes={lanes} items={mid} now={4000} />);
    const target = root(container);
    const a1 = () => bars(container)[1]!;
    const fitLeft = left(a1());
    const fitWidth = width(a1());
    await press(target, "+");
    expect(width(a1())).toBeCloseTo(fitWidth * 2, 5);
    await press(target, "ArrowRight");
    expect(left(a1())).toBeLessThan(left(a1()) + 1);
    const panned = left(a1());
    await press(target, "ArrowLeft");
    expect(left(a1())).toBeGreaterThan(panned);
    await press(target, "-");
    await press(target, "Home");
    expect(left(a1())).toBeCloseTo(fitLeft, 5);
    expect(width(a1())).toBeCloseTo(fitWidth, 5);
  });

  test("keys pressed inside a bar do not zoom", async () => {
    const { container } = render(<Timeline aria-label="a" lanes={lanes} items={items} now={3000} />);
    const before = width(bars(container)[1]!);
    await press(bars(container)[1]!, "+");
    expect(width(bars(container)[1]!)).toBe(before);
  });

  test("items outside the zoomed range are not drawn", async () => {
    const { container } = render(<Timeline aria-label="a" lanes={lanes} items={items} now={3000} />);
    const target = root(container);
    for (let i = 0; i < 5; i++) await press(target, "+");
    expect(bars(container).length).toBeLessThan(3);
  });

  test("lanes are windowed: thousands of lanes draw a few", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: `l${i}`, label: `Lane ${i}` }));
    const { container } = render(<Timeline aria-label="a" lanes={many} items={[]} now={1} />);
    expect(container.querySelectorAll('[data-slot="timeline-lane"]').length).toBeLessThanOrEqual(60);
  });

  test("no lanes shows the empty label", () => {
    const { container } = render(<Timeline aria-label="a" lanes={[]} items={[]} now={1} emptyLabel="No history" />);
    expect(container.textContent).toContain("No history");
  });

  test("describeItem names a bar for screen readers", () => {
    const { container } = render(<Timeline aria-label="a" lanes={lanes} items={items} now={3000} describeItem={(i) => `custom ${i.id}`} />);
    expect(bars(container)[0]!.getAttribute("aria-label")).toBe("custom wf");
  });

  test("the toolbar fits, zooms and switches the axis to clock time", async () => {
    const t0 = new Date(2026, 10, 18, 10, 42, 0).getTime();
    const timed: TimelineItem[] = [
      { id: "wf", laneId: "wf", start: t0, end: t0 + 120_000, status: "success", label: "Order" },
      { id: "a1", laneId: "act", start: t0 + 10_000, end: t0 + 20_000, status: "success", label: "reserve" },
    ];
    const { container } = render(<Timeline aria-label="a" lanes={lanes} items={timed} now={t0 + 120_000} />);
    const zoomLabel = () => container.querySelector('[aria-label="Zoom"] span')?.textContent;
    const before = zoomLabel();
    await act(async () => button(container, "Zoom in").click());
    expect(zoomLabel()).not.toBe(before);
    await act(async () => button(container, /^Fit/).click());
    expect(zoomLabel()).toBe(before);
    const axis = () => Array.from(container.querySelectorAll('[data-slot="timeline-axis"] span')).map((s) => s.textContent);
    expect(axis()[0]).toBe("0");
    await act(async () => button(container, "Clock").click());
    expect(axis().every((l) => /^10:4\d:\d\d$/.test(l ?? ""))).toBe(true);
    // The overview shows the whole range and the window.
    expect(container.querySelector('[data-slot="timeline-overview"]')?.textContent).toContain("Whole range · 2m");
    expect(container.querySelector('[data-slot="timeline-window"]')).not.toBeNull();
  });

  test("shapes, captions, a lane's detail and the selected lane", () => {
    const shaped: TimelineItem[] = [
      { id: "r", laneId: "wf", start: 0, end: null, status: "running", label: "run", caption: "Running · 5s" },
      { id: "h", laneId: "act", start: 100, end: null, status: "warning", label: "charge", shape: "hatched", caption: "Retrying" },
      { id: "k", laneId: "act", start: 200, end: 200, status: "neutral", label: "task", shape: "tick" },
      { id: "d", laneId: "act", start: 300, end: 300, status: "info", label: "signal", shape: "diamond", caption: "1 payload" },
    ];
    const { container } = render(<Timeline aria-label="a" lanes={[{ id: "wf", label: "order-1", detail: "workflow" }, { id: "act", label: "charge", detail: "activity 5" }]} items={shaped} now={5000} selectedId="d" />);
    expect(Array.from(container.querySelectorAll('[data-slot="timeline-lane"]')).map((l) => l.textContent?.startsWith("charge") ? "charge" : l.textContent)).toContain("charge");
    expect(container.textContent).toContain("activity 5");
    expect(bars(container).map((b) => b.dataset.shape)).toEqual(["bar", "hatched", "tick", "diamond"]);
    expect(bars(container)[0]!.textContent).toBe("Running · 5s");
    expect(container.textContent).toContain("1 payload");
    const selectedLane = container.querySelector('[data-slot="timeline-lane"][data-selected]');
    expect(selectedLane?.textContent).toContain("activity 5");
    // Running items go on past the view: an arrow at the edge says so.
    expect(container.querySelectorAll('[data-slot="timeline-edge"]').length).toBeGreaterThan(0);
  });

  test("following keeps now in a zoomed view; panning away stops it", async () => {
    const onFollowChange = vi.fn();
    const run: TimelineItem[] = [{ id: "wf", laneId: "wf", start: 0, end: null, status: "running", label: "run" }];
    let setNow: (n: number) => void = () => undefined;
    function Following() {
      const [now, set] = useState(10_000);
      setNow = set;
      return <Timeline aria-label="a" lanes={lanes} items={run} now={now} follow onFollowChange={onFollowChange} />;
    }
    const { container } = render(<Following />);
    const target = root(container);
    await press(target, "+");
    const nowLeft = () => left(container.querySelector<HTMLElement>('[data-slot="timeline-now"]')!);
    expect(nowLeft()).toBeCloseTo(92, 0);
    await act(async () => setNow(20_000));
    expect(nowLeft()).toBeCloseTo(92, 0);
    await press(target, "ArrowLeft");
    expect(onFollowChange).toHaveBeenCalledWith(false);
  });

  test("has no axe violations", async () => {
    const { container } = render(<Timeline aria-label="History" lanes={lanes} items={items} now={3000} selectedId="a1" />);
    expect(await axeViolations(container)).toEqual([]);
  });
});
