// The screens of spec §3 driven through the fake core: first run to first rows (flow 3.11.1),
// the approval dialog from the preview, errors of §8 with their remedies, the destructive
// confirmation, cancel, export, shortcuts of §9 in both shells, the palette, persistence, and
// axe on every screen in light and dark, compact and comfortable.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { DEFAULT_PERSISTED, LEGACY_STORAGE_KEY, type Persisted, fromDocuments, toDocuments } from "@/app/persistence";
import { StoreProvider } from "@/app/store";
import { WorkspaceSaver, loadWorkspace } from "@/app/workspace";
import { createFakeServices } from "./support/fake-client";
import { act, axeViolations, blur, byRole, byText, cleanup, click, dialogWith, key, render, settle, type, waitFor } from "./support/render";

type Fake = ReturnType<typeof createFakeServices>;

function mount(fake: Fake, options: { persisted?: Partial<Persisted>; saver?: WorkspaceSaver; shell?: "desktop" | "web"; theme?: "light" | "dark"; density?: "compact" | "comfortable" } = {}) {
  const persisted: Persisted = { ...DEFAULT_PERSISTED, ...options.persisted };
  // The fake core's workspace at its current revision, written shortly after each change.
  const saver = options.saver ?? new WorkspaceSaver(fake.client, { revision: `rev-${fake.state.workspace.writes}`, delayMs: 10 });
  return render(
    <ServicesContext.Provider value={fake}>
      <StoreProvider persisted={persisted} saver={saver}>
        <App shell={options.shell ?? "desktop"} />
      </StoreProvider>
    </ServicesContext.Provider>,
    { theme: options.theme ?? "light", density: options.density ?? "compact" },
  );
}

const connection = () => ({
  id: "conn-1",
  name: "Local",
  description: null,
  colour: null,
  driver: "com.byterygon.dbee.postgres",
  host: "127.0.0.1",
  port: 5432,
  database: "app",
  user: "app",
  tls: "deployment-ca" as const,
  hasSecret: true,
  allowCancelConnection: true,
  status: "disconnected" as const,
  grant: { id: "g-1", state: "active" as const, expiresAt: null, createdAt: 0 },
});

