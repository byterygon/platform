import { useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tokenMs, useLoopAnimation } from "@/lib/motion";
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
});
