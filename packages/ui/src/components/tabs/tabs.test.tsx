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
    <Tabs appearance="enclosed" size="small" value={active} onValueChange={(value) => setActive(value as string)}>
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

  test("takes Fluent appearances and sizes, and the old variant and size names as aliases", () => {
    const strip = (props: Record<string, unknown>) => {
      const { container, unmount } = render(
        <Tabs {...props} defaultValue="a">
          <TabsList>
            <TabsTrigger value="a">A</TabsTrigger>
          </TabsList>
        </Tabs>,
      );
      const root = container.querySelector("[data-slot=tabs]") as HTMLElement;
      const result = [root.dataset.appearance, root.dataset.size];
      unmount();
      return result;
    };
    expect(strip({})).toEqual(["transparent", "medium"]);
    expect(strip({ appearance: "subtle", size: "large" })).toEqual(["subtle", "large"]);
    expect(strip({ variant: "line", size: "sm" })).toEqual(["transparent", "small"]);
    expect(strip({ appearance: "enclosed", variant: "line" })).toEqual(["enclosed", "medium"]);
  });
});

describe("Tabs: a strip that overflows (Fluent's overflow menu)", () => {
  // jsdom has no layout: the strip's width, each tab's width (100 px) and the More button's (32 px)
  // are stubbed, and ResizeObserver is a fake whose callbacks the test calls.
  let stripWidth = 400;
  let observers: (() => void)[] = [];
  let undo: (() => void)[] = [];
  const stub = () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset["slot"] === "tabs-strip" ? stripWidth : 0;
    });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const slot = this.dataset["slot"];
      const w = slot === "tabs-item" ? 100 : slot === "dropdown-menu-trigger" ? 32 : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: 24, width: w, height: 24, toJSON: () => ({}) } as DOMRect;
    });
    const previous = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    undo = [() => width.mockRestore(), () => rect.mockRestore(), () => (globalThis.ResizeObserver = previous)];
  };
  afterEach(() => {
    for (const step of undo) step();
    undo = [];
    observers = [];
    stripWidth = 400;
  });

  function ManyTabs({ initial = "a", names = ["a", "b", "c", "d", "e", "f"] }: { initial?: string; names?: string[] }) {
    const [tabs, setTabs] = useState(names);
    const [active, setActive] = useState(initial);
    const close = (id: string) => setTabs((current) => current.filter((t) => t !== id));
    return (
      <Tabs value={active} onValueChange={(value) => setActive(value as string)}>
        <TabsList aria-label="Query tabs">
          {tabs.map((t) => (
            <TabsTrigger key={t} value={t} onClose={() => close(t)}>
              Query {t}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((t) => (
          <TabsContent key={t} value={t}>
            Panel {t}
          </TabsContent>
        ))}
      </Tabs>
    );
  }
  const more = () => $<HTMLButtonElement>('[data-slot="tabs-strip"] [data-slot="dropdown-menu-trigger"]')!;
  const overflowing = () => $$('[data-slot="tabs-item"][data-overflow]').map((item) => item.textContent);
  const resize = async (width: number) => {
    stripWidth = width;
    await act(async () => {
      for (const callback of observers) callback();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
  };

  test("the strip is clipped on both axes and never scrolls; when the tabs fit there is no More button", () => {
    stub();
    render(<ManyTabs names={["a", "b", "c"]} />);
    const list = $('[data-slot="tabs-list"]')!;
    expect(list.className).toContain("overflow-hidden");
    expect(list.className).not.toMatch(/overflow-(x|y)-auto|overflow-auto|overflow-scroll/);
    expect(overflowing()).toEqual([]);
    expect(more().hidden).toBe(true);
  });

  test("tabs that do not fit are hidden and listed in the More tabs menu", async () => {
    stub();
    stripWidth = 350;
    const { container } = render(<ManyTabs />);
    // 350 px less the 32 px button holds three 100 px tabs.
    expect(overflowing()).toEqual(["Query d", "Query e", "Query f"]);
    expect(more().hidden).toBe(false);
    expect(more().getAttribute("aria-label")).toBe("More tabs (3)");
    await click(more());
    await waitFor(() => expect($$('[role="menuitem"]').map((item) => item.textContent)).toEqual(["Query d", "Query e", "Query f"]));
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a wider strip shows the hidden tabs again", async () => {
    stub();
    stripWidth = 350;
    render(<ManyTabs />);
    expect(overflowing()).toHaveLength(3);
    await resize(700);
    expect(overflowing()).toEqual([]);
    expect(more().hidden).toBe(true);
  });

  test("the selected tab always stays visible, even when it comes last", () => {
    stub();
    stripWidth = 350;
    render(<ManyTabs initial="f" />);
    expect(overflowing()).toEqual(["Query c", "Query d", "Query e"]);
  });

  test("choosing a hidden tab in the menu selects it, shows it and focuses it", async () => {
    stub();
    stripWidth = 350;
    render(<ManyTabs />);
    await click(more());
    await waitFor(() => expect($$('[role="menuitem"]')).toHaveLength(3));
    await click($$('[role="menuitem"]').find((item) => item.textContent === "Query e")!);
    await waitFor(() => expect(tab("e").getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(overflowing()).toEqual(["Query c", "Query d", "Query f"]));
    await waitFor(() => expect(document.activeElement).toBe(tab("e")));
  });

  test("arrows, Home and End move among the visible tabs only", async () => {
    stub();
    stripWidth = 350;
    render(<ManyTabs />);
    await focus(tab("a"));
    await key("ArrowRight");
    expect(document.activeElement).toBe(tab("b"));
    await key("ArrowRight");
    expect(document.activeElement).toBe(tab("c"));
    await key("ArrowRight");
    expect(document.activeElement).toBe(tab("a"));
    await key("ArrowLeft");
    expect(document.activeElement).toBe(tab("c"));
    await key("Home");
    expect(document.activeElement).toBe(tab("a"));
    await key("End");
    expect(document.activeElement).toBe(tab("c"));
  });

  test("closing a tab makes room for a hidden one", async () => {
    stub();
    stripWidth = 350;
    render(<ManyTabs />);
    await focus(tab("b"));
    await key("Delete");
    await waitFor(() => expect(overflowing()).toEqual(["Query e", "Query f"]));
  });
});
