// Preview tabs (DOC-21 §3.2.1, TSK-111 batch 2): a single click in the tree opens the resource in
// the tool's preview tab (italic title) and the next click replaces it in place; a double click,
// Ctrl or Cmd + click, Enter, Keep open, a double click on the tab, or state to lose (a live stream,
// unsaved changes, a step taken inside it, useKeepTab) makes it a normal tab; a preview survives a
// reload; opening a resource that has a tab focuses it.
import { createMemoryHistory } from "@tanstack/react-router";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { useKeepTab } from "@/app/leave-guard";
import { DEFAULT_SETTINGS, type Layout, type State, StoreProvider, initialState, loadPersisted, reducer } from "@/app/store";
import { initialHistory } from "@/app/tab-history";
import type { ProfileRecord } from "@/profiles/record";
import { MemoryStorage } from "@/profiles/storage";
import { echoTool } from "@/tools/echo";
import type { TabProps, TabRecord, ToolModule } from "@/tools/types";
import { createFakeServices } from "./support/fake-services";
import { act, axeViolations, byRole, cleanup, click, render, settle, tabName, waitFor } from "./support/render";

afterEach(() => cleanup());

const LAYOUT: Layout = { sidebarOpen: true, shellSizes: [25, 75], tool: "nats", navCollapsed: null, pinnedTools: [], closedCategories: [] };

function tab(id: string, tool = "nats"): TabRecord {
  const place = { kind: `${tool}.page`, params: { id }, title: id };
  return { id, tool, profileId: "p", ...place, pinned: false, history: initialHistory(place) };
}
const stateOf = (tabs: TabRecord[]): State => initialState({ tabs, activeTab: tabs[0]?.id ?? null, groups: [], lastActive: {}, layout: LAYOUT, settings: DEFAULT_SETTINGS }, "memory");
const open = (s: State, t: TabRecord, preview = false) => reducer(s, { type: "openTab", tab: t, ...(preview ? { preview: true } : {}) });
const shape = (s: State) => s.tabs.map((t) => `${t.id}${t.preview ? "*" : ""}`);

describe("the store's preview tab (DOC-21 §3.2.1)", () => {
  test("a preview open replaces the tool's preview tab in place; another tool has its own", () => {
    let s = stateOf([tab("a"), tab("t1", "temporal")]);
    s = open(s, tab("b"), true);
    expect(shape(s)).toEqual(["a", "b*", "t1"]);
    s = open(reducer(s, { type: "moveTab", id: "b", index: 0 }), tab("c"), true);
    // In place: where b was, not at the end of the group.
    expect(shape(s)).toEqual(["c*", "a", "t1"]);
    expect(s.activeTab).toBe("c");
    s = open(s, tab("t2", "temporal"), true);
    expect(shape(s)).toEqual(["c*", "a", "t1", "t2*"]);
  });

  test("opening a resource that has a tab focuses it; opening it for good keeps a preview", () => {
    let s = open(stateOf([tab("a")]), tab("b"), true);
    s = reducer(s, { type: "activateTab", id: "a" });
    s = open(s, tab("b"), true);
    expect(s.activeTab).toBe("b");
    expect(shape(s)).toEqual(["a", "b*"]);
    s = open(s, tab("b"));
    expect(shape(s)).toEqual(["a", "b"]);
  });

  test("a normal open leaves the preview tab alone", () => {
    let s = open(stateOf([tab("a")]), tab("b"), true);
    s = open(s, tab("c"));
    expect(shape(s)).toEqual(["a", "b*", "c"]);
  });

  test("state to lose keeps it: a live or paused stream, a step taken inside it; then the next preview opens beside it", () => {
    let s = open(stateOf([tab("a")]), tab("b"), true);
    s = reducer(s, { type: "live", id: "b", live: { status: "ended" } });
    expect(shape(s)).toEqual(["a", "b*"]);
    s = reducer(s, { type: "live", id: "b", live: { status: "paused" } });
    expect(shape(s)).toEqual(["a", "b"]);
    s = open(s, tab("c"), true);
    expect(shape(s)).toEqual(["a", "b", "c*"]);
    // A step replacing the current place (a section shown) does not keep it; a pushed step does.
    s = reducer(s, { type: "navigateTab", id: "c", place: { kind: "nats.page", params: { id: "c", view: "x" }, title: "c" }, replace: true });
    expect(shape(s)).toEqual(["a", "b", "c*"]);
    s = reducer(s, { type: "navigateTab", id: "c", place: { kind: "nats.page", params: { id: "d" }, title: "d" } });
    expect(shape(s)).toEqual(["a", "b", "c"]);
  });

  test("keepTab keeps it; a kept tab is never replaced", () => {
    let s = open(stateOf([]), tab("b"), true);
    s = reducer(s, { type: "keepTab", id: "b" });
    s = open(s, tab("c"), true);
    expect(shape(s)).toEqual(["b", "c*"]);
  });

  test("a preview survives a reload; anything but true is a normal tab", async () => {
    const storage = new MemoryStorage();
    await storage.putWorkspace("tabs", { version: 3, tabs: [{ ...tab("a"), preview: true }, { ...tab("b"), preview: "yes" }], activeTab: "a", groups: ["nats"] });
    const p = await loadPersisted(storage, ["nats"]);
    expect(p.tabs.map((t) => t.preview)).toEqual([true, undefined]);
  });
});

