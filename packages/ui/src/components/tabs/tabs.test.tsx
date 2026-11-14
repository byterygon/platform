import { act, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, focus, honoursReducedMotion, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

afterEach(cleanup);

function QueryTabs({ onReorder }: { onReorder?: (value: string | number, index: number) => void }) {
  const [tabs, setTabs] = useState(["a", "b", "c"]);
  const [active, setActive] = useState<string>("a");
  const close = (id: string) => {
    setTabs((current) => {
      const rest = current.filter((tab) => tab !== id);
      if (id === active && rest.length > 0) setActive(rest[0]!);
      return rest;
    });
  };
  const reorder = (value: string | number, index: number) => {
    onReorder?.(value, index);
    setTabs((current) => {
      const rest = current.filter((tab) => tab !== value);
      return [...rest.slice(0, index), String(value), ...rest.slice(index)];
    });
  };
  return (
    <Tabs variant="enclosed" size="sm" value={active} onValueChange={(value) => setActive(value as string)}>
      <TabsList onReorder={reorder}>
        {tabs.map((tab) => (
          <TabsTrigger key={tab} value={tab} onClose={() => close(tab)}>
            Query {tab}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab} value={tab}>
          Panel {tab}
        </TabsContent>
      ))}
    </Tabs>
  );
}

const tab = (name: string) => $$<HTMLButtonElement>('[role="tab"]').find((element) => element.textContent === `Query ${name}`)!;
const titles = () => $$('[role="tab"]').map((element) => element.textContent);

function dragEvent(type: string, init: { clientX?: number } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; clientX: number; clientY: number };
  const data = new Map<string, string>();
  Object.defineProperty(event, "dataTransfer", {
    value: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", effectAllowed: "all", dropEffect: "none" },
  });
  Object.defineProperty(event, "clientX", { value: init.clientX ?? 0 });
  Object.defineProperty(event, "clientY", { value: 0 });
  return event;
}

describe("Tabs", () => {
  test("a tablist of tabs controlling labelled panels", async () => {
    const { container } = render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">First</TabsContent>
        <TabsContent value="two">Second</TabsContent>
      </Tabs>,
    );
    expect($('[data-slot="tabs-list"]')!.getAttribute("role")).toBe("tablist");
    const [one, two] = $$('[role="tab"]');
    expect(one!.getAttribute("aria-selected")).toBe("true");
    expect(two!.getAttribute("aria-selected")).toBe("false");
    const panel = $('[role="tabpanel"]')!;
    expect(panel.textContent).toBe("First");
    expect(panel.getAttribute("aria-labelledby")).toBe(one!.id);
    await click(two!);
    expect(two!.getAttribute("aria-selected")).toBe("true");
    expect($('[role="tabpanel"]:not([hidden])')!.textContent).toBe("Second");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("arrow keys, Home and End move focus along the strip", async () => {
    render(<QueryTabs />);
    await focus(tab("a"));
    await key("ArrowRight");
    expect(document.activeElement).toBe(tab("b"));
    await key("End");
    expect(document.activeElement).toBe(tab("c"));
    await key("Home");
    expect(document.activeElement).toBe(tab("a"));
  });

  test("Delete closes the focused tab and moves focus to its neighbour", async () => {
    const { container } = render(<QueryTabs />);
    expect(tab("a").getAttribute("aria-keyshortcuts")).toContain("Delete");
    await focus(tab("a"));
    await key("Delete");
    expect(titles()).toEqual(["Query b", "Query c"]);
    await waitFor(() => expect(document.activeElement).toBe(tab("b")));
    expect(tab("b").getAttribute("aria-selected")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("the close button is out of the tab order and hidden from assistive technology; clicking it closes the tab", async () => {
    render(<QueryTabs />);
    const close = $$<HTMLButtonElement>('[data-slot="tabs-close"]')[1]!;
    expect(close.tabIndex).toBe(-1);
    expect(close.getAttribute("aria-hidden")).toBe("true");
    await click(close);
    expect(titles()).toEqual(["Query a", "Query c"]);
  });

  test("Alt+Shift+Arrow moves the focused tab and keeps focus on it", async () => {
    const onReorder = vi.fn();
    render(<QueryTabs onReorder={onReorder} />);
    await focus(tab("a"));
    await key("ArrowRight", tab("a"), { altKey: true, shiftKey: true });
    expect(onReorder).toHaveBeenLastCalledWith("a", 1);
    expect(titles()).toEqual(["Query b", "Query a", "Query c"]);
    expect(document.activeElement).toBe(tab("a"));
    await key("ArrowLeft", tab("a"), { altKey: true, shiftKey: true });
    expect(titles()).toEqual(["Query a", "Query b", "Query c"]);
    await key("ArrowLeft", tab("a"), { altKey: true, shiftKey: true });
    expect(titles()).toEqual(["Query a", "Query b", "Query c"]);
  });

  test("dragging a tab onto another reorders them and marks the drop side", async () => {
    const onReorder = vi.fn();
    render(<QueryTabs onReorder={onReorder} />);
    const item = (name: string) => tab(name).closest<HTMLElement>('[data-slot="tabs-item"]')!;
    expect(item("a").draggable).toBe(true);
    await act(async () => {
      item("a").dispatchEvent(dragEvent("dragstart"));
    });
    expect(item("a").hasAttribute("data-dragging")).toBe(true);
    await act(async () => {
      item("c").dispatchEvent(dragEvent("dragover", { clientX: 100 }));
    });
    expect(item("c").getAttribute("data-drop")).toBe("after");
    await act(async () => {
      item("c").dispatchEvent(dragEvent("drop", { clientX: 100 }));
    });
    expect(onReorder).toHaveBeenLastCalledWith("a", 2);
    expect(titles()).toEqual(["Query b", "Query c", "Query a"]);
    expect($("[data-drop]")).toBeNull();
  });

  test("tabs without onReorder or onClose are neither draggable nor closable", () => {
    render(
      <Tabs defaultValue="one" orientation="vertical">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect($<HTMLElement>('[data-slot="tabs-item"]')!.draggable).toBe(false);
    expect($('[data-slot="tabs-close"]')).toBeNull();
    expect($('[role="tab"]')!.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect($('[data-slot="tabs-list"]')!.getAttribute("aria-orientation")).toBe("vertical");
  });

  test("honours reduced motion: nothing moves", () => {
    render(<QueryTabs />);
    expect(honoursReducedMotion($$("[data-slot^='tabs']"))).toEqual([]);
  });
});
