import { afterEach, describe, expect, test, vi } from "vitest";
import { Button } from "@/components/button/button";
import { $, $$, click, honoursReducedMotion, key, press, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";

afterEach(cleanup);

function Example({ onAction, onOpenChange }: { onAction?: () => void; onOpenChange?: (open: boolean) => void }) {
  return (
    <AlertDialog onOpenChange={onOpenChange}>
      <AlertDialogTrigger render={<Button variant="danger" />}>Delete</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete orders-prod?</AlertDialogTitle>
          <AlertDialogDescription>The grant is removed.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="danger" onClick={onAction}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const trigger = () => $<HTMLButtonElement>('[data-slot="alert-dialog-trigger"]')!;
const popup = () => $('[data-slot="alert-dialog-content"]');

describe("AlertDialog", () => {
  test("opens a role=alertdialog named by its title, with no close button", async () => {
    const { container } = render(<Example />);
    await click(trigger());
    const dialog = popup()!;
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("Delete orders-prod?");
    await waitFor(() => expect(document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe("The grant is removed."));
    expect(dialog.querySelector('button[aria-label="Close"]')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Cancel is focused first; Escape closes and focus returns to the trigger", async () => {
    render(<Example />);
    trigger().focus();
    await click(trigger());
    await waitFor(() => expect(document.activeElement?.getAttribute("data-slot")).toBe("alert-dialog-cancel"));
    await key("Escape");
    await waitFor(() => expect(popup()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  test("a press outside does not dismiss it", async () => {
    const onOpenChange = vi.fn();
    render(<Example onOpenChange={onOpenChange} />);
    await click(trigger());
    await press($('[data-slot="alert-dialog-viewport"]')!);
    await press($('[data-slot="alert-dialog-backdrop"]')!);
    expect(popup()).not.toBeNull();
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  test("the action runs without closing; Cancel closes", async () => {
    const onAction = vi.fn();
    render(<Example onAction={onAction} />);
    await click(trigger());
    const action = $<HTMLButtonElement>('[data-slot="alert-dialog-action"]')!;
    expect(action.dataset.variant).toBe("danger");
    await click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(popup()).not.toBeNull();
    await click($$("button").find((b) => b.textContent === "Cancel")!);
    await waitFor(() => expect(popup()).toBeNull());
  });

  test("the popup takes the theme and density of its region", async () => {
    render(<Example />, { theme: "dark", density: "compact" });
    await click(trigger());
    expect($('[data-slot="alert-dialog-viewport"]')!.getAttribute("data-theme")).toBe("dark");
    expect($('[data-slot="alert-dialog-viewport"]')!.getAttribute("data-density")).toBe("compact");
  });

  test("honours reduced motion", async () => {
    render(<Example />);
    await click(trigger());
    expect(honoursReducedMotion($$("[data-slot^='alert-dialog-']"))).toEqual([]);
  });
});