// --- In the shell ----------------------------------------------------------------------------------

/** A page whose button starts a draft (useKeepTab), as a Composer with typed text does. */
function PageTab({ tab: t }: TabProps) {
  const [draft, setDraft] = useState(false);
  useKeepTab(draft);
  return (
    <div>
      <p>On {t.title}</p>
      <button type="button" onClick={() => setDraft(true)}>
        Start a draft
      </button>
    </div>
  );
}

const walkTool: ToolModule = {
  ...echoTool,
  id: "walk",
  label: "Walk",
  order: 1,
  sidebarTree: ({ profile: p }) =>
    ["First", "Second", "Third"].map((name, i) => ({ id: `${p.id}/${i}`, label: `${name} page`, open: { kind: "walk.page", params: { n: String(i) }, title: `${name} page` } })),
  tabKinds: { "walk.page": { title: (p) => `Page ${String(p["n"])}`, Component: PageTab } },
};
const tools = [walkTool, echoTool];

function profile(): ProfileRecord {
  return { id: "01PWALK", tool: "walk", version: 1, name: "lab", createdAt: "2026-11-23T10:00:00.000Z", updatedAt: "2026-11-23T10:00:00.000Z", fields: { greeting: "" }, secrets: {}, extras: {} };
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

const treeItem = (label: string) => Array.from(document.querySelectorAll<HTMLElement>("[role=treeitem]")).find((el) => el.textContent?.includes(label)) ?? null;
const stripTabs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Tabs"] [role="tab"]')).map((t) => tabName(t).replace(/\s+/g, " ").trim());
const dblclick = async (el: Element) => {
  await act(async () => void el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
  await settle(2);
};
const ctrlClick = async (el: Element) => {
  await act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })));
  await settle(2);
};

async function connected() {
  const fake = createFakeServices();
  await fake.storage.putProfile(profile());
  const view = await mount(fake);
  await waitFor(() => treeItem("lab") !== null, "the profile");
  await dblclick(treeItem("lab")!);
  await waitFor(() => treeItem("First page") !== null, "the resource tree");
  return { fake, view };
}

describe("preview tabs in the shell (DOC-21 §3.2.1)", () => {
  test("a click opens a preview tab in italics; the next click replaces it; a double click keeps it", async () => {
    const { view } = await connected();
    await click(treeItem("First page"));
    await waitFor(() => stripTabs().includes("First page, preview"), "the preview tab");
    const title = document.querySelector('[role="tab"][data-preview] [data-slot="tabs-label"] .italic');
    expect(title?.textContent).toContain("First page");
    expect(document.querySelector("[data-testid=preview-note]")).not.toBeNull();
    expect(await axeViolations(view.container)).toEqual([]);

    await click(treeItem("Second page"));
    await waitFor(() => stripTabs().includes("Second page, preview"), "the replaced preview");
    expect(stripTabs()).toEqual(["Second page, preview"]);

    await dblclick(treeItem("Second page")!);
    await waitFor(() => stripTabs().includes("Second page"), "the kept tab");
    expect(document.querySelector("[data-testid=preview-note]")).toBeNull();
    await click(treeItem("Third page"));
    await waitFor(() => stripTabs().join() === "Second page,Third page, preview", "a new preview beside the kept tab");
  });

  test("Ctrl or Cmd + click opens a normal tab; a double click on the tab and Keep open keep a preview", async () => {
    await connected();
    await ctrlClick(treeItem("First page")!);
    await waitFor(() => stripTabs().join() === "First page", "a normal tab");
    await click(treeItem("Second page"));
    await waitFor(() => stripTabs().join() === "First page,Second page, preview", "the preview");
    await dblclick(byRole("tab", /Second page/)!);
    await waitFor(() => stripTabs().join() === "First page,Second page", "kept by a double click on the tab");
    await click(treeItem("Third page"));
    await waitFor(() => stripTabs().includes("Third page, preview"), "a preview");
    await click(byRole("button", /Keep open/));
    await waitFor(() => stripTabs().join() === "First page,Second page,Third page", "kept by Keep open");
  });

  test("the tab's menu has Keep open for a preview", async () => {
    await connected();
    await click(treeItem("First page"));
    await waitFor(() => stripTabs().includes("First page, preview"), "the preview");
    await act(async () => void byRole("tab", /First page/)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    await settle(2);
    await click(byRole("menuitem", /Keep open/));
    await waitFor(() => stripTabs().join() === "First page", "kept from the menu");
  });

  test("state to lose keeps it: a draft started in the tab (useKeepTab)", async () => {
    await connected();
    await click(treeItem("First page"));
    await waitFor(() => stripTabs().includes("First page, preview"), "the preview");
    await click(byRole("button", "Start a draft"));
    await waitFor(() => stripTabs().join() === "First page", "kept by its draft");
    await click(treeItem("Second page"));
    await waitFor(() => stripTabs().join() === "First page,Second page, preview", "the next preview beside it");
  });
});
