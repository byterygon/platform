import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Button } from "./button";

afterEach(cleanup);

describe("Button", () => {
  test("renders a native button that does not submit forms by default", () => {
    const { container } = render(<Button>Save</Button>);
    const button = container.querySelector("button")!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.dataset.slot).toBe("button");
    expect(button.dataset.variant).toBe("primary");
    expect(button.dataset.size).toBe("md");
  });

  test("forwards the ref to the button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Save</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  test("calls onClick, and not when disabled", () => {
    const onClick = vi.fn();
    const { container } = render(
      <>
        <Button onClick={onClick}>On</Button>
        <Button onClick={onClick} disabled>
          Off
        </Button>
      </>,
    );
    const [on, off] = container.querySelectorAll("button");
    act(() => on!.click());
    act(() => off!.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(off!.hasAttribute("data-disabled")).toBe(true);
  });

  test("loading keeps focus, ignores clicks and announces busy", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button loading onClick={onClick}>
        Run
      </Button>,
    );
    const button = container.querySelector("button")!;
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    act(() => button.click());
    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("data-loading")).toBe(true);
  });

  test("merges className after its own classes", () => {
    const { container } = render(<Button className="h-control-lg">Tall</Button>);
    const classes = container.querySelector("button")!.className.split(" ");
    expect(classes).toContain("h-control-lg");
    expect(classes).not.toContain("h-control-md");
  });

  test("an icon-only button with aria-label has no axe violations", async () => {
    const { container } = render(
      <Button variant="ghost" aria-label="Close">
        <svg aria-hidden="true" viewBox="0 0 16 16" />
      </Button>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
