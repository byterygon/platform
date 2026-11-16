import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Icon } from "@/components/icon/icon";
import { focusRing } from "@/lib/control";
import { Dismiss } from "@/lib/icons";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Button, buttonVariants } from "./button";

afterEach(cleanup);

const button = (container: HTMLElement) => container.querySelector("button")!;
const classes = (element: Element) => element.className.split(" ");

describe("Button", () => {
  test("renders a native button that does not submit forms by default, primary and medium", () => {
    const { container } = render(<Button>Save</Button>);
    expect(button(container).getAttribute("type")).toBe("button");
    expect(button(container).dataset.slot).toBe("button");
    expect(button(container).dataset.appearance).toBe("primary");
    expect(button(container).dataset.size).toBe("medium");
  });

  test("takes Fluent's appearances and sizes", () => {
    for (const appearance of Object.keys(buttonVariants.appearance) as (keyof typeof buttonVariants.appearance)[]) {
      for (const size of ["small", "medium", "large"] as const) {
        const { container, unmount } = render(
          <Button appearance={appearance} size={size}>
            Go
          </Button>,
        );
        expect(button(container).dataset.appearance).toBe(appearance);
        expect(button(container).dataset.size).toBe(size);
        expect(classes(button(container))).toEqual(expect.arrayContaining(buttonVariants.size[size].split(" ")));
        unmount();
      }
    }
  });

  test("keeps the old variant and size names as aliases for one release", () => {
    const cases = [
      [{ variant: "primary" }, "primary"],
      [{ variant: "secondary" }, "secondary"],
      [{ variant: "ghost" }, "subtle"],
      [{ variant: "danger" }, "danger"],
    ] as const;
    for (const [props, appearance] of cases) {
      const { container, unmount } = render(<Button {...props}>Go</Button>);
      expect(button(container).dataset.appearance).toBe(appearance);
      expect(classes(button(container))).toEqual(expect.arrayContaining(buttonVariants.appearance[appearance].split(" ")));
      unmount();
    }
    for (const [size, fluent] of [["sm", "small"], ["md", "medium"], ["lg", "large"]] as const) {
      const { container, unmount } = render(<Button size={size}>Go</Button>);
      expect(button(container).dataset.size).toBe(fluent);
      unmount();
    }
    // appearance wins over the deprecated variant.
    const { container } = render(
      <Button appearance="outline" variant="danger">
        Go
      </Button>,
    );
    expect(button(container).dataset.appearance).toBe("outline");
  });

  test("shows the double focus ring on keyboard focus", () => {
    const { container } = render(<Button>Save</Button>);
    expect(classes(button(container))).toEqual(expect.arrayContaining(focusRing.split(" ")));
    expect(focusRing).toContain("focus-visible:outline-ring");
    expect(focusRing).toContain("focus-visible:ring-ring-inner");
  });

  test("forwards the ref to the button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Save</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  test("calls onClick, and not when disabled; disabled takes Fluent's disabled colours", () => {
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
    expect(classes(off!)).toEqual(expect.arrayContaining(["data-disabled:bg-disabled", "data-disabled:text-fg-disabled"]));
  });

  test("loading keeps focus, ignores clicks and announces busy", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button loading onClick={onClick}>
        Run
      </Button>,
    );
    act(() => button(container).focus());
    expect(document.activeElement).toBe(button(container));
    act(() => button(container).click());
    expect(onClick).not.toHaveBeenCalled();
    expect(button(container).getAttribute("aria-busy")).toBe("true");
    expect(button(container).hasAttribute("data-loading")).toBe(true);
  });

  test("merges className after its own classes", () => {
    const { container } = render(<Button className="h-control-lg">Tall</Button>);
    expect(classes(button(container))).toContain("h-control-lg");
    expect(classes(button(container))).not.toContain("h-control-md");
  });

  test("an icon-only button with aria-label has no axe violations", async () => {
    const { container } = render(
      <Button appearance="subtle" aria-label="Close">
        <Icon icon={Dismiss} />
      </Button>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
