// The navigation row and the missing-profile page (DOC-21 §3.7, TSK-105) on a memory history: the
// breadcrumb from the matched routes (labels, links up, a level's siblings keeping the view), Back
// and Forward with this tab's list, the link and Copy link, the palette's Go to parent; a link to a
// profile this browser lacks shows its page, keeps its URL, and opens where it points once a
// profile is chosen or created. The Temporal routes' crumbs and siblings' URLs are checked on the
// real route tree.
import { type RouterHistory, createMemoryHistory } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useState } from "react";
import { App } from "@/app/App";
import { useDraftChanged, useLeaveGuard } from "@/app/leave-guard";
import { LinkButton } from "@/app/page";
import { linkTo } from "@/app/tab-view";
import { ServicesContext } from "@/app/client";
import { type SiblingList, crumbsOf, createAppRouter, levelRoute, placeRoute, targetOfHref, withParams } from "@/app/router";
import { StoreProvider, loadPersisted } from "@/app/store";
import type { ProfileRecord } from "@/profiles/record";
import { echoTool } from "@/tools/echo";
import { TOOLS } from "@/tools/registry";
import type { TabProps, ToolModule } from "@/tools/types";
import { createFakeServices } from "./support/fake-services";
import { act, byRole, byText, cleanup, click, key, render, type, waitFor } from "./support/render";

afterEach(() => cleanup());

// --- Crumbs on the real routes --------------------------------------------------------------------

describe("crumbs and siblings on the route tree (DOC-21 §3.7)", () => {
  const router = createAppRouter(TOOLS, () => null, createMemoryHistory({ initialEntries: ["/"] }), { mode: "memory", basePath: "" });

  test("a workflow's crumbs: the profile down, each place a link up, the leaf with its search", () => {
    const href = "/temporal/prod-cluster/orders/workflows/order-48213/history?run=7f0c";
    const crumbs = crumbsOf(router, href);
    expect(crumbs.map((c) => c.label)).toEqual(["prod-cluster", "orders", "Workflows", "order-48213", "History"]);
    expect(crumbs.map((c) => c.href)).toEqual([null, null, "/temporal/prod-cluster/orders/workflows", null, href]);
    expect(crumbs.map((c) => c.profile)).toEqual([true, false, false, false, false]);
    expect(crumbs.map((c) => c.siblings !== undefined)).toEqual([false, true, false, true, false]);
    expect(crumbs[2]!.place).toEqual({ kind: "temporal.workflows", params: { namespace: "orders", query: "" } });
    expect(crumbsOf(router, "/temporal/lab/orders/workflows/w1/nonsense")).toEqual([]);
  });

  test("a sibling keeps the view and the query; a workflow's drops the run", () => {
    const list = "/temporal/lab/orders/workflows?q=ExecutionStatus+%3D+%27Running%27";
    expect(withParams(router, list, { namespace: "pay/ments" })).toBe("/temporal/lab/pay%2Fments/workflows?q=ExecutionStatus+%3D+%27Running%27");
    const workflow = "/temporal/lab/orders/workflows/w1/history?run=7f0c";
    const next = withParams(router, workflow, { workflowId: "w2" }, { run: undefined })!;
    expect(next).toBe("/temporal/lab/orders/workflows/w2/history");
    expect(targetOfHref(router, next, TOOLS)).toEqual({ type: "place", tool: "temporal", profileName: "lab", place: { kind: "temporal.workflow", params: { namespace: "orders", workflowId: "w2", view: "history" } } });
  });

  test("LangGraph's assistant and thread segments have siblings", () => {
    expect(crumbsOf(router, "/langgraph/lab/threads/3f2a9c1e5b/state").map((c) => [c.label, c.siblings !== undefined])).toEqual([
      ["lab", false],
      ["Threads", false],
      ["3f2a9c1e5b", true],
      ["State", false],
    ]);
    expect(crumbsOf(router, "/langgraph/lab/assistants/a-1/graph")[2]!.siblings).toBeDefined();
  });
});