const input = (label: RegExp | string): HTMLInputElement => {
  for (const l of document.querySelectorAll<HTMLLabelElement>("label")) {
    const text = (l.textContent ?? "").trim();
    if (typeof label === "string" ? text === label : label.test(text)) {
      const control = l.control ?? document.getElementById(l.htmlFor);
      if (control) return control as HTMLInputElement;
    }
  }
  throw new Error(`no field ${label}`);
};

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("first run to first rows (spec §3.11 flow 1)", () => {
  test("empty state, add connection, approval dialog from the preview, connect, tree, run, rows", async () => {
    const fake = createFakeServices();
    const { container } = mount(fake);
    await waitFor(() => byText("No connections yet") !== null, "empty state");
    expect(byText(/never sends anything over the network/)).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);

    await click(byRole("button", "Add connection"));
    await waitFor(() => document.querySelector("[role=dialog]") !== null, "the sheet");
    expect(byRole("button", "Test connection")).toBeNull();
    await type(input("Name"), "Local");
    await type(input(/^Host/), "127.0.0.1");
    await type(input("Database"), "app");
    await type(input("User"), "app");
    await type(input("Password"), "pw-secret");
    expect(await axeViolations(document.body)).toEqual([]);
    await click(byRole("button", "Continue to approval"));
    await waitFor(() => document.querySelector("[role=alertdialog]") !== null, "the approval dialog");
    const dialog = document.querySelector("[role=alertdialog]")!;
    expect(dialog.textContent).toContain("sha256:driver");
    expect(dialog.textContent).toContain("127.0.0.1:5432");
    expect(dialog.textContent).toContain("127.0.0.1/32");
    expect(dialog.textContent).toContain("deployment CA bundle");
    expect(dialog.textContent).toContain("A password will be stored in the OS keychain");
    expect(dialog.textContent).toContain("human:local:tester");
    expect(dialog.textContent).not.toContain("pw-secret");
    expect(await axeViolations(document.body)).toEqual([]);
    await click(byRole("button", "Approve and save"));
    await waitFor(() => fake.state.calls.some((c) => c.procedure === "connections.create"), "create");
    const create = fake.state.calls.find((c) => c.procedure === "connections.create")!.input as { previewDigest: string; secret: { password: string } | null };
    expect(create.previewDigest).toMatch(/^sha256:preview/);
    expect(create.secret).toEqual({ password: "pw-secret" });
    await waitFor(() => document.querySelector("[role=tree]") !== null, "the tree");
    expect(document.querySelector("[role=tree]")!.textContent).toContain("Local");
    expect(document.querySelector("[role=tree]")!.textContent).toContain("disconnected");

    // Connect (Enter on the node) opens a browser session and loads the schemas; system schemas
    // sit under a collapsed System node.
    const tree = document.querySelector<HTMLElement>("[role=tree]")!;
    tree.focus();
    await key("ArrowDown", {}, tree);
    await key("Enter", {}, tree);
    await waitFor(() => fake.state.calls.some((c) => c.procedure === "schema.schemas"), "schemas");
    await waitFor(() => tree.textContent!.includes("public"), "public schema");
    expect(tree.textContent).toContain("System");
    expect(tree.textContent).not.toContain("pg_catalog");
    expect(tree.textContent).toContain("connected");

    // A tab for the connection, a statement, rows as Arrow.
    await click(byRole("button", "New query tab"));
    await waitFor(() => document.querySelector("[role=tab]") !== null, "a tab");
    const editor = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='SQL editor']")!;
    await type(editor, "select id, name, active from orders");
    await click(byRole("button", /^Run/));
    await waitFor(() => fake.state.calls.some((c) => c.procedure === "query.execute"), "execute");
    await waitFor(() => document.querySelector("[role=grid][aria-label='Result rows']") !== null, "the grid");
    await waitFor(() => (byRole("status")?.textContent ?? "").includes("5 rows"), "the status line");
    const grid = document.querySelector("[role=grid][aria-label='Result rows']")!;
    // The data grid (spec §6) renders the cells in view; jsdom has no layout, so the first rows and columns.
    await waitFor(() => (grid.textContent ?? "").includes("row 1"), "the first rows");
    expect(grid.querySelectorAll(".bdg-null").length).toBeGreaterThan(0);
    expect(grid.getAttribute("aria-rowcount")).toBe("6");
    expect([...grid.querySelectorAll("[role=columnheader] .bdg-name")].map((h) => h.textContent)).toEqual(["id", "name", "active"]);
    expect(fake.state.calls.filter((c) => c.procedure === "sessions.open").map((c) => (c.input as { purpose: string }).purpose)).toEqual(["browser", "editor"]);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("errors and states (spec §8)", () => {
  test("a syntax error shows the message, SQLSTATE, position and a correlation id", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    mount(fake, { persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "select syntax error", maxRows: null }], activeTab: "t1" } });
    await waitFor(() => byRole("button", /^Run/) !== null, "run");
    await click(byRole("button", /^Run/));
    await waitFor(() => document.querySelector("[role=alert]") !== null, "the alert");
    const alert = document.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain('syntax error at or near "error"');
    expect(alert.textContent).toContain("42601");
    expect(alert.textContent).toContain("position 8");
    expect(alert.textContent).toContain("corr-syntax");
  });

  test("a connection failure names the remedy and the remedy opens the connection form", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    fake.state.failNext["sessions.open"] = new RpcError("FailedPrecondition", "auth", { details: { kind: "AuthenticationFailed", user: "app" }, correlation_id: "corr-auth" });
    mount(fake, { persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "select 1", maxRows: null }], activeTab: "t1" } });
    await waitFor(() => byRole("button", /^Run/) !== null, "run");
    await click(byRole("button", /^Run/));
    await waitFor(() => byText("Authentication failed for user app") !== null, "the message");
    await click(byRole("button", "Edit connection"));
    await waitFor(() => dialogWith("Edit Local") !== null, "the sheet");
  });

  test("a statement without rows shows its outcome line; a Destructive statement is confirmed first", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    mount(fake, { persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "update orders set x = 1", maxRows: null }], activeTab: "t1" } });
    await waitFor(() => byRole("button", /^Run/) !== null, "run");
    await click(byRole("button", /^Run/));
    await waitFor(() => (byRole("status")?.textContent ?? "").includes("UPDATE 42 rows in 12 ms"), "the outcome line");

    const editor = document.querySelector<HTMLTextAreaElement>("textarea[aria-label='SQL editor']")!;
    await type(editor, "drop table orders");
    await click(byRole("button", /^Run/));
    await waitFor(() => document.querySelector("[role=alertdialog]") !== null, "the confirmation");
    expect(document.querySelector("[role=alertdialog]")!.textContent).toContain("This statement can destroy data: DROP TABLE");
    expect(fake.state.calls.filter((c) => c.procedure === "query.execute").length).toBe(1);
    await click(byRole("button", "Run it"));
    await waitFor(() => fake.state.calls.filter((c) => c.procedure === "query.execute").length === 2, "the second run");
  });

  test("Cancel (Shift+Escape) ends a running statement and keeps the rows", async () => {
    const fake = createFakeServices({ connections: [connection()], rows: 3 });
    mount(fake, { persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "select pg_sleep(30)", maxRows: null }], activeTab: "t1" } });
    await waitFor(() => byRole("button", /^Run/) !== null, "run");
    await click(byRole("button", /^Run/));
    await waitFor(() => byRole("button", /Cancel/) !== null, "the cancel button");
    // One Cancel, in the tab's command bar, where Run was (spec Open question 17).
    const cancels = [...document.querySelectorAll("button")].filter((b) => /^Cancel/.test(b.textContent?.trim() ?? ""));
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.closest("[role=toolbar]")?.getAttribute("aria-label")).toBe("Query");
    expect([...document.querySelectorAll("[role=toolbar][aria-label=Query] button")].some((b) => b.textContent?.trim().startsWith("Run"))).toBe(false);
    await key("Escape", { shiftKey: true }, document.body);
    await waitFor(() => (byRole("status")?.textContent ?? "").startsWith("Cancelled after"), "cancelled");
  });

  test("the row limit travels with the run and a truncated result says so", async () => {
    const fake = createFakeServices({ connections: [connection()], rows: 50 });
    mount(fake, { persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "select 1", maxRows: 10 }], activeTab: "t1" } });
    await waitFor(() => byRole("button", /^Run/) !== null, "run");
    await click(byRole("button", /^Run/));
    await waitFor(() => fake.state.calls.some((c) => c.procedure === "query.execute"), "execute");
    expect((fake.state.calls.find((c) => c.procedure === "query.execute")!.input as { maxRows: number }).maxRows).toBe(10);
    await waitFor(() => (byRole("status")?.textContent ?? "").includes("first 10 rows (limit)"), "truncated");
  });
});

