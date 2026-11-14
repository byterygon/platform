import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click, honoursReducedMotion, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./collapsible";

afterEach(cleanup);

function Notices(props: { defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; disabled?: boolean }) {
  return (
    <Collapsible {...props}>
      <CollapsibleTrigger>3 notices</CollapsibleTrigger>
      <CollapsiblePanel>Notice text</CollapsiblePanel>
    </Collapsible>
  );
}

const trigger = (container: HTMLElement) => container.querySelector('[data-slot="collapsible-trigger"]') as HTMLButtonElement;

describe("Collapsible", () => {
  test("the trigger is a button with aria-expanded; the panel is hidden until opened", async () => {
    const { container } = render(<Notices />);
    const button = trigger(container);
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Notice text");
    await click(button);
    await waitFor(() => expect(button.getAttribute("aria-expanded")).toBe("true"));
    const panel = container.querySelector('[data-slot="collapsible-panel"]')!;
    expect(panel.textContent).toBe("Notice text");
    expect(button.getAttribute("aria-controls")).toBe(panel.id);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("the trigger is a native button (Enter and Space activate it); onOpenChange reports the change", async () => {
    const onOpenChange = vi.fn();
    const { container } = render(<Notices onOpenChange={onOpenChange} />);
    const button = trigger(container);
    expect(button.type).toBe("button");
    await click(button);
    await waitFor(() => expect(onOpenChange).toHaveBeenLastCalledWith(true, expect.anything()));
  });

  test("defaultOpen shows the panel; the chevron turns through data-panel-open", () => {
    const { container } = render(<Notices defaultOpen />);
    expect(trigger(container).hasAttribute("data-panel-open")).toBe(true);
    expect(container.querySelector('[data-slot="collapsible-chevron"]')!.className).toContain("in-data-panel-open:rotate-90");
  });

  test("disabled does not open", async () => {
    const { container } = render(<Notices disabled />);
    await click(trigger(container));
    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
  });

  test("chevron={false} leaves only the label; the ref reaches the root", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <Collapsible ref={ref}>
        <CollapsibleTrigger chevron={false}>Plain</CollapsibleTrigger>
      </Collapsible>,
    );
    expect(container.querySelector('[data-slot="collapsible-chevron"]')).toBeNull();
    expect(ref.current?.dataset.slot).toBe("collapsible");
  });

  test("honours reduced motion", () => {
    const { container } = render(<Notices defaultOpen />);
    expect(honoursReducedMotion([...container.querySelectorAll("[data-slot]")])).toEqual([]);
  });
});
