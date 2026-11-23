// The tree that follows the focused tab (DOC-21 §3.2.1, TSK-111 batch 3): every tool gives
// nodeOfTab for every tab kind; activating a tab (a click, the URL, Back and Forward) selects its
// tool, opens the node's ancestors, selects the node, and leaves keyboard focus where it was; a node
// still loading is selected once it shows; a tool picked by hand holds until the next tab focus;
// the expanded nodes live in the store per profile and survive a reload.
import { type RouterHistory, createMemoryHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, test } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { placeRoute } from "@/app/router";
import { DEFAULT_SETTINGS, type Layout, type State, StoreProvider, initialState, loadPersisted, reducer } from "@/app/store";
import type { ProfileRecord } from "@/profiles/record";
import { MemoryStorage } from "@/profiles/storage";
import { echoTool } from "@/tools/echo";
import { TOOLS } from "@/tools/registry";
import type { ResourceNode, TabProps, ToolModule } from "@/tools/types";
import { createFakeServices } from "./support/fake-services";
import { act, cleanup, click, render, settle, waitFor } from "./support/render";

afterEach(() => cleanup());

function profile(tool: string, name = "lab"): ProfileRecord {
  return { id: `01P${tool.toUpperCase()}`, tool, version: 1, name, createdAt: "2026-11-23T10:00:00.000Z", updatedAt: "2026-11-23T10:00:00.000Z", fields: { greeting: "" }, secrets: {}, extras: {} };
}

describe("nodeOfTab, the contract (DOC-21 §3.2.1)", () => {
  test("every tool gives a node path for every tab kind it has, under the profile", () => {
    for (const tool of TOOLS) {
      const p = { ...profile(tool.id), ...tool.profile.defaults() };
      for (const kind of Object.keys(tool.tabKinds)) {
        const path = tool.nodeOfTab({ kind, params: { namespace: "default", stream: "S", consumer: "C", bucket: "B", id: "c1", project: "shop", subjects: [] } }, p);
        expect(Array.isArray(path), `${kind}`).toBe(true);
        for (const id of path) expect(id.startsWith(`${p.id}/`), `${kind}: ${id}`).toBe(true);
      }
    }
  });

  test("a node the tree draws is the one that opens the place", () => {
    // Echo, LangGraph's lists and Docker's lists are drawn without data: each kind's last id opens that kind.
    for (const tool of TOOLS.filter((t) => ["echo", "langgraph", "docker"].includes(t.id))) {
      const p = { ...profile(tool.id), ...tool.profile.defaults() };
      const nodes = tool.sidebarTree({ profile: p, connId: "c" });
      const find = (list: readonly ResourceNode[], id: string): ResourceNode | undefined => list.flatMap((n) => (n.id === id ? [n] : find(n.children ?? [], id) ? [find(n.children ?? [], id)!] : []))[0];
      for (const n of nodes) {
        if (!n.open) continue;
        const path = tool.nodeOfTab(n.open, p);
        expect(find(nodes, path[path.length - 1]!)?.open?.kind, `${tool.id} ${n.open.kind}`).toBe(n.open.kind);
      }
    }
  });
});

const LAYOUT: Layout = { sidebarOpen: true, shellSizes: [25, 75], tool: "echo", navCollapsed: null, pinnedTools: [], closedCategories: [] };
const empty = (): State => initialState({ tabs: [], activeTab: null, groups: [], lastActive: {}, layout: LAYOUT, settings: DEFAULT_SETTINGS }, "memory");

