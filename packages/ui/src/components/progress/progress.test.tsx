import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Progress } from "./progress";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bar = (container: HTMLElement) => container.querySelector('[data-slot="progress"]') as HTMLElement;

describe("Progress", () => {
  test("is a progressbar named by its label with the value", async () => {
    const { container } = render(<Progress value={40} label="Exporting" showValue />);
    await act(async () => {});
    const root = bar(container);
    expect(root.getAttribute("role")).toBe("progressbar");
    expect(root.getAttribute("aria-valuenow")).toBe("40");
    const label = container.querySelector('[data-slot="progress-label"]')!;
    expect(root.getAttribute("aria-labelledby")).toBe(label.id);
    expect(container.querySelector('[data-slot="progress-value"]')!.textContent).toBe("40%");
    expect((container.querySelector('[data-slot="progress-indicator"]') as HTMLElement).style.width).toBe("40%");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("value={null} is indeterminate: no aria-valuenow, a sliding third of the track", async () => {
    const animate = vi.fn(() => ({ cancel: () => {} }));
    HTMLElement.prototype.animate = animate as never;
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const { container } = render(<Progress value={null} aria-label="Counting rows" />);
    await act(async () => {});
    expect(bar(container).hasAttribute("aria-valuenow")).toBe(false);
    expect(bar(container).hasAttribute("data-indeterminate")).toBe(true);
    expect(animate).toHaveBeenCalledOnce();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  test("a determinate bar does not animate", () => {
    const animate = vi.fn(() => ({ cancel: () => {} }));
    HTMLElement.prototype.animate = animate as never;
    render(<Progress value={10} aria-label="Export" />);
    expect(animate).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  test("getAriaValueText, max, variant and ref", async () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<Progress ref={ref} value={5} max={10} variant="danger" aria-label="Rows" getAriaValueText={() => "5 of 10 rows"} />);
    await act(async () => {});
    expect(bar(container).getAttribute("aria-valuetext")).toBe("5 of 10 rows");
    expect(ref.current?.dataset.variant).toBe("danger");
  });
});
