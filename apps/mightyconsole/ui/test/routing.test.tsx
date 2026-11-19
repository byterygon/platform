// Routing (DOC-21 §3.7, TSK-101) on a memory history: each routed tab kind's URL gives its place
// back through the real route tree; a tab's own back and forward history (50 steps, migration of
// version 1 tabs); the URL follows the active tab; a URL that arrives opens or focuses its tab, a
// missing profile is named; Alt+Left and Alt+Right, the history's Back and Forward and the mouse's
// buttons move the active tab; a step of a closed tab reopens it; the history survives a reload.
import { type RouterHistory, createMemoryHistory } from "@tanstack/react-router";
import { afterEach, describe, expect, test } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { buildRouteTree, createAppRouter, placeHref, readRouterConfig, targetOf, webSocketUrl } from "@/app/router";
import { StoreProvider, TABS_VERSION, loadPersisted } from "@/app/store";
import { TAB_HISTORY_LIMIT, goTab, initialHistory, migrateTab, pushPlace, replacePlace } from "@/app/tab-history";
import type { ProfileRecord } from "@/profiles/record";
import { echoTool } from "@/tools/echo";
import { TOOLS } from "@/tools/registry";
import type { TabPlace, TabProps, TabRecord, ToolModule } from "@/tools/types";
import { placeRoute } from "@/app/router";
import { createFakeServices } from "./support/fake-services";
import { act, byRole, byText, cleanup, click, key, render, settle, waitFor } from "./support/render";

afterEach(() => cleanup());

// --- URLs ----------------------------------------------------------------------------------------

function parse(router: ReturnType<typeof createAppRouter>, href: string) {
  const [pathname = "/", search = ""] = href.split("?");
  return router.parseLocation({ href, pathname, search: search ? `?${search}` : "", hash: "", state: { __TSR_index: 0 } });
}