// --- The shell ------------------------------------------------------------------------------------

function ListTab(props: TabProps) {
  const go = linkTo(props);
  return (
    <div>
      <p>All pages</p>
      <LinkButton onOpen={(e) => go({ kind: "walk.page", params: { n: "5" }, title: "Page 5" }, e)}>Open page 5</LinkButton>
    </div>
  );
}

/** A sheet-like editor: open, a draft; a changed draft guards the tab. */
function Editor({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const changed = useDraftChanged(open, text);
  const release = useLeaveGuard(changed);
  return open ? (
    <div>
      <input aria-label="Draft" value={text} onChange={(e) => setText(e.target.value)} />
      <span>{changed ? "Changed" : "Unchanged"}</span>
      <button
        type="button"
        onClick={() => {
          // As the sheets do: saved, the guard goes before the report that moves the tab.
          release();
          onSaved();
          setOpen(false);
        }}
      >
        Save and go
      </button>
    </div>
  ) : (
    <button type="button" onClick={() => setOpen(true)}>
      Edit
    </button>
  );
}

function PageTab({ tab, navigate }: TabProps) {
  const n = Number(tab.params["n"] ?? 0);
  return (
    <div>
      <p>On page {n}</p>
      <button type="button" onClick={() => navigate?.({ kind: "walk.page", params: { n: String(n + 1) }, title: `Page ${n + 1}` })}>
        Next page
      </button>
      <Editor key={n} onSaved={() => navigate?.({ kind: "walk.page", params: { n: String(n + 10) }, title: `Page ${n + 10}` })} />
    </div>
  );
}

const siblings = vi.fn(
  async (): Promise<SiblingList> => ({
    heading: "Pages of the walk",
    items: ["0", "1", "2"].map((n) => ({ label: `Page ${n}`, params: { n } })),
    all: { label: "All pages…", place: { kind: "walk.list", params: {} } },
  }),
);

const walkTool: ToolModule = {
  ...echoTool,
  id: "walk",
  label: "Walk",
  order: 1,
  sidebarTree: ({ profile: p }) => [{ id: `${p.id}/first`, label: "First page", open: { kind: "walk.page", params: { n: "0" }, title: "Page 0" } }],
  tabKinds: {
    "walk.list": { title: () => "Pages", Component: ListTab, href: () => ({ path: "pages" }) },
    "walk.page": { title: (p) => `Page ${String(p["n"])}`, Component: PageTab, href: (p) => ({ path: `pages/${encodeURIComponent(String(p["n"]))}/view` }) },
  },
  routes: (parent) => [
    placeRoute(parent, "pages", "Pages", () => ({ kind: "walk.list", params: {} }), {
      children: (pages) => [levelRoute(pages, "$n", (p) => `Page ${p["n"]}`, (level) => [placeRoute(level, "view", "View", (p) => ({ kind: "walk.page", params: { n: p["n"] ?? "0" } }))], siblings)],
    }),
  ],
};
const tools = [walkTool, echoTool];

function profile(patch: Partial<ProfileRecord> = {}): ProfileRecord {
  return { id: `01P${Math.random().toString(36).slice(2, 10).toUpperCase()}`, tool: "walk", version: 1, name: "lab", createdAt: "2026-11-19T10:00:00.000Z", updatedAt: "2026-11-19T10:00:00.000Z", fields: { greeting: "" }, secrets: {}, extras: {}, ...patch };
}

type Fake = ReturnType<typeof createFakeServices>;

async function mount(fake: Fake, initial = "/"): Promise<{ history: RouterHistory }> {
  const persisted = await loadPersisted(fake.storage, tools.map((t) => t.id));
  const history = createMemoryHistory({ initialEntries: [initial] });
  render(
    <ServicesContext.Provider value={fake.services}>
      <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
        <App tools={tools} history={history} />
      </StoreProvider>
    </ServicesContext.Provider>,
  );
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.events"), "the events subscription");
  return { history };
}

const treeItem = (label: string) => Array.from(document.querySelectorAll<HTMLElement>("[role=treeitem]")).find((el) => el.textContent?.includes(label)) ?? null;
const panel = () => document.querySelector<HTMLElement>("[role=tabpanel]:not([hidden])");
const row = () => panel()?.querySelector<HTMLElement>("[role=toolbar][aria-label=Location]") ?? null;
const shown = (text: string) => panel() !== null && byText(text, panel()!) !== null;
const crumbTexts = () => Array.from(row()?.querySelectorAll<HTMLElement>("[data-slot=breadcrumb-item]") ?? []).map((el) => (el.textContent ?? "").trim());
const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]"));
const menuItem = (text: string | RegExp) => menuItems().find((el) => (typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent ?? ""))) ?? null;