describe("export (spec §3.8)", () => {
  test("on desktop the core chooses the file and writes it; the dialog states the result", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    mount(fake, { persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "select 1", maxRows: null }], activeTab: "t1" } });
    await waitFor(() => byRole("button", "Export") !== null, "export");
    await key("S", { ctrlKey: true, shiftKey: true }, document.body);
    await waitFor(() => document.querySelector("[role=dialog]")?.textContent?.includes("Export result") ?? false, "the dialog");
    await click(byRole("button", "Choose file…"));
    await waitFor(() => fake.state.calls.some((c) => c.procedure === "export.run"), "export.run");
    const run = fake.state.calls.find((c) => c.procedure === "export.run")!.input as { destination: { kind: string; handle: string }; format: string; options: { header: boolean } };
    expect(run.destination).toEqual({ kind: "file", handle: "handle-1" });
    expect(run.format).toBe("csv");
    expect(run.options.header).toBe(true);
    await waitFor(() => byText(/Exported 2 rows/) !== null, "the summary");
  });
});

describe("keyboard and palette (spec §9)", () => {
  test("Ctrl+Alt+N opens the form; on web Alt+Shift+T opens a tab and Ctrl+T is left to the browser", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    mount(fake, { shell: "web" });
    await waitFor(() => document.querySelector("[role=tree]") !== null, "tree");
    await key("n", { ctrlKey: true, altKey: true }, document.body);
    await waitFor(() => document.querySelector("[role=dialog]")?.textContent?.includes("New connection") ?? false, "the sheet");
    await key("Escape", {}, document.activeElement);
    await waitFor(() => document.querySelector("[role=dialog]") === null, "closed");
    await key("t", { ctrlKey: true }, document.body);
    await settle();
    expect(document.querySelector("[role=tab]")).toBeNull();
    await key("T", { altKey: true, shiftKey: true }, document.body);
    await waitFor(() => document.querySelector("[role=tab]") !== null, "a tab");
    await key("W", { altKey: true, shiftKey: true }, document.body);
    await waitFor(() => document.querySelector("[role=tab]") === null, "closed tab");
  });

  test("the palette lists every action with the shell's binding, and F6 cycles the panes", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    mount(fake, { shell: "desktop", persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "", maxRows: null }], activeTab: "t1" } });
    await waitFor(() => document.querySelector("[role=tree]") !== null, "tree");
    await key("k", { ctrlKey: true }, document.body);
    await waitFor(() => document.querySelector("[role=listbox]") !== null, "the palette");
    const text = document.querySelector("[role=listbox]")!.textContent!;
    for (const label of ["New query tab", "Close tab", "Run selection or statement under cursor", "Cancel running statement", "Export result", "Settings", "Keyboard shortcuts", "Add connection"]) expect(text).toContain(label);
    expect(text).toContain("Ctrl+T");
    expect(text).toContain("Ctrl+Alt+N");
    await key("Escape", {}, document.activeElement);
    await waitFor(() => document.querySelector("[role=listbox]") === null, "closed");
    await key("F6", {}, document.body);
    await settle();
    const panes: string[] = [];
    for (let i = 0; i < 3; i++) {
      panes.push(document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane") ?? "none");
      await key("F6", {}, document.body);
      await settle();
    }
    expect(new Set(panes).size).toBeGreaterThan(1);
    await key("/", { ctrlKey: true }, document.body);
    await waitFor(() => document.querySelector("[role=dialog]")?.textContent?.includes("Keyboard shortcuts") ?? false, "shortcuts dialog");
    expect(document.querySelector("[role=dialog]")!.textContent).toContain("F6");
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe("Fluent 2 shell (TSK-64)", () => {
  test("tabs sit in the title area; the sidebar, the editor and the results are separate layers", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    mount(fake, { persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "select 1", maxRows: null }], activeTab: "t1" } });
    await waitFor(() => document.querySelector("[role=tab]") !== null, "a tab");
    const titleArea = document.querySelector("header[aria-label='Title area']")!;
    expect(titleArea.querySelector("[role=tablist][aria-label='Query tabs']")).not.toBeNull();
    expect(titleArea.querySelector("button[aria-label='Settings']")).not.toBeNull();
    expect(titleArea.querySelector("button[aria-label='Keyboard shortcuts']")).not.toBeNull();
    expect(titleArea.textContent).toContain("Search commands");
    for (const label of ["Editor", "Results"]) expect(document.querySelector(`section[aria-label='${label}']`)?.className).toContain("bg-layer");
    expect(document.querySelector("section[aria-label='Editor'] [role=toolbar][aria-label=Query]")).not.toBeNull();
    expect(document.querySelector("[data-slot=sidebar]")?.className).toContain("rounded-lg");
  });
});

