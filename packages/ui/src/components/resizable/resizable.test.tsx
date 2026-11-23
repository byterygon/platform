import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act } from "react";
import { key } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { moveBoundary, Resizable, ResizableHandle, ResizablePanel } from "./resizable";

afterEach(cleanup);

function Layout(props: { onSizesChange?: (sizes: number[]) => void; orientation?: "horizontal" | "vertical" }) {
  return (
    <Resizable aria-label="Layout" {...props}>
      <ResizablePanel defaultSize={30} minSize={10} maxSize={60} collapsible>
        A
      </ResizablePanel>
      <ResizableHandle aria-label="Resize A" />
      <ResizablePanel minSize={20}>B</ResizablePanel>
    </Resizable>
  );
}

const handle = (container: HTMLElement) => container.querySelector('[data-slot="resizable-handle"]') as HTMLElement;
const panels = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]')];

describe("Resizable", () => {
  test("the handle is a focusable separator with the size of the panel before it", async () => {
    const { container } = render(<Layout />);
    const h = handle(container);
    expect(h.getAttribute("role")).toBe("separator");
    expect(h.tabIndex).toBe(0);
    expect(h.getAttribute("aria-orientation")).toBe("vertical");
    expect(h.getAttribute("aria-valuenow")).toBe("30");
    expect(h.getAttribute("aria-valuemin")).toBe("10");
    expect(h.getAttribute("aria-valuemax")).toBe("60");
    expect(h.getAttribute("aria-controls")).toBe(panels(container)[0]!.id);
    expect(panels(container).map((p) => p.style.flex)).toEqual(["30 1 0px", "70 1 0px"]);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("arrow keys move the boundary by keyboardStep; Home and End go to the limits", async () => {
    const onSizesChange = vi.fn();
    const { container } = render(<Layout onSizesChange={onSizesChange} />);
    const h = handle(container);
    h.focus();
    await key("ArrowRight", h);
    expect(onSizesChange).toHaveBeenLastCalledWith([35, 65]);
    await key("ArrowLeft", h);
    await key("ArrowLeft", h);
    expect(h.getAttribute("aria-valuenow")).toBe("25");
    await key("End", h);
    expect(h.getAttribute("aria-valuenow")).toBe("60");
    await key("Home", h);
    expect(h.getAttribute("aria-valuenow")).toBe("10");
  });

  test("Enter collapses a collapsible panel and restores it", async () => {
    const { container } = render(<Layout />);
    const h = handle(container);
    await key("Enter", h);
    expect(h.getAttribute("aria-valuenow")).toBe("0");
    expect(panels(container)[0]!.hasAttribute("data-collapsed")).toBe(true);
    await key("Enter", h);
    expect(h.getAttribute("aria-valuenow")).toBe("30");
  });

  test("a vertical group uses Up and Down and has horizontal handles", async () => {
    const { container } = render(<Layout orientation="vertical" />);
    const h = handle(container);
    expect(h.getAttribute("aria-orientation")).toBe("horizontal");
    await key("ArrowDown", h);
    expect(h.getAttribute("aria-valuenow")).toBe("35");
  });

  test("dragging the handle resizes by the pointer distance over the group's length", async () => {
    const { container } = render(<Layout />);
    const group = container.querySelector('[data-slot="resizable"]') as HTMLElement;
    group.getBoundingClientRect = () => ({ width: 1000, height: 400, top: 0, left: 0, right: 1000, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
    const h = handle(container);
    await act(async () => {
      h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 300, pointerId: 1 }));
    });
    expect(h.hasAttribute("data-dragging")).toBe(true);
    await act(async () => {
      h.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 400, pointerId: 1 }));
      h.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 400, pointerId: 1 }));
    });
    expect(h.getAttribute("aria-valuenow")).toBe("40");
    expect(h.hasAttribute("data-dragging")).toBe(false);
  });

  test("controlled sizes follow the prop", async () => {
    function Controlled() {
      const [sizes, setSizes] = useState([50, 50]);
      return (
        <Resizable sizes={sizes} onSizesChange={setSizes}>
          <ResizablePanel>A</ResizablePanel>
          <ResizableHandle />
          <ResizablePanel>B</ResizablePanel>
        </Resizable>
      );
    }
    const { container } = render(<Controlled />);
    await key("ArrowRight", handle(container));
    expect(handle(container).getAttribute("aria-valuenow")).toBe("55");
  });

  test("moveBoundary keeps the pair's sum and both panels' limits", () => {
    const limits = [
      { min: 10, max: 60, collapsible: false, collapsedSize: 0 },
      { min: 30, max: 100, collapsible: false, collapsedSize: 0 },
    ];
    expect(moveBoundary([30, 70], limits, 1, 50)).toEqual([60, 40]);
    expect(moveBoundary([50, 50], limits, 1, 30)).toEqual([60, 40]);
    expect(moveBoundary([50, 30], limits, 1, 10)).toEqual([50, 30]);
  });

  test("a disabled handle is not focusable and ignores keys", async () => {
    const { container } = render(
      <Resizable>
        <ResizablePanel>A</ResizablePanel>
        <ResizableHandle disabled />
        <ResizablePanel>B</ResizablePanel>
      </Resizable>,
    );
    const h = handle(container);
    expect(h.tabIndex).toBe(-1);
    await key("ArrowRight", h);
    expect(h.getAttribute("aria-valuenow")).toBe("50");
  });

  test("a double click on the handle calls onDoubleClick", async () => {
    const onDoubleClick = vi.fn();
    const { container } = render(
      <Resizable aria-label="Layout">
        <ResizablePanel defaultSize={50}>A</ResizablePanel>
        <ResizableHandle aria-label="Resize A" onDoubleClick={onDoubleClick} />
        <ResizablePanel>B</ResizablePanel>
      </Resizable>,
    );
    await act(async () => {
      handle(container).dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });
});
