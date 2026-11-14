import { createRef, type Ref } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Button } from "@/components/button/button";
import { $, $$, click, honoursReducedMotion, key, press, waitFor, zLayer } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Popover, PopoverClose, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "./popover";

afterEach(cleanup);

function Example({ onOpenChange, triggerRef = null }: { onOpenChange?: (open: boolean) => void; triggerRef?: Ref<HTMLButtonElement> }) {
  return (
    <div>
      <Popover {...(onOpenChange ? { onOpenChange } : {})}>
        <PopoverTrigger ref={triggerRef} render={<Button variant="ghost" />}>
          Grant
        </PopoverTrigger>
        <PopoverContent side="right">
          <PopoverTitle>Access</PopoverTitle>
          <PopoverDescription>TLS required.</PopoverDescription>
          <PopoverClose render={<Button size="sm" />}>OK</PopoverClose>
        </PopoverContent>
      </Popover>
      <button type="button">Outside</button>
    </div>
  );
}

const trigger = () => $<HTMLButtonElement>('[data-slot="popover-trigger"]')!;
const popup = () => $('[data-slot="popover-content"]');

describe("Popover", () => {
  test("the trigger opens a dialog popup named and described by its parts", async () => {
    const { container } = render(<Example />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const dialog = popup()!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("Access");
    await waitFor(() => expect(document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe("TLS required."));
    expect($('[data-slot="popover-positioner"]')!.getAttribute("data-side")).toBe("right");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Escape closes it and focus returns to the trigger", async () => {
    render(<Example />);
    trigger().focus();
    await click(trigger());
    await waitFor(() => expect(popup()!.contains(document.activeElement)).toBe(true));
    await key("Escape");
    await waitFor(() => expect(popup()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  test("a press outside closes it, and PopoverClose closes it", async () => {
    const onOpenChange = vi.fn();
    render(<Example onOpenChange={onOpenChange} />);
    await click(trigger());
    await press($$("button").find((b) => b.textContent === "Outside")!);
    await waitFor(() => expect(popup()).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false, expect.objectContaining({ reason: "outside-press" }));
    await click(trigger());
    await click($$("button").find((b) => b.textContent === "OK")!);
    await waitFor(() => expect(popup()).toBeNull());
  });

  test("it is not modal: the page is not made inert", async () => {
    const { container } = render(<Example />);
    await click(trigger());
    expect(container.hasAttribute("inert")).toBe(false);
    expect(container.getAttribute("aria-hidden")).toBeNull();
  });

  test("the trigger's ref and the theme scope both reach the trigger", async () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Example triggerRef={ref} />, { theme: "dark", density: "compact" });
    expect(ref.current).toBe(trigger());
    await click(trigger());
    const positioner = $('[data-slot="popover-positioner"]')!;
    expect(positioner.getAttribute("data-theme")).toBe("dark");
    expect(positioner.getAttribute("data-density")).toBe("compact");
    expect(zLayer(positioner)).toBe(500);
  });

  test("honours reduced motion", async () => {
    render(<Example />);
    await click(trigger());
    expect(honoursReducedMotion($$("[data-slot^='popover-']"))).toEqual([]);
  });
});
