import { act, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, focus, honoursReducedMotion, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Tabs, TabsContent, TabsLabel, TabsList, TabsTrigger, formatTabCount } from "./tabs";

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

  function ManyTabs({ initial = "a", names = ["a", "b", "c", "d", "e", "f"], counts = {} }: { initial?: string; names?: string[]; counts?: Record<string, number> }) {
    const [tabs, setTabs] = useState(names);
    const [active, setActive] = useState(initial);
    const close = (id: string) => setTabs((current) => current.filter((t) => t !== id));
    return (
      <Tabs value={active} onValueChange={(value) => setActive(value as string)}>
        <TabsList aria-label="Query tabs">
          {tabs.map((t) => (
            <TabsTrigger key={t} value={t} count={counts[t]} onClose={() => close(t)}>
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

  test("the More tabs menu lists a hidden tab by its title, with its count after it", async () => {
    stub();
    stripWidth = 350;
    render(<ManyTabs counts={{ d: 1234, e: 48_002 }} />);
    await click(more());
    await waitFor(() => expect($$('[role="menuitem"]').map((item) => item.textContent)).toEqual(["Query d1,234", "Query e48k", "Query f"]));
    // The title alone, not the count's visually hidden reading, names the item.
    expect($$('[role="menuitem"]')[1]!.firstChild!.textContent).toBe("Query e");
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

  // A grouped strip (Mightyconsole's tab groups): a group's heading, its tabs, then a folded group's chip.
  function GroupedTabs({ onReorder }: { onReorder?: (value: string | number, index: number) => void }) {
    const [active, setActive] = useState("a");
    return (
      <Tabs value={active} onValueChange={(value) => setActive(value as string)}>
        <TabsList aria-label="Tabs" {...(onReorder ? { onReorder } : {})}>
          <TabsLabel value="group:x">Group X, 4 tabs</TabsLabel>
          {["a", "b", "c", "d"].map((t) => (
            <TabsTrigger key={t} value={t}>
              Query {t}
            </TabsTrigger>
          ))}
          <TabsTrigger value="group:y" keepVisible count={2} countLabel={["tab", "tabs"]}>
            Group Y
          </TabsTrigger>
        </TabsList>
        {["a", "b", "c", "d"].map((t) => (
          <TabsContent key={t} value={t}>
            Panel {t}
          </TabsContent>
        ))}
      </Tabs>
    );
  }

  test("keepVisible tabs and labels stay in the strip; the other tabs go into More tabs first", async () => {
    stub();
    stripWidth = 350;
    const { container } = render(<GroupedTabs />);
    // 350 px less the 32 px button: the label, the selected tab and the kept chip take 300 px.
    expect(overflowing()).toEqual(["Query b", "Query c", "Query d"]);
    expect($('[data-value="group:y"]')!.hasAttribute("data-overflow")).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a TabsLabel is not a tab: it is never selected and the arrow keys pass it", async () => {
    stub();
    render(<GroupedTabs />);
    expect($$('[role="tab"]').map((t) => t.textContent)).toEqual(["Query a", "Query b", "Query c", "Query d", "Group Y, 2 tabs2"]);
    const label = $('[data-slot="tabs-label-item"]')!;
    expect(label.textContent).toBe("Group X, 4 tabs");
    expect(label.closest("[tabindex]")).toBeNull();
    await focus(tab("a"));
    await key("End");
    expect(document.activeElement?.textContent).toContain("Group Y");
    await key("ArrowRight");
    expect(document.activeElement).toBe(tab("a"));
  });

  test("labels take part in reordering: onReorder counts every item of the strip", async () => {
    stub();
    const moves: [string | number, number][] = [];
    render(<GroupedTabs onReorder={(value, index) => moves.push([value, index])} />);
    expect($('[data-value="group:x"]')!.getAttribute("draggable")).toBe("true");
    await focus(tab("a"));
    await key("ArrowLeft", document.activeElement, { altKey: true, shiftKey: true });
    expect(moves).toEqual([["a", 0]]);
  });
});

describe("TabsTrigger count: a number in its own badge", () => {
  /** The name a screen reader gives the tab: its text, less what is aria-hidden. */
  const nameOf = (element: Node): string =>
    [...element.childNodes].map((node) => (node instanceof HTMLElement ? (node.getAttribute("aria-hidden") === "true" ? "" : nameOf(node)) : (node.textContent ?? ""))).join("");
  const badgeOf = (tabElement: Element) => tabElement.querySelector<HTMLElement>('[data-slot="tabs-count"]');
  type CountProps = { count?: number | null | undefined; countLabel?: string; countTone?: "danger" | "warning"; showZero?: boolean };
  const history = (props: CountProps, appearance: "transparent" | "subtle" | "enclosed" = "transparent") =>
    render(
      <Tabs defaultValue="history" appearance={appearance}>
        <TabsList aria-label="Workflow">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="history" {...props}>
            History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="history">Events</TabsContent>
        <TabsContent value="timeline">Lanes</TabsContent>
      </Tabs>,
    );
  const historyTab = () => $$<HTMLButtonElement>('[role="tab"]').find((element) => element.querySelector('[data-slot="tabs-label"]')?.textContent === "History")!;

  test("the count is a badge after the title, and the title stays the title", () => {
    history({ count: 1234, countLabel: "events" });
    const element = historyTab();
    const label = element.querySelector('[data-slot="tabs-label"]')!;
    const badge = badgeOf(element)!;
    expect(label.textContent).toBe("History");
    expect(badge.textContent).toBe("1,234");
    expect(label.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(label.textContent).not.toMatch(/\d/);
  });

  test("the tab keeps one accessible name with the count: History, 1,234 events", () => {
    history({ count: 1234, countLabel: "events" });
    const element = historyTab();
    expect(badgeOf(element)!.getAttribute("aria-hidden")).toBe("true");
    expect(element.querySelector(".sr-only")!.textContent).toBe(", 1,234 events");
    expect(nameOf(element)).toBe("History, 1,234 events");
  });

  test("a countLabel pair says one for 1 and the plural otherwise", () => {
    const named = (count: number, countMore = false) => {
      const { unmount } = render(
        <Tabs defaultValue="a">
          <TabsList aria-label="Tabs">
            <TabsTrigger value="a" count={count} countMore={countMore} countLabel={["event", "events"]}>
              History
            </TabsTrigger>
          </TabsList>
          <TabsContent value="a">Panel</TabsContent>
        </Tabs>,
      );
      const name = nameOf($('[role="tab"]')!);
      unmount();
      return name;
    };
    expect(named(1)).toBe("History, 1 event");
    expect(named(2)).toBe("History, 2 events");
    expect(named(1, true)).toBe("History, at least 1 event");
  });

  test("without a countLabel the name is the title and the number", () => {
    history({ count: 7 });
    expect(nameOf(historyTab())).toBe("History, 7");
  });

  test("a large count is shortened; the badge's title and the name keep the full number", () => {
    history({ count: 12_400, countLabel: "events" });
    const element = historyTab();
    expect(badgeOf(element)!.textContent).toBe("12.4k");
    expect(badgeOf(element)!.getAttribute("title")).toBe("12,400 events");
    expect(nameOf(element)).toBe("History, 12,400 events");
  });

  test("a first page of a longer list reads 50+ and is named at least 50 runs", () => {
    render(
      <Tabs defaultValue="runs">
        <TabsList aria-label="Thread">
          <TabsTrigger value="runs" count={50} countMore countLabel="runs">
            Runs
          </TabsTrigger>
        </TabsList>
        <TabsContent value="runs">Panel</TabsContent>
      </Tabs>,
    );
    const element = $('[role="tab"]')!;
    expect(badgeOf(element)!.textContent).toBe("50+");
    expect(badgeOf(element)!.getAttribute("title")).toBe("at least 50 runs");
    expect(nameOf(element)).toBe("Runs, at least 50 runs");
  });

  test("formatTabCount: in full below 10,000, then one decimal, cut and never rounded up", () => {
    const cases: [number, string][] = [
      [0, "0"],
      [9, "9"],
      [1234, "1,234"],
      [9999, "9,999"],
      [10_000, "10k"],
      [12_400, "12.4k"],
      [12_499, "12.4k"],
      [48_002, "48k"],
      [999_999, "999.9k"],
      [1_000_000, "1M"],
      [1_234_567, "1.2M"],
      [2_500_000_000, "2.5B"],
      [-5, "0"],
      [12.9, "12"],
    ];
    for (const [count, shown] of cases) expect(formatTabCount(count), String(count)).toBe(shown);
  });

  test("zero is hidden unless the tab asks to show it; so are null, undefined and NaN", () => {
    for (const count of [0, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { unmount } = history({ count, countLabel: "events" });
      expect(badgeOf(historyTab()), String(count)).toBeNull();
      expect(nameOf(historyTab())).toBe("History");
      unmount();
    }
    history({ count: 0, countLabel: "consumers", showZero: true });
    expect(badgeOf(historyTab())!.textContent).toBe("0");
    expect(nameOf(historyTab())).toBe("History, 0 consumers");
  });

  test("neutral by default, a tone for what needs attention", () => {
    const { unmount } = history({ count: 3 });
    expect(badgeOf(historyTab())!.getAttribute("data-variant")).toBe("neutral");
    unmount();
    history({ count: 3, countTone: "danger", countLabel: "failures" });
    expect(badgeOf(historyTab())!.getAttribute("data-variant")).toBe("danger");
    // The tone is never the only signal: the number and what it counts are in the name.
    expect(nameOf(historyTab())).toBe("History, 3 failures");
  });

  test("the badge has its own fill and text pair, so its contrast does not depend on the tab behind it", () => {
    for (const appearance of ["transparent", "subtle", "enclosed"] as const) {
      const { unmount } = history({ count: 5 }, appearance);
      const badge = badgeOf(historyTab())!;
      const classes = (badge.getAttribute("class") ?? "").split(/\s+/);
      // The subtle appearance paints the pair the token engine checks (color.neutral.subtle-fg on
      // color.neutral.subtle-bg), not a wash of the tab's, whichever appearance the tab has.
      expect(badge.getAttribute("data-appearance")).toBe("subtle");
      expect(classes).toContain("data-[appearance=subtle]:bg-neutral-subtle");
      expect(classes).toContain("data-[appearance=subtle]:text-neutral-subtle-fg");
      unmount();
    }
  });

  test("the count never squeezes the title: it keeps its size and the title truncates", () => {
    history({ count: 5 });
    const badge = badgeOf(historyTab())!;
    expect(badge.className).toContain("shrink-0");
    expect(badge.className).toContain("tabular-nums");
    expect(historyTab().querySelector('[data-slot="tabs-label"]')!.className).toContain("truncate");
  });

  test("a closable tab with a count keeps one name and a working close button", async () => {
    const onClose = vi.fn();
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Tabs">
          <TabsTrigger value="a" count={4} countLabel="rows" onClose={onClose}>
            Orders
          </TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel</TabsContent>
      </Tabs>,
    );
    expect(nameOf($('[role="tab"]')!)).toBe("Orders, 4 rows");
    await click($('[data-slot="tabs-close"]')!);
    expect(onClose).toHaveBeenCalled();
  });

  test("passes axe with counts, in every appearance", async () => {
    for (const appearance of ["transparent", "subtle", "enclosed"] as const) {
      const { container, unmount } = history({ count: 48_002, countLabel: "events", countTone: "danger" }, appearance);
      expect(await axeViolations(container), appearance).toEqual([]);
      unmount();
    }
  });
});