describe("URLs (DOC-21 §3.7)", () => {
  const router = createAppRouter(TOOLS, () => null, createMemoryHistory({ initialEntries: ["/"] }), { mode: "memory", basePath: "" });
  const profile = { name: "prod.eu/1" };
  const tool = (id: string) => TOOLS.find((t) => t.id === id)!;
  const cases: { tool: string; place: Omit<TabPlace, "title">; href: string; back?: Record<string, unknown> }[] = [
    { tool: "echo", place: { kind: "echo.ping", params: {} }, href: "/echo/prod.eu%2F1/ping" },
    { tool: "echo", place: { kind: "echo.ticks", params: {} }, href: "/echo/prod.eu%2F1/ticks" },
    { tool: "echo", place: { kind: "echo.messages", params: {} }, href: "/echo/prod.eu%2F1/messages" },
    { tool: "echo", place: { kind: "echo.compose", params: {} }, href: "/echo/prod.eu%2F1/compose" },
    { tool: "temporal", place: { kind: "temporal.namespaces", params: {} }, href: "/temporal/prod.eu%2F1/namespaces" },
    { tool: "temporal", place: { kind: "temporal.workflows", params: { namespace: "orders", query: "" } }, href: "/temporal/prod.eu%2F1/orders/workflows" },
    {
      tool: "temporal",
      place: { kind: "temporal.workflows", params: { namespace: "orders", query: "ExecutionStatus = 'Running'" } },
      href: "/temporal/prod.eu%2F1/orders/workflows?q=ExecutionStatus+%3D+%27Running%27",
    },
    // A namespace called like a static segment still reaches its own routes.
    { tool: "temporal", place: { kind: "temporal.workers", params: { namespace: "namespaces" } }, href: "/temporal/prod.eu%2F1/namespaces/workers" },
    {
      tool: "temporal",
      place: { kind: "temporal.workflow", params: { namespace: "orders", workflowId: "order:48213/a.b", runId: "7f0c", view: "history" } },
      href: "/temporal/prod.eu%2F1/orders/workflows/order%3A48213%2Fa.b/history?run=7f0c",
    },
    // A workflow opened from a list has no view yet: its URL shows the first section.
    {
      tool: "temporal",
      place: { kind: "temporal.workflow", params: { namespace: "orders", workflowId: "w1" } },
      href: "/temporal/prod.eu%2F1/orders/workflows/w1/timeline",
      back: { namespace: "orders", workflowId: "w1", view: "timeline" },
    },
    { tool: "temporal", place: { kind: "temporal.schedules", params: { namespace: "orders" } }, href: "/temporal/prod.eu%2F1/orders/schedules" },
    { tool: "temporal", place: { kind: "temporal.schedule", params: { namespace: "orders", scheduleId: "nightly" } }, href: "/temporal/prod.eu%2F1/orders/schedules/nightly/overview" },
    { tool: "temporal", place: { kind: "temporal.taskQueue", params: { namespace: "orders", name: "" } }, href: "/temporal/prod.eu%2F1/orders/task-queues" },
    { tool: "temporal", place: { kind: "temporal.taskQueue", params: { namespace: "orders", name: "fulfilment" } }, href: "/temporal/prod.eu%2F1/orders/task-queues/fulfilment/overview" },
    { tool: "langgraph", place: { kind: "langgraph.assistants", params: {} }, href: "/langgraph/prod.eu%2F1/assistants" },
    {
      tool: "langgraph",
      place: { kind: "langgraph.assistant", params: { assistantId: "a-1", name: "agent" } },
      href: "/langgraph/prod.eu%2F1/assistants/a-1/graph",
      back: { assistantId: "a-1", view: "graph" },
    },
    { tool: "langgraph", place: { kind: "langgraph.thread", params: { threadId: "3f2a9c1e", view: "state" } }, href: "/langgraph/prod.eu%2F1/threads/3f2a9c1e/state" },
    { tool: "langgraph", place: { kind: "langgraph.threads", params: {} }, href: "/langgraph/prod.eu%2F1/threads" },
    { tool: "langgraph", place: { kind: "langgraph.store", params: {} }, href: "/langgraph/prod.eu%2F1/store" },
  ];

  test.each(cases)("$place.kind → $href → the place", ({ tool: id, place, href, back }) => {
    expect(placeHref(tool(id), profile, place)).toBe(href);
    expect(targetOf(router, parse(router, href), TOOLS)).toEqual({ type: "place", tool: id, profileName: "prod.eu/1", place: { kind: place.kind, params: back ?? place.params } });
  });

  test("every routed tab kind is covered; a long query stays in the tab", () => {
    const covered = new Set(cases.map((c) => c.place.kind));
    for (const t of TOOLS.filter((x) => x.routes)) for (const [kind, k] of Object.entries(t.tabKinds)) if (k.href) expect(covered, kind).toContain(kind);
    expect(placeHref(tool("temporal"), profile, { kind: "temporal.workflows", params: { namespace: "o", query: "x".repeat(201) } })).toBe("/temporal/prod.eu%2F1/o/workflows");
  });

  test("a URL that is not a place names its tool, or nothing", () => {
    expect(targetOf(router, parse(router, "/"), TOOLS)).toEqual({ type: "start" });
    expect(targetOf(router, parse(router, "/nope/x"), TOOLS)).toEqual({ type: "start" });
    expect(targetOf(router, parse(router, "/temporal"), TOOLS)).toEqual({ type: "tool", tool: "temporal" });
    expect(targetOf(router, parse(router, "/temporal/lab"), TOOLS)).toEqual({ type: "tool", tool: "temporal", profileName: "lab" });
    // No view word: not a place.
    expect(targetOf(router, parse(router, "/temporal/lab/orders/workflows/w1"), TOOLS)).toMatchObject({ type: "tool", tool: "temporal" });
    expect(targetOf(router, parse(router, "/temporal/lab/orders/workflows/w1/nonsense"), TOOLS)).toMatchObject({ type: "tool", tool: "temporal" });
    // NATS has no routes yet: its tabs stay at /nats.
    const nats = tool("nats");
    expect(placeHref(nats, { name: "lab" }, { kind: Object.keys(nats.tabKinds)[0]!, params: {} })).toBe("/nats");
  });

  test("routes carry breadcrumb labels", () => {
    const tree = buildRouteTree(TOOLS, () => null);
    const crumbs: string[] = [];
    const walk = (route: { options: { staticData?: { crumb?: (p: Record<string, string>) => string } }; children?: unknown }) => {
      const crumb = route.options.staticData?.crumb;
      if (crumb) crumbs.push(crumb({ profile: "lab", namespace: "orders", workflowId: "w1", threadId: "3f2a9c1e5b", assistantId: "a", scheduleId: "s", name: "q" }));
      for (const child of (route.children as (typeof route)[] | undefined) ?? []) walk(child);
    };
    walk(tree as never);
    expect(crumbs).toEqual(expect.arrayContaining(["Mightyconsole", "Temporal", "lab", "orders", "Workflows", "w1", "History", "Input and result", "Threads", "3f2a9c1e5b"]));
  });

  test("the page's mode and base path come from the server's meta", () => {
    const doc = document.implementation.createHTMLDocument("x");
    expect(readRouterConfig(doc)).toEqual({ mode: "browser", basePath: "" });
    doc.head.innerHTML = '<meta name="mightyconsole-router" content="hash"><meta name="mightyconsole-base" content="/tools/mc">';
    expect(readRouterConfig(doc)).toEqual({ mode: "hash", basePath: "/tools/mc" });
    doc.head.innerHTML = '<meta name="mightyconsole-router" content="other"><meta name="mightyconsole-base" content="/a/../b">';
    expect(readRouterConfig(doc)).toEqual({ mode: "browser", basePath: "" });
    expect(webSocketUrl({ mode: "hash", basePath: "/tools/mc" }, "localhost:7443")).toBe("wss://localhost:7443/tools/mc/rpc/ws");
    expect(webSocketUrl({ mode: "browser", basePath: "" }, "localhost:7443")).toBe("wss://localhost:7443/rpc/ws");
  });
});

