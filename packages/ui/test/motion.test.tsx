import { useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tokens } from "@byterygon/design-tokens/default/tokens";
import { MOTION_DURATION_MS, MOTION_EASING, durationVar, easingVar, tokenEasing, tokenMs, useLoopAnimation } from "@/lib/motion";
import { cleanup, render } from "./render.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Looper({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const running = useLoopAnimation(ref, [{ opacity: 1 }, { opacity: 0.5 }], { duration: () => 1200, enabled });
  return <div ref={ref} data-running={running ? "" : undefined} />;
}

function stubMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}

describe("@/lib/motion", () => {
  test("starts an endless loop with the computed period and cancels it on unmount", () => {
    stubMotion(false);
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    HTMLElement.prototype.animate = animate as never;
    const { unmount, container } = render(<Looper />);
    expect(animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 0.5 }], { duration: 1200, iterations: Infinity, easing: "linear" });
    expect(container.querySelector("[data-running]")).not.toBeNull();
    unmount();
    expect(cancel).toHaveBeenCalled();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  test("never starts under prefers-reduced-motion, nor when disabled", () => {
    const animate = vi.fn(() => ({ cancel: () => {} }));
    HTMLElement.prototype.animate = animate as never;
    stubMotion(true);
    const reduced = render(<Looper />);
    expect(reduced.container.querySelector("[data-running]")).toBeNull();
    reduced.unmount();
    stubMotion(false);
    render(<Looper enabled={false} />);
    expect(animate).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  test("does nothing where element.animate is missing (jsdom)", () => {
    stubMotion(false);
    expect(() => render(<Looper />)).not.toThrow();
  });

  test("tokenMs reads ms and s values and multiplies them", () => {
    const element = document.createElement("div");
    element.style.setProperty("--by-motion-duration-slow", "240ms");
    document.body.append(element);
    expect(tokenMs(element, "--by-motion-duration-slow", 4, 0)).toBe(960);
    element.style.setProperty("--by-motion-duration-slow", "0.5s");
    expect(tokenMs(element, "--by-motion-duration-slow", 2, 0)).toBe(1000);
    expect(tokenMs(element, "--by-motion-duration-base", 2, 777)).toBe(777);
    element.remove();
  });

  test("the Fluent durations and curves are the default theme's motion tokens", () => {
    const value = (path: string) => (tokens as Record<string, { values: Record<string, string> }>)[path]?.values["base"];
    for (const [name, ms] of Object.entries(MOTION_DURATION_MS)) {
      const path = `motion.duration.${name}`;
      const raw = value(path);
      // An alias (base) resolves through its target.
      const resolved = raw?.startsWith("{") ? value(raw.slice(1, -1)) : raw;
      expect(resolved, path).toBe(ms === 0 ? "0" : `${ms}ms`);
      expect(durationVar(name as keyof typeof MOTION_DURATION_MS)).toBe(`--by-${path.replaceAll(".", "-")}`);
    }
    const durations = Object.keys(tokens).filter((path) => path.startsWith("motion.duration."));
    expect(durations.sort()).toEqual(Object.keys(MOTION_DURATION_MS).map((name) => `motion.duration.${name}`).sort());
    for (const [name, curve] of Object.entries(MOTION_EASING)) {
      const path = `motion.easing.${name}`;
      const raw = value(path);
      const resolved = raw?.startsWith("{") ? value(raw.slice(1, -1)) : raw;
      expect(resolved, path).toBe(curve);
      expect(easingVar(name as keyof typeof MOTION_EASING)).toBe(`--by-${path.replaceAll(".", "-")}`);
    }
    const curves = Object.keys(tokens).filter((path) => path.startsWith("motion.easing."));
    expect(curves.sort()).toEqual(Object.keys(MOTION_EASING).map((name) => `motion.easing.${name}`).sort());
  });

  test("tokenEasing reads the theme's curve and falls back to Fluent's", () => {
    expect(tokenEasing(null, "decelerate-mid")).toBe("cubic-bezier(0, 0, 0, 1)");
    const element = document.createElement("div");
    document.body.append(element);
    expect(tokenEasing(element, "easy-ease")).toBe(MOTION_EASING["easy-ease"]);
    element.style.setProperty("--by-motion-easing-easy-ease", "cubic-bezier(0.4, 0, 0.6, 1)");
    expect(tokenEasing(element, "easy-ease")).toBe("cubic-bezier(0.4, 0, 0.6, 1)");
    element.remove();
  });
});
