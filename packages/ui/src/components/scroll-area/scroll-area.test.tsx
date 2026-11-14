import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { ScrollArea } from "./scroll-area";

afterEach(cleanup);

describe("ScrollArea", () => {
  test("renders root, viewport and content", () => {
    const { container } = render(<ScrollArea>Rows</ScrollArea>);
    const root = container.querySelector('[data-slot="scroll-area"]')!;
    const viewport = root.querySelector('[data-slot="scroll-area-viewport"]')!;
    expect(viewport.querySelector('[data-slot="scroll-area-content"]')!.textContent).toBe("Rows");
  });

  test("a label makes the viewport a named region", async () => {
    const { container } = render(<ScrollArea aria-label="Notices">Rows</ScrollArea>);
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')!;
    expect(viewport.getAttribute("role")).toBe("region");
    expect(viewport.getAttribute("aria-label")).toBe("Notices");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("without a label the viewport has no role", () => {
    const { container } = render(<ScrollArea>Rows</ScrollArea>);
    expect(container.querySelector('[data-slot="scroll-area-viewport"]')!.hasAttribute("role")).toBe(false);
  });

  test("ref reaches the root, viewportRef the scrolling element, onViewportScroll fires", () => {
    const ref = createRef<HTMLDivElement>();
    const viewportRef = createRef<HTMLDivElement>();
    const onScroll = vi.fn();
    render(
      <ScrollArea ref={ref} viewportRef={viewportRef} onViewportScroll={onScroll}>
        Rows
      </ScrollArea>,
    );
    expect(ref.current?.dataset.slot).toBe("scroll-area");
    expect(viewportRef.current?.dataset.slot).toBe("scroll-area-viewport");
    viewportRef.current!.dispatchEvent(new Event("scroll"));
    expect(onScroll).toHaveBeenCalled();
  });
});
