import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { TypeBadge } from "./type-badge";

afterEach(cleanup);

describe("TypeBadge", () => {
  test("shows a hidden glyph and the short name in the type colour", async () => {
    const { container } = render(<TypeBadge type="integer" />);
    const badge = container.querySelector('[data-slot="type-badge"]') as HTMLElement;
    expect(badge.dataset.type).toBe("integer");
    expect(badge.className).toContain("text-type-integer");
    const glyph = badge.querySelector('[data-slot="type-badge-glyph"]')!;
    expect(glyph.getAttribute("aria-hidden")).toBe("true");
    expect(glyph.textContent).toBe("#");
    expect(badge.textContent).toBe("#int");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("label replaces the short name; iconOnly hides it visually but keeps it for screen readers", () => {
    const { container } = render(
      <>
        <TypeBadge type="decimal" label="numeric(12,2)" />
        <TypeBadge type="uuid" iconOnly />
      </>,
    );
    const [decimal, uuid] = container.querySelectorAll('[data-slot="type-badge"]');
    expect(decimal!.textContent).toContain("numeric(12,2)");
    const hidden = uuid!.querySelector(".sr-only")!;
    expect(hidden.textContent).toBe("uuid");
  });

  test("the ref reaches the span", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<TypeBadge ref={ref} type="json" />);
    expect(ref.current?.dataset.type).toBe("json");
  });
});