describe("persistence and settings (spec §3.9, §14)", () => {
  test("tabs, the active tab and settings go to the workspace and come back after a restart", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    const first = mount(fake);
    await waitFor(() => document.querySelector("[role=tree]") !== null, "tree");
    await click(byRole("button", "New query tab"));
    await waitFor(() => document.querySelector("textarea[aria-label='SQL editor']") !== null, "editor");
    await type(document.querySelector<HTMLTextAreaElement>("textarea[aria-label='SQL editor']")!, "select 42");
    // Comfortable is the default (spec Open question 17); the status bar button switches to compact.
    expect(document.documentElement.dataset["density"]).toBe("comfortable");
    await click(byRole("button", "Comfortable"));
    await settle();
    expect(document.documentElement.dataset["density"]).toBe("compact");
    await waitFor(() => fromDocuments(fake.state.workspace.settings, fake.state.workspace.tabs)?.settings.density === "compact", "settings.json");
    const saved = fromDocuments(fake.state.workspace.settings, fake.state.workspace.tabs)!;
    expect(saved.tabs[0]?.sql).toBe("select 42");
    expect(saved.activeTab).toBe(saved.tabs[0]?.id);
    // Nothing goes to the webview's storage any more.
    expect(localStorage.length).toBe(0);
    first.unmount();

    // A restart: a new UI on the same core reads the workspace before its first render.
    const again = createFakeServices({ connections: [connection()], workspace: fake.state.workspace });
    const loaded = await loadWorkspace(again.client, { storage: localStorage, delayMs: 10 });
    mount(again, { persisted: loaded.persisted, saver: loaded.saver });
    await waitFor(() => document.querySelector("textarea[aria-label='SQL editor']") !== null, "editor again");
    expect(document.querySelector<HTMLTextAreaElement>("textarea[aria-label='SQL editor']")!.value).toBe("select 42");
    // The compact chosen before the restart is kept (settings version 2).
    expect(document.documentElement.dataset["density"]).toBe("compact");
  });

  test("tabs kept in the webview by an earlier version move to the workspace on the first start", async () => {
    const legacy: Persisted = { ...DEFAULT_PERSISTED, tabs: [{ id: "old-1", connectionId: "conn-1", sql: "select 'kept'", maxRows: 50 }], activeTab: "old-1" };
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
    const fake = createFakeServices({ connections: [connection()] });
    const loaded = await loadWorkspace(fake.client, { storage: localStorage, delayMs: 10 });
    expect(fake.state.workspace.tabs).toEqual(toDocuments(legacy).tabs);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    mount(fake, { persisted: loaded.persisted, saver: loaded.saver });
    await waitFor(() => document.querySelector("textarea[aria-label='SQL editor']") !== null, "editor");
    expect(document.querySelector<HTMLTextAreaElement>("textarea[aria-label='SQL editor']")!.value).toBe("select 'kept'");
  });

  test("a write from another window stops this one from saving and offers Reload", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    mount(fake, { persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "select 1", maxRows: null }], activeTab: "t1" } });
    await waitFor(() => fake.state.workspace.writes === 1, "the first write");
    fake.state.workspace = { ...fake.state.workspace, writes: 2 };
    await type(document.querySelector<HTMLTextAreaElement>("textarea[aria-label='SQL editor']")!, "select 2");
    await waitFor(() => byText("The workspace changed in another window") !== null, "the conflict toast");
    expect(byRole("button", "Reload")).not.toBeNull();
    expect(JSON.stringify(fake.state.workspace.tabs)).not.toContain("select 2");
  });

  test("an unreadable workspace is reported and nothing is written", async () => {
    const fake = createFakeServices({ connections: [connection()], failNext: { "app.getWorkspace": new RpcError("Internal", "internal error", { correlation_id: "corr-ws" }) } });
    const loaded = await loadWorkspace(fake.client, { storage: localStorage, delayMs: 10 });
    mount(fake, { persisted: loaded.persisted, saver: loaded.saver });
    await waitFor(() => byText("Could not read the workspace") !== null, "the toast");
    await click(byRole("button", "New query tab"));
    await settle(6);
    expect(fake.state.calls.some((c) => c.procedure === "app.setWorkspace")).toBe(false);
  });

  test("Settings and About show the paths and the schema hash; no telemetry toggle exists", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    mount(fake);
    await waitFor(() => document.querySelector("[role=tree]") !== null, "tree");
    await key(",", { ctrlKey: true }, document.body);
    await waitFor(() => document.querySelector("[role=dialog]")?.textContent?.includes("Settings") ?? false, "settings");
    expect(document.querySelector("[role=dialog]")!.textContent).not.toMatch(/telemetry/i);
    await click(byRole("tab", "Advanced"));
    await waitFor(() => document.querySelector("[role=dialog]")!.textContent!.includes("/tmp/dbee/workspace"), "paths");
    expect(await axeViolations(document.body)).toEqual([]);
    await click(byRole("button", "Open diagnostics"));
    await waitFor(() => document.querySelector("[role=dialog]")?.textContent?.includes("About DBee") ?? false, "about");
    expect(document.querySelector("[role=dialog]")!.textContent).toContain("Standalone desktop");
    expect(document.querySelector("[role=dialog]")!.textContent).toContain("AGPL-3.0-only");
  });
});

