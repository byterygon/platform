import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buttonVariants } from "@/components/button/button";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { IconButton, iconButtonVariants } from "./icon-button";

afterEach(cleanup);

const Icon = () => <svg aria-hidden="true" viewBox="0 0 16 16" />;

describe("IconButton", () => {
  test("renders a native button named by aria-label, ghost and md by default", async () => {
    const { container } = render(
      <IconButton aria-label="Copy">
        <Icon />
      </IconButton>,
    );
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Copy");
    expect(button.type).toBe("button");
    expect(button.dataset.slot).toBe("icon-button");
    expect(button.dataset.variant).toBe("ghost");
    expect(button.dataset.size).toBe("md");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("aria-label is required by the type", () => {
    // @ts-expect-error an icon-only button needs an accessible name
    const missing = <IconButton>{<Icon />}</IconButton>;
    // @ts-expect-error aria-labelledby alone does not satisfy it: the name must be on the button
    const labelledBy = <IconButton aria-labelledby="x">{<Icon />}</IconButton>;
    expect([missing, labelledBy]).toHaveLength(2);
  });

  test("uses Button's colours for each variant", () => {
    expect(iconButtonVariants.variant).toBe(buttonVariants.variant);
  });

  test("forwards the ref and reports clicks", () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(
      <IconButton ref={ref} aria-label="Run" onClick={onClick}>
        <Icon />
      </IconButton>,
    );
    act(() => ref.current!.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  test("loading stays focusable, sets aria-busy and ignores clicks", () => {
    const onClick = vi.fn();
    const { container } = render(
      <IconButton aria-label="Refresh" loading onClick={onClick}>
        <Icon />
      </IconButton>,
    );
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("data-loading")).toBe(true);
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    act(() => button.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  test("disabled sets the native attribute and data-disabled", () => {
    const { container } = render(
      <IconButton aria-label="Delete" disabled>
        <Icon />
      </IconButton>,
    );
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute("data-disabled")).toBe(true);
  });
});
