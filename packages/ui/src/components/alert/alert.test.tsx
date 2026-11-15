import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "./alert";

afterEach(cleanup);

const root = (container: HTMLElement) => container.querySelector('[data-slot="alert"]') as HTMLElement;

describe("Alert", () => {
  test("danger and warning are role=alert; the others role=status", () => {
    for (const [variant, role] of [["danger", "alert"], ["warning", "alert"], ["info", "status"], ["success", "status"], ["neutral", "status"]] as const) {
      const { container, unmount } = render(<Alert variant={variant}>x</Alert>);
      expect(root(container).getAttribute("role"), variant).toBe(role);
      unmount();
    }
  });

  test("renders a hidden status icon and its parts", async () => {
    const { container } = render(
      <Alert variant="danger">
        <AlertTitle>Query failed</AlertTitle>
        <AlertDescription>
          <code>42P01</code> relation does not exist
        </AlertDescription>
        <AlertActions>
          <button type="button">Retry</button>
        </AlertActions>
      </Alert>,
    );
    const el = root(container);
    expect(el.querySelector('[data-slot="alert-icon"]')!.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelector('[data-slot="alert-title"]')!.textContent).toBe("Query failed");
    expect(el.querySelector('[data-slot="alert-actions"] button')).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("icon={false} drops the icon; a custom icon replaces it", () => {
    const none = render(<Alert icon={false}>x</Alert>);
    expect(none.container.querySelector('[data-slot="alert-icon"]')).toBeNull();
    none.unmount();
    const custom = render(<Alert icon={<b>!</b>}>x</Alert>);
    expect(custom.container.querySelector('[data-slot="alert-icon"]')!.textContent).toBe("!");
  });

  test("onDismiss adds a named close button", async () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Alert layout="banner" onDismiss={onDismiss} dismissLabel="Dismiss expiry warning">
        Expires soon
      </Alert>,
    );
    const button = container.querySelector('[data-slot="icon-button"]') as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Dismiss expiry warning");
    await click(button);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(root(container).dataset.layout).toBe("banner");
  });

  test("the ref reaches the root", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Alert ref={ref}>x</Alert>);
    expect(ref.current?.dataset.slot).toBe("alert");
  });
});
