import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { StatusBar, StatusBarButton, StatusBarItem, StatusBarSpacer } from "./status-bar";

afterEach(cleanup);

describe("StatusBar", () => {
  test("is a labelled group with items, a button and a spacer", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <StatusBar aria-label="Status">
        <StatusBarButton onClick={onClick}>
          <span>orders-prod</span>
        </StatusBarButton>
        <StatusBarItem live>
          <span>12 rows</span>
        </StatusBarItem>
        <StatusBarSpacer />
        <StatusBarItem>
          <span>Ln 1</span>
        </StatusBarItem>
      </StatusBar>,
    );
    const bar = container.querySelector('[data-slot="status-bar"]')!;
    expect(bar.getAttribute("role")).toBe("group");
    expect(bar.getAttribute("aria-label")).toBe("Status");
    const button = container.querySelector('[data-slot="status-bar-button"]') as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    await click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-slot="status-bar-spacer"]')!.getAttribute("aria-hidden")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a live item is a polite status region; others are not", () => {
    const { container } = render(
      <StatusBar aria-label="Status">
        <StatusBarItem live>12 rows</StatusBarItem>
        <StatusBarItem>UTF-8</StatusBarItem>
      </StatusBar>,
    );
    const [live, plain] = container.querySelectorAll('[data-slot="status-bar-item"]');
    expect(live!.getAttribute("role")).toBe("status");
    expect(live!.getAttribute("aria-live")).toBe("polite");
    expect(plain!.hasAttribute("role")).toBe(false);
  });

  test("items truncate their text span instead of wrapping", () => {
    const { container } = render(
      <StatusBar aria-label="Status">
        <StatusBarItem>
          <span>a very long connection name</span>
        </StatusBarItem>
      </StatusBar>,
    );
    const item = container.querySelector('[data-slot="status-bar-item"]')!;
    expect(item.className).toContain("whitespace-nowrap");
    expect(item.className).toContain("[&>span]:truncate");
    expect(item.className).toContain("min-w-0");
  });

  test("variant and ref reach the bar", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<StatusBar ref={ref} variant="accent" aria-label="Status" />);
    expect(ref.current?.dataset.variant).toBe("accent");
    expect(container.querySelector('[data-slot="status-bar"]')!.className).toContain("bg-accent-solid");
  });
});
