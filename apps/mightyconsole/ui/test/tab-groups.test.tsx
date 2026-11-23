// Tabs grouped by tool (DOC-21 §3.2.1, TSK-111 batch 1): the store keeps each tool's tabs together
// in the groups' order, moves tabs inside their group and groups as a whole, opens a folded group on
// its last focused tab, picks the next tab when one closes, saves version 3 of the tabs document and
// reads version 2 without losing a tab; the strip draws the open group behind its heading and the
// others as chips, and a chip opens its group.
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, test } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { DEFAULT_SETTINGS, type Layout, type State, StoreProvider, TABS_VERSION, initialState, loadPersisted, reducer } from "@/app/store";
import { initialHistory } from "@/app/tab-history";
import { moveOf, stripOrder } from "@/app/tab-strip";
import type { ProfileRecord } from "@/profiles/record";
import { MemoryStorage } from "@/profiles/storage";
import { echoTool } from "@/tools/echo";
import type { TabRecord, ToolModule } from "@/tools/types";
import { createFakeServices } from "./support/fake-services";
import { act, axeViolations, byRole, cleanup, click, render, settle, tabName, waitFor } from "./support/render";

afterEach(() => cleanup());

const LAYOUT: Layout = { sidebarOpen: true, shellSizes: [25, 75], tool: "nats", navCollapsed: null, pinnedTools: [], closedCategories: [] };

function tab(id: string, tool: string, profileId = "p"): TabRecord {
  const place = { kind: `${tool}.page`, params: { id }, title: id };
  return { id, tool, profileId, ...place, pinned: false, history: initialHistory(place) };
}

function stateOf(tabs: TabRecord[], activeTab: string | null = tabs[0]?.id ?? null): State {
  return initialState({ tabs, activeTab, groups: [], lastActive: {}, layout: LAYOUT, settings: DEFAULT_SETTINGS }, "memory");
}

const ids = (s: State) => s.tabs.map((t) => t.id);

describe("the store keeps tabs in groups (DOC-21 §3.2.1)", () => {
  test("each tool's tabs sit together, the groups in the order of each tool's first tab", () => {
    const s = stateOf([tab("n1", "nats"), tab("t1", "temporal"), tab("n2", "nats"), tab("d1", "docker")]);
    expect(s.groups).toEqual(["nats", "temporal", "docker"]);
    expect(ids(s)).toEqual(["n1", "n2", "t1", "d1"]);
  });

  test("a new tab goes at the end of its group; a new tool's group goes last", () => {
    let s = stateOf([tab("n1", "nats"), tab("t1", "temporal")]);
    s = reducer(s, { type: "openTab", tab: tab("n2", "nats") });
    expect(ids(s)).toEqual(["n1", "n2", "t1"]);
    expect(s.activeTab).toBe("n2");
    s = reducer(s, { type: "openTab", tab: tab("l1", "langgraph") });
    expect(s.groups).toEqual(["nats", "temporal", "langgraph"]);
    expect(ids(s)).toEqual(["n1", "n2", "t1", "l1"]);
  });

  test("a tab moves inside its group only; a group moves as a whole", () => {
    let s = stateOf([tab("n1", "nats"), tab("n2", "nats"), tab("n3", "nats"), tab("t1", "temporal"), tab("t2", "temporal")]);
    s = reducer(s, { type: "moveTab", id: "n3", index: 0 });
    expect(ids(s)).toEqual(["n3", "n1", "n2", "t1", "t2"]);
    s = reducer(s, { type: "moveTab", id: "t1", index: 9 });
    expect(ids(s)).toEqual(["n3", "n1", "n2", "t2", "t1"]);
    s = reducer(s, { type: "moveGroup", tool: "temporal", index: 0 });
    expect(s.groups).toEqual(["temporal", "nats"]);
    expect(ids(s)).toEqual(["t2", "t1", "n3", "n1", "n2"]);
    expect(reducer(s, { type: "moveGroup", tool: "temporal", index: 0 })).toBe(s);
  });

  test("a folded group opens on its last focused tab", () => {
    let s = stateOf([tab("n1", "nats"), tab("t1", "temporal"), tab("t2", "temporal")]);
    s = reducer(s, { type: "activateTab", id: "t2" });
    s = reducer(s, { type: "activateTab", id: "n1" });
    expect(s.lastActive).toEqual({ nats: "n1", temporal: "t2" });
    s = reducer(s, { type: "openGroup", tool: "temporal" });
    expect(s.activeTab).toBe("t2");
  });

  test("closing the focused tab focuses its right neighbour in the group, else its left, else the next group's last focused tab", () => {
    let s = stateOf([tab("n1", "nats"), tab("n2", "nats"), tab("n3", "nats"), tab("t1", "temporal"), tab("t2", "temporal"), tab("d1", "docker")]);
    s = reducer(reducer(s, { type: "activateTab", id: "t2" }), { type: "activateTab", id: "n2" });
    s = reducer(s, { type: "closeTab", id: "n2" });
    expect(s.activeTab).toBe("n3");
    s = reducer(s, { type: "closeTab", id: "n3" });
    expect(s.activeTab).toBe("n1");
    s = reducer(s, { type: "closeTab", id: "n1" });
    // The NATS group is gone; Temporal comes next and opens on its last focused tab.
    expect(s.groups).toEqual(["temporal", "docker"]);
    expect(s.activeTab).toBe("t2");
    s = reducer(reducer(s, { type: "activateTab", id: "d1" }), { type: "closeTab", id: "d1" });
    // The last group: the group before it.
    expect(s.activeTab).toBe("t2");
  });

  test("closing a tab that is not focused leaves the focus where it is", () => {
    let s = stateOf([tab("n1", "nats"), tab("t1", "temporal")], "t1");
    s = reducer(s, { type: "closeTab", id: "n1" });
    expect(s.activeTab).toBe("t1");
    expect(s.groups).toEqual(["temporal"]);
  });
});

