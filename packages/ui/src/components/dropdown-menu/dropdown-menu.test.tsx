import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Button } from "@/components/button/button";
import { $, $$, click, honoursReducedMotion, key, press, waitFor, zLayer } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu";

afterEach(cleanup);

function Example({ onRename, onClose }: { onRename?: () => void; onClose?: () => void }) {
  const [wrap, setWrap] = useState(false);
  const [format, setFormat] = useState("csv");
  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="secondary" />}>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Tab</DropdownMenuLabel>
            <DropdownMenuItem onClick={onRename}>
              Rename <DropdownMenuShortcut>F2</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled>Pin</DropdownMenuItem>
            <DropdownMenuItem danger onClick={onClose}>
              Close
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
            Word wrap
          </DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value={format} onValueChange={(value) => setFormat(value as string)}>
            <DropdownMenuRadioItem value="csv">CSV</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="json">JSON</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Copy as</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>SQL</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button">Outside</button>
    </div>
  );
}

const trigger = () => $<HTMLButtonElement>('[data-slot="dropdown-menu-trigger"]')!;
const menu = () => $('[data-slot="dropdown-menu-content"]');
const item = (text: string) => $$('[role^="menuitem"]').find((element) => element.textContent?.startsWith(text))!;

describe("DropdownMenu", () => {
  test("the trigger opens a role=menu with items, a labelled group and a separator", async () => {
    const { container } = render(<Example />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    await click(trigger());
    expect(menu()!.getAttribute("role")).toBe("menu");
    expect(item("Rename").getAttribute("role")).toBe("menuitem");
    expect(item("Word wrap").getAttribute("role")).toBe("menuitemcheckbox");
    expect(item("CSV").getAttribute("role")).toBe("menuitemradio");
    const group = $('[data-slot="dropdown-menu-group"]')!;
    expect(group.getAttribute("role")).toBe("group");
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Tab");
    expect($('[data-slot="dropdown-menu-separator"]')!.getAttribute("role")).toBe("separator");
    expect(item("Close").hasAttribute("data-danger")).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("keyboard: ArrowDown opens on the first item, a disabled item is reached but not chosen, Enter chooses and closes", async () => {
    const onClose = vi.fn();
    render(<Example onClose={onClose} />);
    trigger().focus();
    await key("ArrowDown", trigger());
    await waitFor(() => expect(document.activeElement).toBe(item("Rename")));
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(item("Pin")));
    expect(item("Pin").getAttribute("aria-disabled")).toBe("true");
    await key("Enter");
    expect(menu()).not.toBeNull();
    await key("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(item("Close")));
    await key("Enter");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(menu()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  test("Escape closes and returns focus; a press outside closes", async () => {
    render(<Example />);
    trigger().focus();
    await click(trigger());
    await key("Escape");
    await waitFor(() => expect(menu()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    await click(trigger());
    await press($$("button").find((b) => b.textContent === "Outside")!);
    await waitFor(() => expect(menu()).toBeNull());
  });

  test("checkbox and radio items toggle aria-checked and keep the menu open", async () => {
    render(<Example />);
    await click(trigger());
    expect(item("Word wrap").getAttribute("aria-checked")).toBe("false");
    await click(item("Word wrap"));
    expect(item("Word wrap").getAttribute("aria-checked")).toBe("true");
    expect(item("JSON").getAttribute("aria-checked")).toBe("false");
    await click(item("JSON"));
    expect(item("JSON").getAttribute("aria-checked")).toBe("true");
    expect(item("CSV").getAttribute("aria-checked")).toBe("false");
    expect(menu()).not.toBeNull();
  });

  test("ArrowRight on the sub-trigger opens the submenu; ArrowLeft closes it", async () => {
    render(<Example />);
    trigger().focus();
    await key("ArrowUp", trigger());
    await waitFor(() => expect(document.activeElement).toBe(item("Copy as")));
    expect(item("Copy as").getAttribute("aria-haspopup")).toBe("menu");
    await key("ArrowRight");
    await waitFor(() => expect($('[data-slot="dropdown-menu-sub-content"]')).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(item("SQL")));
    await key("ArrowLeft");
    await waitFor(() => expect($('[data-slot="dropdown-menu-sub-content"]')).toBeNull());
    expect(document.activeElement).toBe(item("Copy as"));
  });

  test("the menu and its submenu take the trigger's theme, at z.popover", async () => {
    render(<Example />, { theme: "dark", density: "compact" });
    await click(trigger());
    await click(item("Copy as"));
    await waitFor(() => expect($$('[data-slot="dropdown-menu-positioner"]')).toHaveLength(2));
    for (const positioner of $$('[data-slot="dropdown-menu-positioner"]')) {
      expect(positioner.getAttribute("data-theme")).toBe("dark");
      expect(positioner.getAttribute("data-density")).toBe("compact");
      expect(zLayer(positioner)).toBe(500);
    }
  });

  test("honours reduced motion", async () => {
    render(<Example />);
    await click(trigger());
    expect(honoursReducedMotion($$("[data-slot^='dropdown-menu-']"))).toEqual([]);
  });
});
