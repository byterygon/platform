import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Spinner } from "./spinner";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Spinner", () => {
  test("is a status region with hidden text naming what loads", async () => {
    const { container } = render(<Spinner label="Loading tables" />);
    const root = container.querySelector('[data-slot="spinner"]')!;
    expect(root.getAttribute("role")).toBe("status");
    expect(root.textContent).toBe("Loading tables");
    expect(root.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("label={null} hides it from assistive technology", () => {
    const { container } = render(<Spinner label={null} />);
    const root = container.querySelector('[data-slot="spinner"]')!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.hasAttribute("role")).toBe(false);
    expect(root.textContent).toBe("");
  });

  test("turns through the Web Animations API, and not under reduced motion", () => {
    const animate = vi.fn(() => ({ cancel: () => {} }));
    (SVGElement.prototype as { animate?: unknown }).animate = animate;
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    const first = render(<Spinner />);
    expect(animate).toHaveBeenCalledOnce();
    expect((animate.mock.calls[0] as unknown[])[0]).toEqual([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }]);
    first.unmount();
    animate.mockClear();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    render(<Spinner />);
    expect(animate).not.toHaveBeenCalled();
    delete (SVGElement.prototype as { animate?: unknown }).animate;
  });

  test("variant, size and ref", () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(<Spinner ref={ref} variant="accent" size="lg" />);
    expect(ref.current?.dataset.variant).toBe("accent");
    expect(container.querySelector('[data-slot="spinner"]')!.className).toContain("[&_svg]:size-icon-lg");
  });
});
