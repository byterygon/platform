import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, honoursReducedMotion, key, press, waitFor, zLayer } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "./context-menu";

afterEach(cleanup);

function Example({ onConnect }: { onConnect?: () => void }) {
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger tabIndex={0} aria-label="orders-prod">
          orders-prod
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onConnect}>Connect</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>Copy</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Connection id</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem danger>Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <button type="button">Outside</button>
    </div>
  );
}

const area = () => $('[data-slot="context-menu-trigger"]')!;
const menu = () => $('[data-slot="context-menu-content"]');
const item = (text: string) => $$('[role^="menuitem"]').find((element) => element.textContent === text)!;

const rightClick = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 30 }));
  });
};

describe("ContextMenu", () => {
  test("a right-click on the area opens a role=menu and prevents the browser's menu", async () => {
    const { container } = render(<Example />);
    expect(menu()).toBeNull();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 30 });
    await act(async () => {
      area().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(menu()!.getAttribute("role")).toBe("menu");
    expect(item("Connect").getAttribute("role")).toBe("menuitem");
    expect(item("Delete").hasAttribute("data-danger")).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("keyboard: arrows move, Enter chooses and closes", async () => {
    const onConnect = vi.fn();
    render(<Example onConnect={onConnect} />);
    await rightClick(area());
    await waitFor(() => expect(menu()!.contains(document.activeElement)).toBe(true));
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(item("Connect")));
    await key("Enter");
    expect(onConnect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(menu()).toBeNull());
  });

  test("Escape closes and focus returns to the area; a press outside closes", async () => {
    render(<Example />);
    area().focus();
    await rightClick(area());
    await key("Escape");
    await waitFor(() => expect(menu()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(area()));
    await rightClick(area());
    await press($$("button").find((b) => b.textContent === "Outside")!);
    await waitFor(() => expect(menu()).toBeNull());
  });

  test("a submenu opens from its trigger", async () => {
    render(<Example />);
    await rightClick(area());
    await click(item("Copy"));
    await waitFor(() => expect($('[data-slot="context-menu-sub-content"]')).not.toBeNull());
    expect(item("Connection id")).toBeDefined();
  });

  test("the menu takes the area's theme and density, at z.popover", async () => {
    render(<Example />, { theme: "dark", density: "compact" });
    await rightClick(area());
    const positioner = $('[data-slot="context-menu-positioner"]')!;
    expect(positioner.getAttribute("data-theme")).toBe("dark");
    expect(positioner.getAttribute("data-density")).toBe("compact");
    expect(zLayer(positioner)).toBe(500);
  });

  test("honours reduced motion", async () => {
    render(<Example />);
    await rightClick(area());
    expect(honoursReducedMotion($$("[data-slot^='context-menu-']"))).toEqual([]);
  });
});