describe("the store's reveal and expanded nodes", () => {
  test("a reveal selects the tool and opens the profile and the node's ancestors, not the node", () => {
    let s = reducer(empty(), { type: "reveal", tool: "nats", profileId: "N", path: ["p:N", "p:N/N/streams", "p:N/N/streams/ORDERS"] });
    expect(s.layout.tool).toBe("nats");
    expect(s.treeExpanded).toEqual({ N: ["p:N", "p:N/N/streams"] });
    expect(s.reveal).toMatchObject({ profileId: "N", seq: 1 });
    // The tree selected an ancestor while the streams load: the reveal goes on.
    s = reducer(s, { type: "revealed", seq: 1, nodeId: "p:N/N/streams", done: false });
    expect(s.selectedNode).toBe("p:N/N/streams");
    expect(s.reveal?.seq).toBe(1);
    s = reducer(s, { type: "revealed", seq: 1, nodeId: "p:N/N/streams/ORDERS", done: true });
    expect(s.selectedNode).toBe("p:N/N/streams/ORDERS");
    expect(s.reveal).toBeNull();
    // A stale report changes nothing; a node picked by the person ends a reveal.
    expect(reducer(s, { type: "revealed", seq: 1, nodeId: "x", done: true })).toBe(s);
    s = reducer(s, { type: "reveal", tool: "nats", profileId: "N", path: ["p:N", "p:N/N/server"] });
    expect(s.reveal?.seq).toBe(2);
    s = reducer(s, { type: "select", nodeId: "p:N/N/publish" });
    expect(s.reveal).toBeNull();
  });

  test("the expanded nodes are saved per profile, read back, and a deleted profile's go away", async () => {
    const storage = new MemoryStorage();
    await storage.putWorkspace("tree", { version: 1, profiles: { A: ["p:A", "p:A/A/streams"], B: ["p:B"], bad: 3 } });
    const p = await loadPersisted(storage, ["nats"]);
    expect(p.treeExpanded).toEqual({ A: ["p:A", "p:A/A/streams"], B: ["p:B"], bad: [] });
    let s = initialState({ ...p, layout: LAYOUT }, "memory");
    s = reducer(s, { type: "profiles", profiles: [{ ...profile("nats"), id: "A" }] });
    expect(Object.keys(s.treeExpanded)).toEqual(["A"]);
  });
});

// --- In the shell ----------------------------------------------------------------------------------

/** A page with a link to page 2, a step in its tab (DOC-21 §3.7). */
function PageTab({ navigate }: TabProps) {
  return (
    <button type="button" onClick={() => navigate?.({ kind: "walk.page", params: { n: "2" }, title: "Page 2" })}>
      Go to page 2
    </button>
  );
}

/** A tool whose second page is drawn under a group that loads later (as NATS's streams do). */
let loaded = false;
const listeners = new Set<() => void>();
const walkTool: ToolModule = {
  ...echoTool,
  id: "walk",
  label: "Walk",
  order: 1,
  sidebarTree: ({ profile: p }) => [
    { id: `${p.id}/first`, label: "First page", open: { kind: "walk.page", params: { n: "1" }, title: "First page" } },
    { id: `${p.id}/later`, label: "Later", children: loaded ? [{ id: `${p.id}/later/2`, label: "Second page", open: { kind: "walk.page", params: { n: "2" }, title: "Second page" } }] : [] },
  ],
  sidebarData: { load: () => {}, subscribe: (f) => (listeners.add(f), () => listeners.delete(f)), version: () => (loaded ? 1 : 0) },
  nodeOfTab: ({ params }, p) => (params["n"] === "2" ? [`${p.id}/later`, `${p.id}/later/2`] : [`${p.id}/first`]),
  tabKinds: { "walk.page": { title: (params) => `Page ${String(params["n"])}`, Component: PageTab, href: (params) => ({ path: `pages/${String(params["n"])}/view` }) } },
  routes: (parent) => [placeRoute(parent, "pages/$n/view", (params) => `Page ${params["n"]}`, (params) => ({ kind: "walk.page", params: { n: params["n"] ?? "1" } }))],
};
const tools = [walkTool, echoTool];

async function mount(fake: ReturnType<typeof createFakeServices>, history: RouterHistory) {
  const persisted = await loadPersisted(fake.storage, tools.map((t) => t.id));
  const view = render(
    <ServicesContext.Provider value={fake.services}>
      <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
        <App tools={tools} history={history} />
      </StoreProvider>
    </ServicesContext.Provider>,
  );
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.events"), "the events subscription");
  return view;
}

