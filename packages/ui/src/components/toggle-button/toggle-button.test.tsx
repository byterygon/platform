import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { ToggleButton } from "./toggle-button";

afterEach(cleanup);

describe("ToggleButton", () => {
  test("renders a native button with aria-pressed, ghost and md by default", async () => {
    const { container } = render(<ToggleButton>Show nulls</ToggleButton>);
    const button = container.querySelector("button")!;
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.dataset.slot).toBe("toggle-button");
    expect(button.dataset.variant).toBe("ghost");
    expect(button.dataset.size).toBe("md");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a click toggles pressed and reports it", () => {
    const onPressedChange = vi.fn();
    const { container } = render(<ToggleButton onPressedChange={onPressedChange}>Wrap</ToggleButton>);
    const button = container.querySelector("button")!;
    act(() => button.click());
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.hasAttribute("data-pressed")).toBe(true);
    expect(onPressedChange).toHaveBeenLastCalledWith(true, expect.anything());
    act(() => button.click());
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(onPressedChange).toHaveBeenLastCalledWith(false, expect.anything());
  });

  test("controlled pressed follows the prop, not the click", () => {
    const onPressedChange = vi.fn();
    const { container } = render(
      <ToggleButton pressed={false} onPressedChange={onPressedChange}>
        Wrap
      </ToggleButton>,
    );
    const button = container.querySelector("button")!;
    act(() => button.click());
    expect(onPressedChange).toHaveBeenCalledWith(true, expect.anything());
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("forwards the ref", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<ToggleButton ref={ref}>Wrap</ToggleButton>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  test("disabled ignores clicks", () => {
    const onPressedChange = vi.fn();
    const { container } = render(
      <ToggleButton disabled onPressedChange={onPressedChange}>
        Wrap
      </ToggleButton>,
    );
    const button = container.querySelector("button")!;
    expect(button.hasAttribute("data-disabled")).toBe(true);
    act(() => button.click());
    expect(onPressedChange).not.toHaveBeenCalled();
  });
});
