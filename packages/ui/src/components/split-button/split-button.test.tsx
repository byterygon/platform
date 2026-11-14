import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DropdownMenuItem } from "@/components/dropdown-menu/dropdown-menu";
import { $, $$, click, focus, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { SplitButton } from "./split-button";

afterEach(cleanup);

const menuButton = () => $<HTMLButtonElement>('[data-slot="split-button"] [aria-haspopup="menu"]')!;
const action = () => $$<HTMLButtonElement>('[data-slot="split-button"] button')[0]!;
const menu = () => $('[data-slot="dropdown-menu-content"]');

describe("SplitButton", () => {
  test("a group of the action and a named menu button", async () => {
    const { container } = render(
      <SplitButton menuLabel="Run options" menu={<DropdownMenuItem>Run selection</DropdownMenuItem>}>
        Run
      </SplitButton>,
    );
    expect($('[data-slot="split-button"]')!.getAttribute("role")).toBe("group");
    expect(action().textContent).toBe("Run");
    expect(menuButton().getAttribute("aria-label")).toBe("Run options");
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("the action runs on click; the menu button opens the menu and an item runs its own action", async () => {
    const onRun = vi.fn();
    const onSelection = vi.fn();
    render(
      <SplitButton onClick={onRun} menuLabel="Run options" menu={<DropdownMenuItem onClick={onSelection}>Run selection</DropdownMenuItem>}>
        Run
      </SplitButton>,
    );
    await click(action());
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    await click(menuButton());
    expect(menu()!.getAttribute("role")).toBe("menu");
    await click($$('[role="menuitem"]')[0]!);
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(menu()).toBeNull());
  });

  test("keyboard: ArrowDown on the menu button opens on the first item; Escape returns focus to it", async () => {
    render(
      <SplitButton menuLabel="Run options" menu={<DropdownMenuItem>Run selection</DropdownMenuItem>}>
        Run
      </SplitButton>,
    );
    await focus(menuButton());
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Run selection"));
    await key("Escape");
    await waitFor(() => expect(menu()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(menuButton()));
  });

  test("loading keeps the menu usable; disabled disables both halves", async () => {
    render(
      <SplitButton loading menuLabel="Run options" menu={<DropdownMenuItem>Run selection</DropdownMenuItem>}>
        Run
      </SplitButton>,
    );
    expect(action().getAttribute("aria-busy")).toBe("true");
    expect(menuButton().hasAttribute("disabled")).toBe(false);
    cleanup();
    render(
      <SplitButton disabled menuLabel="Run options" menu={<DropdownMenuItem>Run selection</DropdownMenuItem>}>
        Run
      </SplitButton>,
    );
    expect(action().hasAttribute("data-disabled")).toBe(true);
    expect(menuButton().hasAttribute("data-disabled")).toBe(true);
  });

  test("the ref reaches the action's button; variant and size reach both halves", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <SplitButton ref={ref} variant="ghost" size="sm" menu={null}>
        Copy
      </SplitButton>,
    );
    expect(ref.current).toBe(action());
    expect(action().dataset.variant).toBe("ghost");
    expect(menuButton().dataset.size).toBe("sm");
    expect(menuButton().className).toContain("border-s-border");
  });
});