describe("the tabs document, version 3", () => {
  test("version 2 is read without losing a tab: groups in the order of each tool's first tab, tabs keeping their order", async () => {
    const storage = new MemoryStorage();
    const v2 = [tab("n1", "nats"), tab("t1", "temporal"), tab("n2", "nats"), tab("t2", "temporal")];
    await storage.putWorkspace("tabs", { version: 2, tabs: v2, activeTab: "t2" });
    const p = await loadPersisted(storage, ["nats", "temporal"]);
    expect(p.tabs.map((t) => t.id)).toEqual(["n1", "n2", "t1", "t2"]);
    expect(p.groups).toEqual(["nats", "temporal"]);
    expect(p.activeTab).toBe("t2");
    expect(p.lastActive).toEqual({ nats: "n1", temporal: "t2" });
  });

  test("version 3 keeps the groups' order and each group's last focused tab; unknown tools are left out", async () => {
    const storage = new MemoryStorage();
    await storage.putWorkspace("tabs", { version: 3, tabs: [tab("n1", "nats"), tab("n2", "nats"), tab("t1", "temporal")], activeTab: "t1", groups: ["gone", "temporal", "nats"], lastActive: { nats: "n2", gone: "x" } });
    const p = await loadPersisted(storage, ["nats", "temporal"]);
    expect(p.groups).toEqual(["temporal", "nats"]);
    expect(p.tabs.map((t) => t.id)).toEqual(["t1", "n1", "n2"]);
    expect(p.lastActive).toEqual({ temporal: "t1", nats: "n2" });
    expect(TABS_VERSION).toBe(3);
  });
});

describe("moving items of the grouped strip", () => {
  const tabs = [tab("n1", "nats"), tab("n2", "nats"), tab("t1", "temporal")];
  const order = stripOrder(tabs, ["nats", "temporal"], "nats", null);

  test("the strip is each group's chip or heading, the open group's tabs after its heading", () => {
    expect(order).toEqual(["group:nats", "n1", "n2", "group:temporal"]);
    expect(stripOrder(tabs, ["nats", "temporal"], "temporal", "link")).toEqual(["group:nats", "group:temporal", "t1", "link"]);
  });

  test("a tab dropped inside its group moves there; dropped outside it snaps back", () => {
    expect(moveOf(order, tabs, "n2", 1)).toEqual({ tab: "n2", index: 0 });
    // Alt+Shift+Left on the group's first tab would put it before its own heading.
    expect(moveOf(order, tabs, "n1", 0)).toBeNull();
    expect(moveOf(order, tabs, "n1", 3)).toBeNull();
  });

  test("a chip or a heading dropped among the groups moves its group", () => {
    expect(moveOf(order, tabs, "group:temporal", 0)).toEqual({ group: "temporal", index: 0 });
    expect(moveOf(order, tabs, "group:nats", 3)).toEqual({ group: "nats", index: 1 });
  });
});

// --- The strip in the shell ----------------------------------------------------------------------

const walkTool: ToolModule = {
  ...echoTool,
  id: "walk",
  label: "Walk",
  order: 1,
  tabKinds: { "walk.page": { title: (p) => `Page ${String(p["n"])}`, Component: () => <p>A page</p> } },
};
const tools = [walkTool, echoTool];

function profile(tool: string): ProfileRecord {
  return { id: `01P${tool.toUpperCase()}`, tool, version: 1, name: "lab", createdAt: "2026-11-23T10:00:00.000Z", updatedAt: "2026-11-23T10:00:00.000Z", fields: { greeting: "" }, secrets: {}, extras: {} };
}

function placeTab(id: string, tool: string, kind: string, params: Record<string, unknown>, title: string): TabRecord {
  const place = { kind, params, title };
  return { id, tool, profileId: `01P${tool.toUpperCase()}`, ...place, pinned: false, history: initialHistory(place) };
}