async function openFirstPage() {
  await waitFor(() => treeItem("lab") !== null, "the profile");
  await act(async () => treeItem("lab")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await waitFor(() => treeItem("First page") !== null, "the resource tree");
  await act(async () => treeItem("First page")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await waitFor(() => shown("On page 0"), "the tab");
}

describe("the navigation row (DOC-21 §3.7)", () => {
  const writeText = vi.fn(async (_text: string) => {});
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  test("crumbs, the link, Copy link; a segment's siblings keep the view; a link up and Go to parent", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    const { history } = await mount(fake);
    await openFirstPage();
    await waitFor(() => crumbTexts().join(" / ") === "lab / Pages / Page 0 / View", "the crumbs");
    expect(row()!.querySelector("[aria-current=page]")?.textContent).toBe("View");
    // jsdom lays nothing out: the link text needs room, so only Copy link says it.
    await click(byRole("button", "Copy link", row()!));
    expect(writeText).toHaveBeenCalledWith("/walk/lab/pages/0/view");
    await waitFor(() => byText("Copied link") !== null, "the toast");

    // A level's siblings: picking one keeps the view, as a step.
    await click(byRole("button", /^Page 0/, row()!));
    await waitFor(() => menuItem("Page 2") !== null, "the siblings");
    expect(byText("Pages of the walk")).not.toBeNull();
    expect(siblings).toHaveBeenLastCalledWith(expect.objectContaining({ params: expect.objectContaining({ n: "0", profile: "lab" }), connId: expect.any(String) }));
    const length = history.length;
    await click(menuItem("Page 2"));
    await waitFor(() => shown("On page 2"), "the sibling's page");
    expect(history.location.href).toBe("/walk/lab/pages/2/view");
    expect(history.length).toBe(length + 1);

    // A place above is a link up; Back returns.
    await click(byRole("button", "Pages", row()!));
    await waitFor(() => shown("All pages"), "the list");
    expect(history.location.href).toBe("/walk/lab/pages");
    expect(crumbTexts()).toEqual(["lab", "Pages"]);
    await click(byRole("button", "Back", row()!));
    await waitFor(() => shown("On page 2"), "back");

    // The palette's Go to parent: the nearest place above.
    await key("k", { ctrlKey: true }, document.body);
    await waitFor(() => byRole("option", /Go to parent/) !== null, "the palette");
    await click(byRole("option", /Go to parent/));
    await waitFor(() => shown("All pages"), "the parent");
  });

  test("the row is a toolbar: arrows move between its controls, Down opens a segment's menu", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    await mount(fake);
    await openFirstPage();
    await waitFor(() => crumbTexts().length === 4, "the crumbs");
    // One tab stop; the arrows walk the controls to the level segment.
    const stop = Array.from(row()!.querySelectorAll<HTMLElement>("button")).filter((b) => b.tabIndex === 0);
    expect(stop).toHaveLength(1);
    stop[0]!.focus();
    const level = byRole("button", /^Page 0/, row()!)!;
    for (let i = 0; i < 5 && document.activeElement !== level; i++) await key("ArrowRight", {}, document.activeElement);
    expect(document.activeElement).toBe(level);
    await key("ArrowDown", {}, level);
    await waitFor(() => menuItem("Page 1") !== null, "the segment's menu");
    expect(menuItem(/All pages/)).not.toBeNull();
  });

  test("Back and Forward; right-click on Back lists this tab's steps, newest first", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    await mount(fake);
    await openFirstPage();
    expect(byRole("button", "Back", row()!)?.hasAttribute("disabled") || byRole("button", "Back", row()!)?.getAttribute("aria-disabled") === "true").toBe(true);
    await click(byRole("button", "Next page"));
    await click(byRole("button", "Next page"));
    await waitFor(() => shown("On page 2"), "page 2");
    await click(byRole("button", "Back", row()!));
    await waitFor(() => shown("On page 1"), "back to page 1");
    await click(byRole("button", "Forward", row()!));
    await waitFor(() => shown("On page 2"), "forward to page 2");
    await act(async () => byRole("button", "Back", row()!)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await waitFor(() => menuItems().length === 3, "this tab's list");
    expect(byText("This tab")).not.toBeNull();
    expect(menuItems().map((el) => el.textContent?.trim())).toEqual(["View · Page 2", "View · Page 1", "View · Page 0"]);
    await click(menuItem("View · Page 0"));
    await waitFor(() => shown("On page 0"), "the step picked");
    await click(byRole("button", "Forward", row()!));
    await waitFor(() => shown("On page 1"), "its steps ahead kept");
  });
});

