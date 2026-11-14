import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Kbd, KbdGroup } from "./kbd";

afterEach(cleanup);

describe("Kbd", () => {
  test("renders a <kbd> with its slot", () => {
    const { container } = render(<Kbd>Esc</Kbd>);
    const kbd = container.querySelector("kbd")!;
    expect(kbd.dataset.slot).toBe("kbd");
    expect(kbd.textContent).toBe("Esc");
  });

  test("forwards the ref", () => {
    const ref = createRef<HTMLElement>();
    render(<Kbd ref={ref}>K</Kbd>);
    expect(ref.current?.tagName).toBe("KBD");
  });

  test("render swaps the element and keeps the classes", () => {
    const { container } = render(<Kbd render={<span />}>K</Kbd>);
    const span = container.querySelector("span")!;
    expect(span.dataset.slot).toBe("kbd");
    expect(span.className).toContain("text-code");
  });

  test("KbdGroup nests the keys in an outer <kbd> and keeps the separators as text", async () => {
    const { container } = render(
      <KbdGroup>
        <Kbd>Ctrl</Kbd>+<Kbd>K</Kbd>
      </KbdGroup>,
    );
    const group = container.querySelector('[data-slot="kbd-group"]')!;
    expect(group.tagName).toBe("KBD");
    expect(group.querySelectorAll('[data-slot="kbd"]')).toHaveLength(2);
    expect(group.textContent).toBe("Ctrl+K");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a later className wins over the role classes", () => {
    const { container } = render(<Kbd className="text-fg">K</Kbd>);
    const classes = container.querySelector("kbd")!.className.split(" ");
    expect(classes).toContain("text-fg");
    expect(classes).not.toContain("text-fg-muted");
    expect(classes).toContain("text-code");
  });
});
