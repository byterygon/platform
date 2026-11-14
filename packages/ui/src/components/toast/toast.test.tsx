import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, honoursReducedMotion, key, waitFor, zLayer } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { createToastManager, Toast, useToast } from "./toast";

afterEach(cleanup);

const items = () => $$('[data-slot="toast-item"]');

function AddButton() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.add({ title: "Query saved", description: "orders.sql", type: "success" })}>
      Save
    </button>
  );
}

describe("Toast", () => {
  test("a polite region named Notifications; useToast adds a toast with its title and description", async () => {
    const { container } = render(
      <Toast placement="static">
        <AddButton />
      </Toast>,
    );
    const region = $('[data-slot="toast"]')!;
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("Notifications");
    expect(region.getAttribute("aria-live")).toBe("polite");
    await click($$("button").find((b) => b.textContent === "Save")!);
    expect(items()).toHaveLength(1);
    const item = items()[0]!;
    expect(item.getAttribute("data-type")).toBe("success");
    expect(document.getElementById(item.getAttribute("aria-labelledby")!)!.textContent).toBe("Query saved");
    expect(item.textContent).toContain("orders.sql");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a manager adds toasts from outside React; the close button and Escape dismiss them", async () => {
    const manager = createToastManager();
    render(<Toast placement="static" toastManager={manager} timeout={0} />);
    await act(async () => {
      manager.add({ title: "Connection lost", type: "danger" });
    });
    expect(items()).toHaveLength(1);
    await click($('[data-slot="toast-item"] button[aria-label="Dismiss"]')!);
    await waitFor(() => expect(items()).toHaveLength(0));
    await act(async () => {
      manager.add({ title: "Exported", type: "success" });
    });
    items()[0]!.focus();
    await key("Escape", items()[0]!);
    await waitFor(() => expect(items()).toHaveLength(0));
  });

  test("a toast closes after its timeout; timeout 0 keeps it (sticky)", async () => {
    vi.useFakeTimers();
    try {
      const manager = createToastManager();
      render(<Toast placement="static" toastManager={manager} timeout={1000} />);
      await act(async () => {
        manager.add({ title: "Copied" });
        manager.add({ title: "Expires soon", timeout: 0 });
      });
      expect(items()).toHaveLength(2);
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      await act(async () => {
        vi.runOnlyPendingTimers();
      });
      expect(items().map((item) => item.textContent)).toEqual(["Expires soon"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the action renders as a Button and runs its handler; high priority is an alertdialog announced at once", async () => {
    const onRenew = vi.fn();
    const manager = createToastManager();
    render(<Toast placement="static" toastManager={manager} timeout={0} />);
    await act(async () => {
      manager.add({ title: "Access expires in 15 min", type: "warning", priority: "high", actionProps: { children: "Renew access", onClick: onRenew } });
    });
    const item = items()[0]!;
    expect(item.getAttribute("role")).toBe("alertdialog");
    expect($('[role="alert"]')!.textContent).toContain("Access expires in 15 min");
    const action = $$<HTMLButtonElement>("button").find((b) => b.textContent === "Renew access")!;
    expect(action.getAttribute("data-slot")).toBe("button");
    await click(action);
    expect(onRenew).toHaveBeenCalledTimes(1);
  });

  test("toasts over the limit wait (data-limited)", async () => {
    const manager = createToastManager();
    render(<Toast placement="static" toastManager={manager} timeout={0} limit={2} />);
    await act(async () => {
      for (const title of ["one", "two", "three"]) manager.add({ title });
    });
    expect(items().filter((item) => item.hasAttribute("data-limited"))).toHaveLength(1);
  });

  test("a corner region is fixed at z.toast in a portal with the theme of where Toast is placed", async () => {
    const manager = createToastManager();
    const { container } = render(<Toast toastManager={manager} />, { theme: "dark", density: "compact" });
    await act(async () => {
      manager.add({ title: "Saved" });
    });
    const region = $('[data-slot="toast"]')!;
    expect(container.contains(region)).toBe(false);
    expect(zLayer(region)).toBe(600);
    expect(region.getAttribute("data-theme")).toBe("dark");
    expect(region.getAttribute("data-density")).toBe("compact");
  });

  test("honours reduced motion", async () => {
    const manager = createToastManager();
    render(<Toast placement="static" toastManager={manager} />);
    await act(async () => {
      manager.add({ title: "Saved" });
    });
    expect(honoursReducedMotion($$("[data-slot^='toast']"))).toEqual([]);
  });
});
