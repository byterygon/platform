import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Tag, TagGroup } from "./tag";

afterEach(cleanup);

describe("Tag", () => {
  test("renders the label in a span with its variant and size", async () => {
    const { container } = render(<Tag>reporting</Tag>);
    const tag = container.querySelector('[data-slot="tag"]') as HTMLElement;
    expect(tag.tagName).toBe("SPAN");
    expect(tag.dataset.variant).toBe("neutral");
    expect(tag.dataset.size).toBe("sm");
    expect(tag.textContent).toBe("reporting");
    expect(container.querySelector('[data-slot="tag-remove"]')).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("onRemove adds a named remove button that calls it", async () => {
    const onRemove = vi.fn();
    const { container } = render(<Tag onRemove={onRemove}>finance</Tag>);
    const button = container.querySelector('[data-slot="tag-remove"]') as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-label")).toBe("Remove finance");
    await click(button);
    expect(onRemove).toHaveBeenCalledOnce();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("disabled dims the tag and disables removal", async () => {
    const onRemove = vi.fn();
    const { container } = render(
      <Tag disabled onRemove={onRemove} removeLabel="Remove filter">
        owner = me
      </Tag>,
    );
    const button = container.querySelector('[data-slot="tag-remove"]') as HTMLButtonElement;
    expect(container.querySelector('[data-slot="tag"]')!.hasAttribute("data-disabled")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Remove filter");
    await click(button);
    expect(onRemove).not.toHaveBeenCalled();
  });

  test("swatch draws a hidden chart.cat dot", () => {
    const { container } = render(<Tag swatch={3}>nightly</Tag>);
    const swatch = container.querySelector('[data-slot="tag-swatch"]')!;
    expect(swatch.getAttribute("aria-hidden")).toBe("true");
    expect(swatch.className).toContain("bg-chart-3");
  });

  test("TagGroup is a list; the ref reaches the tag", () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(
      <TagGroup aria-label="Labels">
        <Tag ref={ref} role="listitem">
          a
        </Tag>
      </TagGroup>,
    );
    expect(container.querySelector('[data-slot="tag-group"]')!.getAttribute("role")).toBe("list");
    expect(ref.current?.getAttribute("role")).toBe("listitem");
  });
});
