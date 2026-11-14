import { afterEach, describe, expect, test } from "vitest";
import { Button } from "@/components/button/button";
import { $, $$, click, honoursReducedMotion, key, press, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger, type SheetSide, type SheetSize } from "./sheet";

afterEach(cleanup);

function Example(props: { side?: SheetSide; size?: SheetSize }) {
  return (
    <Sheet {...props}>
      <SheetTrigger render={<Button />}>Edit</SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit connection</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <input aria-label="Name" defaultValue="orders-prod" />
        </SheetBody>
        <SheetFooter>
          <SheetClose render={<Button variant="ghost" />}>Cancel</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

const trigger = () => $<HTMLButtonElement>('[data-slot="sheet-trigger"]')!;
const popup = () => $('[data-slot="sheet-content"]');

describe("Sheet", () => {
  test("opens a dialog on the right by default, named by its title", async () => {
    const { container } = render(<Example />);
    await click(trigger());
    const sheet = popup()!;
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.dataset.side).toBe("right");
    expect(sheet.className).toContain("max-w-panel-md");
    expect(document.getElementById(sheet.getAttribute("aria-labelledby")!)!.textContent).toBe("Edit connection");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("focus moves in; Escape closes and returns focus to the trigger", async () => {
    render(<Example />);
    trigger().focus();
    await click(trigger());
    await waitFor(() => expect(popup()!.contains(document.activeElement)).toBe(true));
    await key("Escape");
    await waitFor(() => expect(popup()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  test("a press on the scrim closes it; so do SheetClose and the close button", async () => {
    render(<Example />);
    await click(trigger());
    await press($('[data-slot="sheet-backdrop"]')!);
    await waitFor(() => expect(popup()).toBeNull());
    await click(trigger());
    await click($$("button").find((b) => b.textContent === "Cancel")!);
    await waitFor(() => expect(popup()).toBeNull());
    await click(trigger());
    await click($('[data-slot="sheet-content"] button[aria-label="Close"]')!);
    await waitFor(() => expect(popup()).toBeNull());
  });

  test("side picks the edge and the slide; size applies to left and right only", async () => {
    render(<Example side="left" size="sm" />);
    await click(trigger());
    expect(popup()!.className).toContain("left-0");
    expect(popup()!.className).toContain("data-starting-style:-translate-x-full");
    expect(popup()!.className).toContain("max-w-panel-sm");
    cleanup();
    render(<Example side="bottom" size="lg" />);
    await click(trigger());
    expect(popup()!.className).toContain("bottom-0");
    expect(popup()!.className).not.toContain("max-w-panel-lg");
  });

  test("the sheet takes the theme and density of its region", async () => {
    render(<Example />, { theme: "dark", density: "compact" });
    await click(trigger());
    expect(popup()!.getAttribute("data-theme")).toBe("dark");
    expect(popup()!.getAttribute("data-density")).toBe("compact");
  });

  test("honours reduced motion", async () => {
    render(<Example />);
    await click(trigger());
    expect(honoursReducedMotion($$("[data-slot^='sheet-']"))).toEqual([]);
  });
});
