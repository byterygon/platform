import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "../../../test/render.tsx";
import { Separator } from "./separator";

afterEach(cleanup);

describe("Separator", () => {
  test("is a horizontal role=separator by default", () => {
    const { container } = render(<Separator />);
    const root = container.querySelector('[data-slot="separator"]') as HTMLElement;
    expect(root.getAttribute("role")).toBe("separator");
    expect(root.getAttribute("aria-orientation")).toBe("horizontal");
    expect(root.dataset.variant).toBe("default");
    expect(root.className).toContain("bg-border");
  });

  test("vertical sets aria-orientation and data-orientation", () => {
    const { container } = render(<Separator orientation="vertical" variant="strong" />);
    const root = container.querySelector('[data-slot="separator"]') as HTMLElement;
    expect(root.getAttribute("aria-orientation")).toBe("vertical");
    expect(root.dataset.orientation).toBe("vertical");
    expect(root.className).toContain("bg-border-strong");
  });

  test("forwards the ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Separator ref={ref} />);
    expect(ref.current?.dataset.slot).toBe("separator");
  });
});