// --- A tab's history -----------------------------------------------------------------------------

describe("a tab's own history (DOC-21 §3.7)", () => {
  const page = (n: number): TabPlace => ({ kind: "walk.page", params: { n: String(n) }, title: `Page ${n}` });
  const tab = (): TabRecord => ({ id: "t", tool: "walk", profileId: "p", ...page(0), pinned: false, history: initialHistory(page(0)) });

  test("push, back, forward, a push after back drops the steps ahead, 50 steps at most", () => {
    let t = pushPlace(pushPlace(tab(), page(1)), page(2));
    expect(t.params).toEqual({ n: "2" });
    t = goTab(goTab(t, -1), -1);
    expect(t.title).toBe("Page 0");
    expect(goTab(t, -1)).toBe(t);
    t = goTab(t, 1);
    expect(t.title).toBe("Page 1");
    t = pushPlace(t, page(9));
    expect(t.history.entries.map((e) => e.title)).toEqual(["Page 0", "Page 1", "Page 9"]);
    // The same place again is not a new step; a replace changes the current one.
    expect(pushPlace(t, page(9)).history.entries).toHaveLength(3);
    expect(replacePlace(t, page(8)).history.entries.map((e) => e.title)).toEqual(["Page 0", "Page 1", "Page 8"]);
    for (let n = 10; n < 100; n++) t = pushPlace(t, page(n));
    expect(t.history.entries).toHaveLength(TAB_HISTORY_LIMIT);
    expect(t.history.entries[0]!.title).toBe("Page 50");
    expect(t.history.index).toBe(TAB_HISTORY_LIMIT - 1);
  });

  test("version 1 tabs get one step; a broken history falls back to the tab's place", () => {
    const v1 = { id: "t", tool: "walk", profileId: "p", ...page(3), pinned: false };
    expect(migrateTab(v1).history).toEqual({ entries: [page(3)], index: 0 });
    expect(migrateTab({ ...v1, history: { entries: [page(1), page(2)], index: 7 } }).history).toEqual({ entries: [page(3)], index: 0 });
    const ok = migrateTab({ ...v1, history: { entries: [page(1), page(2)], index: 0 } });
    expect(ok.history.index).toBe(0);
    expect(ok.title).toBe("Page 1");
  });
});

// --- The shell -----------------------------------------------------------------------------------

/** A tool whose tab moves between pages with `navigate`, as TSK-105's links will. */
function PageTab({ tab, navigate }: TabProps) {
  const n = Number(tab.params["n"] ?? 0);
  return (
    <div>
      <p>On page {n}</p>
      <button type="button" onClick={() => navigate?.({ kind: "walk.page", params: { n: String(n + 1) }, title: `Page ${n + 1}` })}>
        Next page
      </button>
    </div>
  );
}

const walkTool: ToolModule = {
  ...echoTool,
  id: "walk",
  label: "Walk",
  order: 1,
  sidebarTree: ({ profile: p }) => [{ id: `${p.id}/first`, label: "First page", open: { kind: "walk.page", params: { n: "0" }, title: "Page 0" } }],
  tabKinds: { "walk.page": { title: (p) => `Page ${String(p["n"])}`, Component: PageTab, href: (p) => ({ path: `pages/${encodeURIComponent(String(p["n"]))}/view` }) } },
  routes: (parent) => [placeRoute(parent, "pages/$n/view", (p) => `Page ${p["n"]}`, (p) => ({ kind: "walk.page", params: { n: p["n"] ?? "0" } }))],
};
const tools = [walkTool, echoTool];