describe("links and unsaved changes (DOC-21 §3.7)", () => {
  test("a link steps in the same tab; Mod+click and middle-click open another", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    const { history } = await mount(fake, "/walk/lab/pages");
    await waitFor(() => shown("All pages"), "the list");
    await click(byRole("button", "Open page 5"));
    await waitFor(() => shown("On page 5"), "the link in the same tab");
    expect(document.querySelectorAll("[role=tab]")).toHaveLength(1);
    expect(history.location.href).toBe("/walk/lab/pages/5/view");
    await click(byRole("button", "Back", row()!));
    await waitFor(() => shown("All pages"), "back to the list");
    await act(async () => byRole("button", "Open page 5")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })));
    await waitFor(() => document.querySelectorAll("[role=tab]").length === 2, "Mod+click: another tab");
    await waitFor(() => shown("On page 5"), "the new tab active");
    await click(byRole("tab", "Pages"));
    await waitFor(() => shown("All pages"), "the list again");
    await act(async () => byRole("button", "Open page 5")!.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })));
    // The middle button opens or focuses: the tab of page 5 is there already.
    await waitFor(() => shown("On page 5"), "middle-click: the other tab focused");
    expect(document.querySelectorAll("[role=tab]")).toHaveLength(2);
  });

  test("a changed sheet asks before the tab moves, by the row, the keys or the mouse", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    const { history } = await mount(fake);
    await openFirstPage();
    await click(byRole("button", "Next page"));
    await waitFor(() => shown("On page 1"), "page 1");
    await click(byRole("button", "Edit"));
    await waitFor(() => byText("Unchanged") !== null, "the editor");
    // Opened but untouched: nothing to lose.
    await click(byRole("button", "Next page"));
    await waitFor(() => shown("On page 2"), "page 2 without a question");
    await click(byRole("button", "Edit"));
    await waitFor(() => byText("Unchanged") !== null, "the editor again");
    await type(document.querySelector<HTMLInputElement>("input[aria-label=Draft]")!, "half a thought");
    await waitFor(() => byText("Changed") !== null, "the change");
    const discard = () => byRole("button", "Discard changes");

    await click(byRole("button", "Back", row()!));
    await waitFor(() => discard() !== null, "Discard changes? (the row)");
    await click(byRole("button", "Keep editing"));
    await waitFor(() => discard() === null, "kept");
    expect(shown("On page 2")).toBe(true);
    expect(byText("Changed")).not.toBeNull();

    await key("ArrowLeft", { altKey: true }, document.body);
    await waitFor(() => discard() !== null, "Discard changes? (Alt+Left)");
    await click(byRole("button", "Keep editing"));
    await waitFor(() => discard() === null, "kept again");

    // The mouse's back button (memory mode; in a browser the router's blocker holds its Back, check:browser).
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true })));
    await waitFor(() => discard() !== null, "Discard changes? (the mouse)");
    await click(discard());
    await waitFor(() => shown("On page 1"), "left after discarding");
    expect(history.location.href).toBe("/walk/lab/pages/1/view");

    // A saved sheet whose report moves the tab does not ask.
    await click(byRole("button", "Edit"));
    await waitFor(() => byText("Unchanged") !== null, "the editor on page 1");
    await type(document.querySelector<HTMLInputElement>("input[aria-label=Draft]")!, "done");
    await waitFor(() => byText("Changed") !== null, "the change on page 1");
    await click(byRole("button", "Save and go"));
    await waitFor(() => shown("On page 11"), "moved after saving");
    expect(discard()).toBeNull();
  });
});