describe("grant expiry (spec §3.11 flow 4)", () => {
  test("a GrantExpiring event raises a sticky toast with Renew access; GrantExpired marks the node", async () => {
    const fake = createFakeServices({ connections: [connection()] });
    mount(fake);
    await waitFor(() => fake.state.events.length > 0, "the subscription");
    await act(async () => fake.emit({ kind: "GrantExpiring", connectionId: "conn-1", expiresAt: Date.now() + 14 * 60_000 }));
    await waitFor(() => byText(/Access to Local expires in 14 min/) !== null, "the toast");
    expect(byRole("button", "Renew access")).not.toBeNull();
    // The core's list reports the grant's state; the event tells the UI to look again.
    fake.state.connections = fake.state.connections.map((c) => ({ ...c, status: "expired", grant: { ...c.grant, state: "expired" } }));
    await act(async () => fake.emit({ kind: "GrantExpired", connectionId: "conn-1", expiredAt: Date.now() }));
    await waitFor(() => document.querySelector("[role=tree]")?.textContent?.includes("expired") ?? false, "expired node");
    await click(byRole("button", "Renew access"));
    await waitFor(() => dialogWith("Renew access to Local") !== null, "the form for renewal");
  });
});

describe("renew access (spec §4)", () => {
  test("Renew access always goes through prepare and approval for the same target, and the new grant replaces the old", async () => {
    const soon = Date.now() + 10 * 60_000;
    const fake = createFakeServices({ connections: [{ ...connection(), grant: { id: "g-1", state: "active" as const, expiresAt: soon, createdAt: 0 } }] });
    mount(fake);
    await waitFor(() => document.querySelector("[role=tree]") !== null, "tree");
    // The badge is in the tree within 15 minutes of expiry.
    await waitFor(() => document.querySelector("[role=tree] [data-expiry-phase=soon]") !== null, "the expiry badge");
    await act(async () => fake.emit({ kind: "GrantExpiring", connectionId: "conn-1", expiresAt: soon }));
    await waitFor(() => byRole("button", "Renew access") !== null, "the toast action");
    await click(byRole("button", "Renew access"));
    await waitFor(() => dialogWith("Renew access to Local") !== null, "the renewal form");
    // Nothing was changed in the form: an edit would save in place, a renewal must not.
    await click(byRole("button", "Continue to approval"));
    await waitFor(() => byRole("button", "Approve and save") !== null, "the approval dialog");
    expect(fake.state.calls.some((c) => c.procedure === "connections.update")).toBe(false);
    expect(fake.state.calls.filter((c) => c.procedure === "connections.prepare").length).toBe(1);
    await click(byRole("button", "Approve and save"));
    await waitFor(() => fake.state.calls.some((c) => c.procedure === "connections.create"), "create");
    const create = fake.state.calls.find((c) => c.procedure === "connections.create")!.input as { replaces: string | null };
    expect(create.replaces).toBe("conn-1");
  });
});

describe("accessibility (spec §10)", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const density of ["compact", "comfortable"] as const) {
      test(`the shell with a connection, a tab and rows passes axe in ${theme}, ${density}`, async () => {
        const fake = createFakeServices({ connections: [connection()] });
        const { container } = mount(fake, { theme, density, persisted: { tabs: [{ id: "t1", connectionId: "conn-1", sql: "select 1", maxRows: null }], activeTab: "t1" } });
        await waitFor(() => byRole("button", /^Run/) !== null, "run");
        await click(byRole("button", /^Run/));
        await waitFor(() => document.querySelector("[role=grid][aria-label='Result rows'] [role=gridcell]") !== null, "rows");
        expect(await axeViolations(container)).toEqual([]);
      });
    }
  }
});

// Keeps the imports used when a test above is skipped.
void blur;