function profile(patch: Partial<ProfileRecord> = {}): ProfileRecord {
  return { id: `01P${Math.random().toString(36).slice(2, 10).toUpperCase()}`, tool: "walk", version: 1, name: "lab", createdAt: "2026-11-19T10:00:00.000Z", updatedAt: "2026-11-19T10:00:00.000Z", fields: { greeting: "" }, secrets: {}, extras: {}, ...patch };
}

type Fake = ReturnType<typeof createFakeServices>;

async function mount(fake: Fake, initial = "/"): Promise<{ history: RouterHistory; unmount: () => void }> {
  const persisted = await loadPersisted(fake.storage, tools.map((t) => t.id));
  const history = createMemoryHistory({ initialEntries: [initial] });
  const view = render(
    <ServicesContext.Provider value={fake.services}>
      <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
        <App tools={tools} history={history} />
      </StoreProvider>
    </ServicesContext.Provider>,
  );
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.events"), "the events subscription");
  return { history, unmount: view.unmount };
}

const treeItem = (label: string) => Array.from(document.querySelectorAll<HTMLElement>("[role=treeitem]")).find((el) => el.textContent?.includes(label)) ?? null;
const tabNamed = (name: string | RegExp) => byRole("tab", name);
const shown = (text: string) => {
  const panel = document.querySelector<HTMLElement>("[role=tabpanel]:not([hidden])");
  return panel !== null && byText(text, panel) !== null;
};