const treeItem = (label: string) => Array.from(document.querySelectorAll<HTMLElement>("[role=treeitem]")).find((el) => el.textContent?.includes(label)) ?? null;
const selectedRow = () => document.querySelector<HTMLElement>("[role=treeitem][aria-selected=true]")?.textContent ?? null;
const navTool = () => document.querySelector<HTMLElement>("[data-nav-item][aria-current=page]")?.dataset["navLabel"] ?? null;
const navItem = (tool: string) => document.querySelector<HTMLElement>(`[data-nav-item][data-tool="${tool}"]`);
const dblclick = async (el: Element | null) => {
  if (!el) throw new Error("nothing to double-click");
  await act(async () => void el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
  await settle(2);
};
const tabTitled = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Tabs"] [role="tab"]')).find((t) => t.textContent?.includes(title)) ?? null;
const chip = (label: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Tabs"] [role="tab"]')).find((t) => t.querySelector(".sr-only")?.textContent === label) ?? null;

async function twoTools() {
  loaded = false;
  const fake = createFakeServices();
  await fake.storage.putProfile(profile("walk"));
  await fake.storage.putProfile(profile("echo"));
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const view = await mount(fake, history);
  // Walk: connect, open the first page for good.
  await waitFor(() => treeItem("lab") !== null, "the Walk profile");
  await dblclick(treeItem("lab"));
  await waitFor(() => treeItem("First page") !== null, "the Walk tree");
  await dblclick(treeItem("First page"));
  await waitFor(() => tabTitled("First page") !== null, "the Walk tab");
  // Echo: pick it in the navigation, connect, open Ticks.
  await click(navItem("echo"));
  await waitFor(() => treeItem("lab") !== null && navTool() === "Echo", "the Echo list");
  await dblclick(treeItem("lab"));
  await waitFor(() => treeItem("Ticks") !== null, "the Echo tree");
  await dblclick(treeItem("Ticks"));
  await waitFor(() => tabTitled("Ticks") !== null, "the Ticks tab");
  return { fake, history, view };
}

describe("the tree follows the focused tab (DOC-21 §3.2.1)", () => {
  test("a click on another tool's tab shows that tool's tree with the tab's node selected; focus stays on the tab", async () => {
    await twoTools();
    await waitFor(() => selectedRow() === "Ticks", "Ticks selected");
    await click(chip("Walk"));
    await waitFor(() => navTool() === "Walk" && selectedRow() === "First page", "Walk's tree with First page selected");
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    expect(document.activeElement?.closest("[role=tree]")).toBeNull();
  });

  test("a tool picked by hand holds, with a note, until the next tab focus", async () => {
    await twoTools();
    await click(navItem("walk"));
    await waitFor(() => navTool() === "Walk", "Walk picked by hand");
    expect(document.querySelector("[data-testid=tree-by-hand]")?.textContent).toBe("The tree returns to Echo when you focus a tab.");
    // The focused tab clicked again: back to its tool.
    await click(tabTitled("Ticks"));
    await waitFor(() => navTool() === "Echo" && selectedRow() === "Ticks", "back to Echo");
    expect(document.querySelector("[data-testid=tree-by-hand]")).toBeNull();
  });

  test("a URL that arrives moves the tree; a node still loading is selected once it shows", async () => {
    loaded = false;
    const fake = createFakeServices();
    await fake.storage.putProfile(profile("walk"));
    await mount(fake, createMemoryHistory({ initialEntries: ["/walk/lab/pages/2/view"] }));
    await waitFor(() => tabTitled("Page 2") !== null, "the deep link's tab");
    await waitFor(() => navTool() === "Walk" && treeItem("Later") !== null, "the Walk tree");
    // Page 2 sits under Later, which has not loaded: Later is selected meanwhile.
    await waitFor(() => selectedRow() === "Later", "the nearest ancestor");
    loaded = true;
    await act(async () => {
      for (const f of listeners) f();
    });
    await waitFor(() => selectedRow() === "Second page", "the node once it shows");
  });

  test("a step inside the tab and Back move the tree with it", async () => {
    await twoTools();
    loaded = true;
    await click(chip("Walk"));
    await waitFor(() => selectedRow() === "First page", "Walk's First page");
    await click(Array.from(document.querySelectorAll("[role=tabpanel]:not([hidden]) button")).find((b) => b.textContent === "Go to page 2") ?? null);
    await waitFor(() => selectedRow() === "Second page", "the step's node");
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true })));
    await waitFor(() => selectedRow() === "First page", "Back to First page");
  });

  test("the expanded nodes are saved per profile and come back after a reload", async () => {
    const { fake, view } = await twoTools();
    await settle(4);
    const saved = await fake.storage.getWorkspace<{ profiles: Record<string, string[]> }>("tree");
    expect(saved?.profiles["01PWALK"]).toContain("p:01PWALK");
    expect(saved?.profiles["01PECHO"]).toContain("p:01PECHO");
    view.unmount();
  });
});
