import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Badge } from "./badge";

afterEach(cleanup);

const badge = (container: HTMLElement) => container.querySelector('[data-slot="badge"]') as HTMLElement;

describe("Badge", () => {
  test("renders a span with its tone, appearance and size", async () => {
    const { container } = render(<Badge>read-only</Badge>);
    const el = badge(container);
    expect(el.tagName).toBe("SPAN");
    expect(el.dataset.variant).toBe("neutral");
    expect(el.dataset.appearance).toBe("subtle");
    expect(el.dataset.size).toBe("sm");
    expect(el.textContent).toBe("read-only");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("the dot appearance draws an aria-hidden dot before the text", () => {
    const { container } = render(
      <Badge variant="success" appearance="dot">
        connected
      </Badge>,
    );
    const dot = container.querySelector('[data-slot="badge-dot"]')!;
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(badge(container).className).toContain("[&>[data-slot=badge-dot]]:bg-success");
    expect(badge(container).textContent).toBe("connected");
  });

  test("other appearances have no dot", () => {
    const { container } = render(<Badge appearance="solid">x</Badge>);
    expect(container.querySelector('[data-slot="badge-dot"]')).toBeNull();
  });

  test("a tone styles each appearance through data-appearance", () => {
    const { container } = render(
      <Badge variant="danger" appearance="solid">
        plaintext
      </Badge>,
    );
    expect(badge(container).className).toContain("data-[appearance=solid]:bg-danger");
  });

  test("long text truncates; render swaps the element; the ref reaches it", () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(
      <Badge ref={ref} render={<strong />}>
        long label
      </Badge>,
    );
    expect(ref.current?.tagName).toBe("STRONG");
    expect(container.querySelector('[data-slot="badge"] > span')!.className).toContain("truncate");
  });
});