async function openFirstPage() {
  await waitFor(() => treeItem("lab") !== null, "the profile");
  await act(async () => treeItem("lab")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await waitFor(() => treeItem("First page") !== null, "the resource tree");
  await act(async () => treeItem("First page")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await waitFor(() => tabNamed("Page 0") !== null, "the tab");
}

const entry = (history: RouterHistory) => ({ href: history.location.href, tab: (history.location.state as { mcTab?: string }).mcTab, step: (history.location.state as { mcStep?: number }).mcStep });

describe("the shell on the router (DOC-21 §3.7)", () => {
  test("the URL follows the active tab; steps push, Alt+Left and Alt+Right move the tab", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    const { history } = await mount(fake);
    expect(history.location.href).toBe("/walk");
    await openFirstPage();
    await waitFor(() => history.location.href === "/walk/lab/pages/0/view", "the tab's URL");
    const length = history.length;
    await waitFor(() => shown("On page 0"), "the page");
    // A step pushes an entry and carries the tab's id and step.
    await click(byRole("button", "Next page"));
    await waitFor(() => history.location.href === "/walk/lab/pages/1/view", "the next page's URL");
    expect(history.length).toBe(length + 1);
    expect(entry(history)).toMatchObject({ step: 1 });
    expect(tabNamed("Page 1")).not.toBeNull();
    await click(byRole("button", "Next page"));
    await waitFor(() => shown("On page 2"), "page 2");
    // Alt+Left and Alt+Right move inside the tab and replace the entry.
    await key("ArrowLeft", { altKey: true }, document.body);
    await waitFor(() => shown("On page 1"), "back to page 1");
    expect(history.location.href).toBe("/walk/lab/pages/1/view");
    expect(history.length).toBe(length + 2);
    await key("ArrowRight", { altKey: true }, document.body);
    await waitFor(() => shown("On page 2"), "forward to page 2");
    // The palette lists them; Forward is off at the end of the tab's history.
    await key("k", { ctrlKey: true }, document.body);
    await waitFor(() => byRole("option", /Back in this tab/) !== null, "the palette");
    expect(byRole("option", /Forward in this tab/)?.getAttribute("aria-disabled")).toBe("true");
    await key("Escape", {}, document.body);

    // Opening another tab replaces the entry; switching back too.
    await act(async () => treeItem("First page")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    await waitFor(() => history.location.href === "/walk/lab/pages/0/view", "the new tab's URL");
    expect(tabNamed("Page 0")).not.toBeNull();
    expect(history.length).toBe(length + 2);
    await click(tabNamed("Page 2"));
    await waitFor(() => history.location.href === "/walk/lab/pages/2/view", "the first tab's URL again");
  });

  test("the history's Back and Forward move the active tab, else show the entry's own step", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    const { history } = await mount(fake);
    await openFirstPage();
    await click(byRole("button", "Next page"));
    await click(byRole("button", "Next page"));
    await waitFor(() => shown("On page 2"), "page 2");
    await act(async () => history.back());
    await waitFor(() => shown("On page 1"), "back to page 1");
    expect(entry(history)).toMatchObject({ href: "/walk/lab/pages/1/view", step: 1 });
    await act(async () => history.forward());
    await waitFor(() => shown("On page 2"), "forward to page 2");
    // The mouse's back button (memory mode: the shell reads it).
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true })));
    await waitFor(() => shown("On page 1"), "the mouse's back button");
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup", { button: 4, bubbles: true })));
    await waitFor(() => shown("On page 2"), "the mouse's forward button");

    // A step of a closed tab reopens it with its history.
    await key("W", { altKey: true, shiftKey: true }, document.body);
    await waitFor(() => tabNamed("Page 2") === null, "the tab closed");
    expect(history.location.href).toBe("/walk");
    await act(async () => history.back());
    await waitFor(() => tabNamed("Page 1") !== null, "the tab reopened at that step");
    await waitFor(() => shown("On page 1"), "its page");
    await key("ArrowRight", { altKey: true }, document.body);
    await waitFor(() => shown("On page 2"), "its history came back with it");
  });

  test("a URL that arrives opens or focuses its tab; a missing profile is named", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    const first = await mount(fake, "/walk/lab/pages/7/view");
    await waitFor(() => tabNamed("Page 7") !== null, "the deep link's tab");
    await waitFor(() => shown("On page 7"), "its page");
    expect(first.history.location.href).toBe("/walk/lab/pages/7/view");
    // A pasted URL (an entry without a tab id) focuses the tab already there.
    await click(byRole("button", "Next page"));
    await waitFor(() => shown("On page 8"), "page 8");
    await act(async () => first.history.push("/walk/lab/pages/8/view"));
    await act(async () => first.history.push("/walk/lab/pages/3/view"));
    await act(async () => first.history.back());
    await waitFor(() => tabNamed("Page 8") !== null && document.querySelectorAll("[role=tab]").length === 1, "the same tab focused");
    first.unmount();

    const fake2 = createFakeServices();
    await fake2.storage.putProfile(profile());
    await mount(fake2, "/walk/prod-eu/pages/1/view");
    await waitFor(() => byText("This link needs a Walk profile named prod-eu") !== null, "the missing profile's page");
    // Only the link tab, not saved with the workspace.
    expect(document.querySelectorAll("[role=tab]")).toHaveLength(1);
  });

  test("the tabs' history survives a reload; version 1 tabs migrate", async () => {
    const fake = createFakeServices();
    const p = profile();
    await fake.storage.putProfile(p);
    const first = await mount(fake);
    await openFirstPage();
    await click(byRole("button", "Next page"));
    await waitFor(() => shown("On page 1"), "page 1");
    await settle(4);
    const saved = await fake.storage.getWorkspace<{ version: number; tabs: TabRecord[] }>("tabs");
    expect(saved?.version).toBe(TABS_VERSION);
    expect(saved?.tabs[0]?.history.entries.map((e) => e.title)).toEqual(["Page 0", "Page 1"]);
    first.unmount();

    // A reload at `/`: the restored active tab's URL, and its Back still works.
    const second = await mount(fake);
    await waitFor(() => second.history.location.href === "/walk/lab/pages/1/view", "the restored tab's URL");
    await waitFor(() => shown("On page 1"), "the restored page");
    await key("ArrowLeft", { altKey: true }, document.body);
    await waitFor(() => shown("On page 0"), "back after the reload");
    second.unmount();

    // A workspace written before TSK-101.
    const fake2 = createFakeServices();
    await fake2.storage.putProfile(p);
    await fake2.storage.putWorkspace("tabs", { tabs: [{ id: "old", tool: "walk", profileId: p.id, kind: "walk.page", params: { n: "5" }, title: "Page 5", pinned: false }], activeTab: "old" });
    const third = await mount(fake2);
    await waitFor(() => third.history.location.href === "/walk/lab/pages/5/view", "the migrated tab's URL");
    expect(tabNamed("Page 5")).not.toBeNull();
  });
});