describe("the missing-profile page (DOC-21 §3.7)", () => {
  test("a link to a missing profile shows its page and keeps its URL; another profile opens the place", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    const { history } = await mount(fake, "/walk/prod-eu/pages/1/view");
    await waitFor(() => byText("This link needs a Walk profile named prod-eu") !== null, "the page");
    expect(byRole("tab", "Page 1")?.getAttribute("aria-selected")).toBe("true");
    expect(byText("Pages › Page 1 › View")).not.toBeNull();
    expect(history.location.href).toBe("/walk/prod-eu/pages/1/view");
    // Nothing connects until a choice.
    expect(fake.server.calls.filter((c) => c.procedure.endsWith(".connect"))).toHaveLength(0);
    expect(byRole("button", "Back", row()!)?.hasAttribute("disabled") || byRole("button", "Back", row()!)?.getAttribute("aria-disabled") === "true").toBe(true);

    await click(byRole("button", "Open with another profile…"));
    await waitFor(() => menuItem("lab") !== null, "the tool's profiles");
    await click(menuItem("lab"));
    await waitFor(() => shown("On page 1"), "the place with lab");
    expect(byText("This link needs a Walk profile named prod-eu")).toBeNull();
    await waitFor(() => history.location.href === "/walk/lab/pages/1/view", "the tab's URL");
  });

  test("Create profile fills the name; once it exists the link opens where it points", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    const { history } = await mount(fake, "/walk/prod-eu/pages/4/view");
    await waitFor(() => byText("This link needs a Walk profile named prod-eu") !== null, "the page");
    await click(byRole("button", "Create profile prod-eu"));
    await waitFor(() => byRole("textbox", "Name") !== null || document.querySelector<HTMLInputElement>("[role=dialog] input") !== null, "the sheet");
    const name = Array.from(document.querySelectorAll<HTMLInputElement>("[role=dialog] input")).find((i) => i.value === "prod-eu");
    expect(name).toBeDefined();
    await type(name!, "prod-eu");
    await click(byRole("button", "Save"));
    await waitFor(() => shown("On page 4"), "the link opened");
    expect(byRole("tab", "Page 4")).not.toBeNull();
    await waitFor(() => history.location.href === "/walk/prod-eu/pages/4/view", "its URL");
  });

  test("closing the link tab drops the page", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile());
    const { history } = await mount(fake, "/walk/prod-eu/pages/1/view");
    await waitFor(() => byText("This link needs a Walk profile named prod-eu") !== null, "the page");
    await key("Delete", {}, byRole("tab", "Page 1"));
    await waitFor(() => byText("This link needs a Walk profile named prod-eu") === null, "the page gone");
    await waitFor(() => history.location.href === "/walk", "the tool's URL");
  });
});
