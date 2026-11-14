import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Button } from "@/components/button/button";
import { Select, SelectItem } from "@/components/select/select";
import { $, $$, click, honoursReducedMotion, key, press, waitFor, zLayer } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, type DialogSize } from "./dialog";

afterEach(cleanup);

function Example({ children, ...props }: { size?: DialogSize; onOpenChange?: (open: boolean) => void; children?: ReactNode }) {
  return (
    <Dialog {...props}>
      <DialogTrigger render={<Button />}>Export</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export result</DialogTitle>
          <DialogDescription>Writes the whole result.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <input aria-label="File name" defaultValue="orders.csv" />
          {children}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const trigger = () => $<HTMLButtonElement>('[data-slot="dialog-trigger"]')!;
const popup = () => $('[data-slot="dialog-content"]');

describe("Dialog", () => {
  test("the trigger opens a modal dialog named and described by its title and description", async () => {
    const { container } = render(<Example />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("dialog");
    expect(popup()).toBeNull();
    await click(trigger());
    const dialog = popup()!;
    await waitFor(() => expect(dialog.getAttribute("aria-describedby")).not.toBeNull());
    expect(dialog.getAttribute("role")).toBe("dialog");
    // Base UI marks the rest of the page instead of setting aria-modal on the popup.
    await waitFor(() => expect(container.hasAttribute("inert") || container.getAttribute("aria-hidden") === "true").toBe(true));
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("Export result");
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent).toBe("Writes the whole result.");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("focus moves into the popup, and Escape closes it and returns focus to the trigger", async () => {
    const onOpenChange = vi.fn();
    render(<Example onOpenChange={onOpenChange} />);
    trigger().focus();
    await click(trigger());
    await waitFor(() => expect(popup()!.contains(document.activeElement)).toBe(true));
    await key("Escape");
    await waitFor(() => expect(popup()).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false, expect.objectContaining({ reason: "escape-key" }));
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  test("a press on the scrim closes it; DialogClose and the close button close it", async () => {
    render(<Example />);
    await click(trigger());
    await press($('[data-slot="dialog-viewport"]')!);
    await waitFor(() => expect(popup()).toBeNull());

    await click(trigger());
    await click($$("button").find((b) => b.textContent === "Cancel")!);
    await waitFor(() => expect(popup()).toBeNull());

    await click(trigger());
    const close = $<HTMLButtonElement>('[data-slot="dialog-content"] button[aria-label="Close"]')!;
    expect(close).not.toBeNull();
    await click(close);
    await waitFor(() => expect(popup()).toBeNull());
  });

  test("size sets the popup's maximum width", async () => {
    render(<Example size="lg" />);
    await click(trigger());
    expect(popup()!.dataset.size).toBe("lg");
    expect(popup()!.className).toContain("max-w-panel-lg");
  });

  test("the popup takes the theme and density of the region it is declared in", async () => {
    render(<Example />, { theme: "dark", density: "compact" });
    await click(trigger());
    const viewport = $('[data-slot="dialog-viewport"]')!;
    expect(viewport.getAttribute("data-theme")).toBe("dark");
    expect(viewport.getAttribute("data-density")).toBe("compact");
    expect($('[data-slot="dialog-backdrop"]')!.getAttribute("data-theme")).toBe("dark");
  });

  test("opens without a trigger through open, and still takes its region's theme", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
      { theme: "dark" },
    );
    expect(popup()).not.toBeNull();
    expect($('[data-slot="dialog-viewport"]')!.getAttribute("data-theme")).toBe("dark");
  });

  test("a Select inside the dialog opens its list above the dialog", async () => {
    render(
      <Example>
        <Select aria-label="Format" items={{ csv: "CSV", tsv: "TSV" }} defaultValue="csv">
          <SelectItem value="csv">CSV</SelectItem>
          <SelectItem value="tsv">TSV</SelectItem>
        </Select>
      </Example>,
    );
    await click(trigger());
    await click($('[data-slot="select"]')!);
    expect(zLayer($('[data-slot="select-positioner"]'))).toBeGreaterThan(zLayer($('[data-slot="dialog-viewport"]')));
  });

  test("honours reduced motion: every transition turns off under prefers-reduced-motion", async () => {
    render(<Example />);
    await click(trigger());
    expect(honoursReducedMotion($$("[data-slot^='dialog-']"))).toEqual([]);
  });
});
