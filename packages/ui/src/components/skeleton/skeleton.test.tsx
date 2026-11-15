import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Skeleton } from "./skeleton";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
});

const allowMotion = () => vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));

describe("Skeleton", () => {
  test("is an aria-hidden block in the inset colour", async () => {
    const { container } = render(
      <div role="group" aria-busy="true" aria-label="Loading">
        <Skeleton variant="text" />
      </div>,
    );
    const el = container.querySelector('[data-slot="skeleton"]') as HTMLElement;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.dataset.variant).toBe("text");
    expect(el.className).toContain("bg-inset");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("pulses through the Web Animations API unless animated={false}", () => {
    allowMotion();
    const animate = vi.fn(() => ({ cancel: () => {} }));
    HTMLElement.prototype.animate = animate as never;
    render(<Skeleton />);
    expect(animate).toHaveBeenCalledOnce();
    animate.mockClear();
    render(<Skeleton animated={false} />);
    expect(animate).not.toHaveBeenCalled();
  });

  test("the caller's ref and className still arrive", () => {
    allowMotion();
    const ref = createRef<HTMLSpanElement>();
    render(<Skeleton ref={ref} variant="circle" className="size-control-md" />);
    expect(ref.current?.dataset.slot).toBe("skeleton");
    expect(ref.current?.className).toContain("size-control-md");
    expect(ref.current?.className).toContain("rounded-full");
  });
});
