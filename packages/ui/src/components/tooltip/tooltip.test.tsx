import { act } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { IconButton } from "@/components/icon-button/icon-button";
import { $, $$, focus, honoursReducedMotion, hover, key, unhover, waitFor, zLayer } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "./tooltip";

afterEach(cleanup);

function Example() {
  return (
    <Tooltip>
      <TooltipTrigger delay={0} render={<IconButton aria-label="Run statement" />}>
        <svg aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Run statement <TooltipShortcut>Ctrl+Enter</TooltipShortcut>
      </TooltipContent>
    </Tooltip>
  );
}

const trigger = () => $<HTMLButtonElement>('[data-slot="tooltip-trigger"]')!;
const bubble = () => $('[data-slot="tooltip-content"]');

describe("Tooltip", () => {
  test("hovering the trigger shows the tooltip; leaving hides it", async () => {
    const { container } = render(<Example />);
    expect(bubble()).toBeNull();
    await hover(trigger());
    await waitFor(() => expect(bubble()).not.toBeNull());
    expect(bubble()!.textContent).toBe("Run statement Ctrl+Enter");
    expect($('[data-slot="tooltip-shortcut"]')!.tagName).toBe("KBD");
    expect($('[data-slot="tooltip-positioner"]')!.getAttribute("data-side")).toBe("bottom");
    expect(await axeViolations(container)).toEqual([]);
    await unhover(trigger());
    await waitFor(() => expect(bubble()).toBeNull());
  });

  test("keyboard focus shows it, Escape hides it, and the trigger keeps focus", async () => {
    render(<Example />);
    await focus(trigger());
    await waitFor(() => expect(bubble()).not.toBeNull());
    await key("Escape", trigger());
    await waitFor(() => expect(bubble()).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  test("the trigger keeps its own accessible name", () => {
    render(<Example />);
    expect(trigger().getAttribute("aria-label")).toBe("Run statement");
  });

  test("sits at z.tooltip with the trigger's theme and density", async () => {
    render(<Example />, { theme: "dark", density: "compact" });
    await hover(trigger());
    await waitFor(() => expect(bubble()).not.toBeNull());
    const positioner = $('[data-slot="tooltip-positioner"]')!;
    expect(zLayer(positioner)).toBe(700);
    expect(positioner.getAttribute("data-theme")).toBe("dark");
    expect(positioner.getAttribute("data-density")).toBe("compact");
  });

  test("honours reduced motion", async () => {
    render(<Example />);
    await hover(trigger());
    await waitFor(() => expect(bubble()).not.toBeNull());
    await act(async () => {});
    expect(honoursReducedMotion($$("[data-slot^='tooltip-']"))).toEqual([]);
    expect(bubble()!.className).toContain("motion-reduce:transition-none");
  });
});
