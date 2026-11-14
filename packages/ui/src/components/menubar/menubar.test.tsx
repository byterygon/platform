import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, focus, honoursReducedMotion, key, press, waitFor, zLayer } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Menubar, MenubarContent, MenubarItem, MenubarMenu, MenubarShortcut, MenubarTrigger } from "./menubar";

afterEach(cleanup);

function Example({ onNew }: { onNew?: () => void }) {
  return (
    <div>
      <Menubar>
        <MenubarMenu>
          <MenubarTrigger>File</MenubarTrigger>
          <MenubarContent>
            <MenubarItem onClick={onNew}>
              New tab <MenubarShortcut>Alt+Shift+T</MenubarShortcut>
            </MenubarItem>
            <MenubarItem>Close tab</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger>View</MenubarTrigger>
          <MenubarContent>
            <MenubarItem>Sidebar</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <button type="button">Outside</button>
    </div>
  );
}

const title = (text: string) => $$<HTMLButtonElement>('[data-slot="menubar-trigger"]').find((element) => element.textContent === text)!;
const menus = () => $$('[data-slot="menubar-content"]');
const item = (text: string) => $$('[role="menuitem"]').find((element) => element.textContent?.startsWith(text))!;

describe("Menubar", () => {
  test("renders a role=menubar of titles with menu popups", async () => {
    const { container } = render(<Example />);
    expect($('[data-slot="menubar"]')!.getAttribute("role")).toBe("menubar");
    expect(title("File").getAttribute("aria-haspopup")).toBe("menu");
    await click(title("File"));
    expect(menus()).toHaveLength(1);
    expect(menus()[0]!.getAttribute("role")).toBe("menu");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("ArrowRight moves between titles; ArrowDown opens a menu on its first item; Enter chooses", async () => {
    const onNew = vi.fn();
    render(<Example onNew={onNew} />);
    await focus(title("File"));
    await key("ArrowRight");
    await waitFor(() => expect(document.activeElement).toBe(title("View")));
    await key("ArrowLeft");
    await waitFor(() => expect(document.activeElement).toBe(title("File")));
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(item("New tab")));
    await key("Enter");
    expect(onNew).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(menus()).toHaveLength(0));
  });

  test("Escape closes the open menu and returns focus to its title; a press outside closes it", async () => {
    render(<Example />);
    await focus(title("File"));
    await key("ArrowDown");
    await waitFor(() => expect(menus()).toHaveLength(1));
    await key("Escape");
    await waitFor(() => expect(menus()).toHaveLength(0));
    await waitFor(() => expect(document.activeElement).toBe(title("File")));
    await click(title("View"));
    await press($$("button").find((b) => b.textContent === "Outside")!);
    await waitFor(() => expect(menus()).toHaveLength(0));
  });

  test("each menu takes the row's theme and density, at z.popover", async () => {
    render(<Example />, { theme: "dark", density: "compact" });
    await click(title("View"));
    const positioner = $('[data-slot="menubar-positioner"]')!;
    expect(positioner.getAttribute("data-theme")).toBe("dark");
    expect(positioner.getAttribute("data-density")).toBe("compact");
    expect(zLayer(positioner)).toBe(500);
  });

  test("honours reduced motion", async () => {
    render(<Example />);
    await click(title("File"));
    expect(honoursReducedMotion($$("[data-slot^='menubar']"))).toEqual([]);
  });
});
