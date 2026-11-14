import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, focus, honoursReducedMotion, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "./sidebar";

afterEach(cleanup);

function Shell({ collapsible = "icon", defaultOpen = true, onOpenChange }: { collapsible?: "icon" | "offcanvas" | "none"; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void }) {
  return (
    <SidebarProvider defaultOpen={defaultOpen} {...(onOpenChange ? { onOpenChange } : {})}>
      <Sidebar aria-label="Connections" collapsible={collapsible}>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton icon={<svg aria-hidden="true" />} active>
                  Connections
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton icon={<svg aria-hidden="true" />}>History</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
      </SidebarInset>
    </SidebarProvider>
  );
}

const sidebar = () => $('[data-slot="sidebar"]')!;
const trigger = () => $<HTMLButtonElement>('[data-slot="sidebar-trigger"]')!;
const button = (text: string) => $$<HTMLButtonElement>('[data-slot="sidebar-menu-button"]').find((element) => element.textContent === text)!;

describe("Sidebar", () => {
  test("an aside landmark beside a main, with a labelled group of buttons and the current entry", async () => {
    const { container } = render(<Shell />);
    expect(sidebar().tagName).toBe("ASIDE");
    expect(sidebar().getAttribute("aria-label")).toBe("Connections");
    expect($('[data-slot="sidebar-inset"]')!.tagName).toBe("MAIN");
    const group = $('[data-slot="sidebar-group"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Workspace");
    expect(button("Connections").getAttribute("aria-current")).toBe("page");
    expect(button("History").hasAttribute("aria-current")).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("the trigger toggles it, with aria-expanded and aria-controls; Ctrl+B does the same", async () => {
    const onOpenChange = vi.fn();
    render(<Shell onOpenChange={onOpenChange} />);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(sidebar().id);
    await click(trigger());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(sidebar().dataset.collapsed).toBe("icon");
    await key("b", document.body, { ctrlKey: true });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(sidebar().dataset.state).toBe("expanded");
  });

  test("in the icon rail the labels stay named (visually hidden) and show as tooltips on focus", async () => {
    const { container } = render(<Shell defaultOpen={false} />);
    const history = button("History");
    expect(history.hasAttribute("data-collapsed")).toBe(true);
    expect(history.querySelector("span")!.className).toContain("data-collapsed:sr-only");
    expect($('[data-slot="sidebar-group-label"]')!.hasAttribute("data-collapsed")).toBe(true);
    await focus(history);
    await waitFor(() => expect($('[data-slot="tooltip-content"]')?.textContent).toBe("History"));
    expect(await axeViolations(container)).toEqual([]);
  });

  test("off-canvas hides the closed panel; collapsible none never collapses", async () => {
    render(<Shell collapsible="offcanvas" defaultOpen={false} />);
    expect(sidebar().dataset.collapsed).toBe("offcanvas");
    expect(sidebar().className).toContain("data-[collapsed=offcanvas]:hidden");
    cleanup();
    render(<Shell collapsible="none" defaultOpen={false} />);
    expect(sidebar().dataset.state).toBe("expanded");
  });

  test("honours reduced motion", () => {
    render(<Shell />);
    expect(honoursReducedMotion($$("[data-slot^='sidebar']"))).toEqual([]);
  });
});