async function mount(fake: ReturnType<typeof createFakeServices>) {
  const persisted = await loadPersisted(fake.storage, tools.map((t) => t.id));
  const view = render(
    <ServicesContext.Provider value={fake.services}>
      <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
        <App tools={tools} history={createMemoryHistory({ initialEntries: ["/"] })} />
      </StoreProvider>
    </ServicesContext.Provider>,
  );
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.events"), "the events subscription");
  return view;
}

async function seeded() {
  const fake = createFakeServices();
  await fake.storage.putProfile(profile("walk"));
  await fake.storage.putProfile(profile("echo"));
  // A version 2 document, tools interleaved as the flat strip left them.
  await fake.storage.putWorkspace("tabs", {
    version: 2,
    activeTab: "w1",
    tabs: [placeTab("w1", "walk", "walk.page", { n: "1" }, "Page 1"), placeTab("e1", "echo", "echo.ping", {}, "Ping"), placeTab("w2", "walk", "walk.page", { n: "2" }, "Page 2")],
  });
  return fake;
}

/** A tab by its accessible name, less what is aria-hidden ("Echo, 1 tab"). */
const tabNamed = (name: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => tabName(t).replace(/\s+/g, " ").trim() === name) ?? null;
const strip = () => document.querySelector<HTMLElement>('[role="tablist"][aria-label="Tabs"]')!;
const stripText = () => Array.from(strip().querySelectorAll<HTMLElement>('[data-slot="tabs-item"]')).map((item) => item.dataset["value"]);

describe("the grouped strip (DOC-21 §3.2.1)", () => {
  test("the open group's heading and tabs, the other groups as chips; a chip opens its group", async () => {
    const fake = await seeded();
    const { container } = await mount(fake);
    await waitFor(() => byRole("tab", "Page 1") !== null, "the tabs");
    expect(stripText()).toEqual(["group:walk", "w1", "w2", "group:echo"]);
    // The open group's heading is not a tab; it reads the tool and its count.
    const heading = strip().querySelector<HTMLElement>('[data-value="group:walk"]')!;
    expect(heading.querySelector('[role="tab"]')).toBeNull();
    expect(heading.textContent).toBe("Walk, 2 tabs2");
    // The folded group is a tab named by its tool and count, kept out of "More tabs".
    const chip = tabNamed("Echo, 1 tab")!;
    expect(chip.closest("[data-keep]")).not.toBeNull();
    expect(chip.getAttribute("aria-selected")).toBe("false");
    expect(await axeViolations(container)).toEqual([]);

    await click(chip);
    await waitFor(() => byRole("tab", "Ping")?.getAttribute("aria-selected") === "true", "the Echo group open on Ping");
    expect(stripText()).toEqual(["group:walk", "group:echo", "e1"]);
    expect(tabNamed("Walk, 2 tabs")).not.toBeNull();

    // Back to Walk: it opens on the tab focused there last.
    await click(tabNamed("Walk, 2 tabs")!);
    await waitFor(() => byRole("tab", "Page 1")?.getAttribute("aria-selected") === "true", "Walk open on Page 1");
  });

  test("the grouping and the order survive a reload, saved as version 3", async () => {
    const fake = await seeded();
    const view = await mount(fake);
    await waitFor(() => byRole("tab", "Page 1") !== null, "the tabs");
    await click(tabNamed("Echo, 1 tab")!);
    await waitFor(() => byRole("tab", "Ping")?.getAttribute("aria-selected") === "true", "Echo open");
    await settle(4);
    const saved = await fake.storage.getWorkspace<{ version: number; groups: string[]; activeTab: string; tabs: TabRecord[] }>("tabs");
    expect(saved).toMatchObject({ version: 3, groups: ["walk", "echo"], activeTab: "e1" });
    expect(saved!.tabs.map((t) => t.id)).toEqual(["w1", "w2", "e1"]);
    view.unmount();

    const again = createFakeServices();
    await again.storage.putProfile(profile("walk"));
    await again.storage.putProfile(profile("echo"));
    await again.storage.putWorkspace("tabs", saved);
    await mount(again);
    await waitFor(() => byRole("tab", "Ping")?.getAttribute("aria-selected") === "true", "Echo open after the reload");
    expect(stripText()).toEqual(["group:walk", "group:echo", "e1"]);
  });

  test("a tab's context menu closes the others in its group", async () => {
    const fake = await seeded();
    await mount(fake);
    await waitFor(() => byRole("tab", "Page 1") !== null, "the tabs");
    await act(async () => {
      byRole("tab", "Page 1")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle(2);
    await click(byRole("menuitem", "Close others in group")!);
    await waitFor(() => byRole("tab", "Page 2") === null, "Page 2 closed");
    expect(stripText()).toEqual(["group:walk", "w1", "group:echo"]);
  });
});
