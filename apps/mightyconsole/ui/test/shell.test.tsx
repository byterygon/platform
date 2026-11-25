// The shell of Mightyconsole spec §3 driven through a fake server (TSK-79 acceptance): profiles
// added, edited, deleted, exported and imported through the UI; connect, the resource tree and
// tabs; tabs restored after a reload; the palette listing every action with its binding; every
// row of §3.4; the states of §3.5 (no profile, disconnected, loading, error, live, server lost);
// Settings and About; the in-memory fallback; a newer profile read-only; axe in light and dark,
// compact and comfortable.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { ACTIONS, LOCAL_KEYS, displayBinding } from "@/app/shortcuts";
import { StoreProvider, loadPersisted } from "@/app/store";
import { TOOLS } from "@/tools/registry";
import type { ProfileRecord } from "@/profiles/record";
import { MemoryStorage } from "@/profiles/storage";
import { EXPORT_FORMAT } from "@/profiles/transfer";
import { createFakeServices } from "./support/fake-services";
import { act, axeViolations, byRole, byText, cleanup, click, dialogWith, key, render, settle, type, waitFor } from "./support/render";

type Fake = ReturnType<typeof createFakeServices>;

async function mount(fake: Fake, options: { theme?: "light" | "dark"; density?: "compact" | "comfortable" } = {}) {
  const persisted = await loadPersisted(fake.storage, ["echo"]);
  const view = render(
    <ServicesContext.Provider value={fake.services}>
      <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
        <App />
      </StoreProvider>
    </ServicesContext.Provider>,
    { theme: options.theme ?? "light", density: options.density ?? "comfortable" },
  );
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.events"), "the events subscription");
  return view;
}

function profile(patch: Partial<ProfileRecord> = {}): ProfileRecord {
  return { id: `01P${Math.random().toString(36).slice(2, 10).toUpperCase()}`, tool: "echo", version: 1, name: "lab", createdAt: "2026-11-17T10:00:00.000Z", updatedAt: "2026-11-17T10:00:00.000Z", fields: { greeting: "" }, secrets: {}, extras: {}, ...patch };
}

const treeItem = (label: string) => Array.from(document.querySelectorAll<HTMLElement>("[role=treeitem]")).find((el) => el.textContent?.includes(label)) ?? null;

async function doubleClick(el: Element | null) {
  if (!el) throw new Error("nothing to double-click");
  await click(el);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await settle(2);
}

const inputLabelled = (label: string): HTMLInputElement => {
  for (const l of document.querySelectorAll<HTMLLabelElement>("label")) {
    if ((l.textContent ?? "").trim() === label) {
      const control = l.control ?? document.getElementById(l.htmlFor);
      if (control) return control as HTMLInputElement;
    }
  }
  const aria = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (aria) return aria;
  throw new Error(`no field ${label}`);
};

const calls = (fake: Fake, procedure: string) => fake.server.calls.filter((c) => c.procedure === procedure);

/** Connects `name` from the tree and opens its Ticks tab. */
async function openTicks(fake: Fake, name = "lab") {
  await doubleClick(treeItem(name));
  await waitFor(() => treeItem("Ticks") !== null, "the resource tree");
  await doubleClick(treeItem("Ticks"));
  await waitFor(() => byRole("tab", new RegExp(`Ticks · ${name}`)) !== null, "the Ticks tab");
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => cleanup());

describe("profiles through the shell (spec §4)", () => {
  test("no profile, add, connect, edit, duplicate, delete", async () => {
    const fake = createFakeServices();
    await mount(fake);
    // No profile: the tool's EmptyState with Add connection and Import.
    expect(byText("No Echo connections yet")).not.toBeNull();
    expect(byText(/Profiles stay in this browser/)).not.toBeNull();
    // No key hint on or under the button (DOC-21 §3.4): the binding is its aria-keyshortcuts and tooltip.
    const empty = byText("No Echo connections yet")!.closest<HTMLElement>("[data-slot=empty-state]")!;
    const add = byRole("button", /^Add connection$/, empty)!;
    expect(add.getAttribute("aria-keyshortcuts")).toMatch(/^(Control|Meta)\+Alt\+N$/);
    expect(empty.querySelector("kbd")).toBeNull();
    await click(byRole("button", /^Add connection$/));
    await waitFor(() => dialogWith("Add Echo connection") !== null, "the profile sheet");
    // A name is required.
    await click(byRole("button", "Save"));
    expect(byText("A name is required.")).not.toBeNull();
    await type(inputLabelled("Name"), "lab");
    await type(inputLabelled("Greeting"), "hi there");
    await type(inputLabelled("Token"), "s3cret");
    await click(byRole("button", "Save"));
    await waitFor(() => treeItem("lab") !== null, "the profile in the tree");
    const [stored] = await fake.storage.listProfiles();
    // Saved on the server (the fake keeps it in `storage`), the token with it.
    expect(stored).toMatchObject({ tool: "echo", version: 1, name: "lab", fields: { greeting: "hi there" }, secrets: { token: "s3cret" } });
    expect(calls(fake, "profiles.create")[0]!.input).toMatchObject({ owner: { kind: "personal" }, secrets: { token: "s3cret" } });

    // Connect from the tree: the status glyph says connected and the resources appear.
    await doubleClick(treeItem("lab"));
    await waitFor(() => treeItem("Ping") !== null, "the resource tree");
    // Connect names the stored profile; the server opens its token (DOC-25 §3.4.7).
    expect(calls(fake, "echo.connect")[0]!.input).toEqual({ profileId: stored!.id });
    expect(treeItem("lab")?.querySelector("[data-status=connected]")).not.toBeNull();

    // Edit keeps the stored secret unless a new one is typed; the name must stay unique.
    await click(treeItem("lab"));
    await act(async () => {
      treeItem("lab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle(2);
    await click(byRole("menuitem", "Edit"));
    await waitFor(() => dialogWith("Edit lab") !== null, "the edit sheet");
    expect(inputLabelled("Token").placeholder).toBe("Set (type to replace)");
    // The form never holds the stored value: the field is empty.
    expect(inputLabelled("Token").value).toBe("");
    // Test connection: the draft, nothing typed, based on the stored profile (its token fills in).
    await click(byRole("button", /Test connection/));
    await waitFor(() => byText("The connection works") !== null, "the test");
    expect(calls(fake, "echo.test")[0]!.input).toEqual({ draft: { name: "lab", fields: { greeting: "hi there" }, extras: {}, secrets: [] }, basedOn: stored!.id });
    await type(inputLabelled("Greeting"), "changed");
    await click(byRole("button", "Save"));
    await waitFor(() => dialogWith("Edit lab") === null, "the sheet to close");
    expect((await fake.storage.listProfiles())[0]).toMatchObject({ fields: { greeting: "changed" }, secrets: { token: "s3cret" } });
    // Only what was typed goes up: no secret in the edit.
    expect(calls(fake, "profiles.update").at(-1)!.input).toMatchObject({ secrets: {} });

    // Duplicate: a new id, the name must differ.
    await click(treeItem("lab"));
    await act(async () => {
      treeItem("lab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle(2);
    await click(byRole("menuitem", "Duplicate"));
    await waitFor(() => dialogWith("Duplicate lab") !== null, "the duplicate sheet");
    await type(inputLabelled("Name"), "lab");
    await click(byRole("button", "Save"));
    expect(byText("Another Echo profile is called lab.")).not.toBeNull();
    await type(inputLabelled("Name"), "lab 2");
    await click(byRole("button", "Save"));
    await waitFor(() => treeItem("lab 2") !== null, "the duplicate");
    const all = await fake.storage.listProfiles();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((p) => p.id)).size).toBe(2);
    // A duplicate keeps the secrets (same credentials, another name or target).
    expect(all.find((p) => p.name === "lab 2")?.secrets).toEqual({ token: "s3cret" });

    // Delete asks first.
    await click(treeItem("lab 2"));
    await click(treeItem("lab 2"));
    await act(async () => {
      treeItem("lab 2")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle(2);
    await click(byRole("menuitem", /Delete/));
    await waitFor(() => dialogWith("Delete lab 2?") !== null, "the delete confirmation");
    await click(byRole("button", "Delete"));
    await waitFor(() => treeItem("lab 2") === null, "the deletion");
    expect(await fake.storage.listProfiles()).toHaveLength(1);
  });

  test("export holds no secret, import with a choice per conflict", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile({ name: "lab", secrets: { token: "s3cret" } }));
    await mount(fake);
    await waitFor(() => treeItem("lab") !== null, "the stored profile");
    const blobs: Blob[] = [];
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:x";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await key("k", { ctrlKey: true });
    await waitFor(() => byRole("option", /Export profiles/) !== null, "the palette");
    await click(byRole("option", /Export profiles/));
    await waitFor(() => dialogWith("Export 1 profile") !== null, "the export dialog");
    // Secrets are write-only on the server: no export can hold them.
    expect(document.querySelector("[role=dialog] [role=checkbox]")).toBeNull();
    await click(byRole("button", "Export"));
    await waitFor(() => blobs.length === 1, "the file");
    const without = JSON.parse(await blobs[0]!.text());
    expect(without).toMatchObject({ format: EXPORT_FORMAT, includesSecrets: false });
    expect(without.profiles[0].secrets).toEqual({});

    create.mockRestore();

    // Import the first file back plus a new profile: the existing one is a conflict.
    without.profiles.push({ ...without.profiles[0], id: "01NEW", name: "fresh" });
    await click(byRole("button", "Import profiles"));
    await waitFor(() => dialogWith("Nothing is written until you press Import") !== null, "the import dialog");
    const input = document.querySelector<HTMLInputElement>("[role=dialog] input[type=file]")!;
    const file = new File([JSON.stringify(without)], "mightyconsole-profiles-2026-11-17.json", { type: "application/json" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => byText("New") !== null, "the plan");
    expect(byRole("radiogroup", /lab: lab already exists/)).not.toBeNull();
    // Skip the conflict: only "fresh" is written.
    await click(Array.from(document.querySelectorAll("[role=radio]")).find((r) => r.closest("label")?.textContent?.includes("Skip")) ?? null);
    await click(byRole("button", /^Import 1$/));
    await waitFor(() => treeItem("fresh") !== null, "the imported profile");
    const stored = await fake.storage.listProfiles();
    expect(stored.map((p) => p.name).sort()).toEqual(["fresh", "lab"]);
    expect(stored.find((p) => p.name === "lab")?.secrets).toEqual({ token: "s3cret" });
  });

  test("a stored secret is removed from the sheet, and is set or not, never shown", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile({ name: "lab", secrets: { token: "s3cret" } }));
    await mount(fake);
    await waitFor(() => treeItem("lab") !== null, "the stored profile");
    await click(treeItem("lab"));
    await act(async () => {
      treeItem("lab")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle(2);
    await click(byRole("menuitem", "Edit"));
    await waitFor(() => dialogWith("Stored secrets") !== null, "the edit sheet");
    expect(document.body.textContent).not.toContain("s3cret");
    await click(byRole("button", "Remove"));
    expect(byText("removed on save")).not.toBeNull();
    expect(inputLabelled("Token").placeholder).toBe("Not set");
    await click(byRole("button", "Save"));
    await waitFor(() => dialogWith("Stored secrets") === null, "the sheet to close");
    expect(calls(fake, "secrets.remove")[0]!.input).toMatchObject({ field: "token" });
    expect((await fake.storage.listProfiles())[0]!.secrets).toEqual({});
  });

  test("the browser's own profiles move to the server after a backup (DOC-25 §3.4.9)", async () => {
    const browser = new MemoryStorage();
    await browser.putProfile(profile({ id: "01OLD", name: "old lab", secrets: { token: "s3cret" } }));
    const fake = createFakeServices(new MemoryStorage(), { browserProfiles: browser });
    await mount(fake);
    // Not listed until moved; the page says so and offers the step.
    await waitFor(() => byText("1 profile is kept in this browser") !== null, "the prompt");
    expect(treeItem("old lab")).toBeNull();
    await click(byRole("button", "Move to the server"));
    await waitFor(() => dialogWith("Move my profiles to the server") !== null, "the move dialog");
    expect(byText("token")).not.toBeNull();
    const move = byRole("button", "Move 1 profile") as HTMLButtonElement;
    expect(move.disabled).toBe(true);
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:x";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await click(byRole("button", "Save the backup"));
    const backup = JSON.parse(await blobs[0]!.text());
    expect(backup).toMatchObject({ includesSecrets: true });
    expect(backup.profiles[0].secrets).toEqual({ token: "s3cret" });
    expect(move.disabled).toBe(false);
    await click(move);
    await waitFor(() => treeItem("old lab") !== null, "the moved profile, from the server");
    expect(await browser.listProfiles()).toEqual([]);
    const [onServer] = await fake.storage.listProfiles();
    expect(onServer).toMatchObject({ name: "old lab", secrets: { token: "s3cret" } });
  });

  test("a newer profile is read-only; the in-memory fallback warns", async () => {
    const fake = createFakeServices(new MemoryStorage("the browser refused IndexedDB (test)"));
    await fake.storage.putProfile(profile({ name: "future", version: 9 }));
    await mount(fake);
    await waitFor(() => treeItem("future") !== null, "the profile");
    expect(treeItem("future")?.textContent).toContain("newer version");
    await waitFor(() => byText("Profiles are not saved in this browser") !== null, "the warning toast");
    expect(byText(/refused IndexedDB \(test\)/)).not.toBeNull();
    await click(treeItem("future"));
    await act(async () => {
      treeItem("future")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await settle(2);
    await click(byRole("menuitem", "Edit"));
    await waitFor(() => dialogWith("Made by a newer version") !== null, "the read-only sheet");
    expect((byRole("button", "Save") as HTMLButtonElement).disabled).toBe(true);
    expect(inputLabelled("Name").disabled).toBe(true);
  });
});

describe("connections, tabs and live views (spec §2.2, §3.2, §3.5)", () => {
  test("a live view follows the keys; tabs come back after a reload and connect on focus", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile({ name: "lab" }));
    const view = await mount(fake);
    await waitFor(() => treeItem("lab") !== null, "the profile");
    await openTicks(fake);
    // Mod+Enter starts the stream; the ticks arrive and the Live badge shows.
    await key("Enter", { ctrlKey: true }, document.body);
    await waitFor(() => byText("tick 2") !== null, "the ticks");
    expect(byRole("status", /^Live/)).not.toBeNull();
    expect(byText(/^Live/, document.querySelector("[aria-label=Status]")!)).not.toBeNull();
    // Alt+Shift+P pauses, again resumes; Alt+Shift+K clears; Shift+Escape stops.
    await key("P", { altKey: true, shiftKey: true }, document.body);
    expect(byRole("status", /^Paused/)).not.toBeNull();
    await key("P", { altKey: true, shiftKey: true }, document.body);
    expect(byRole("status", /^Live/)).not.toBeNull();
    await key("K", { altKey: true, shiftKey: true }, document.body);
    expect(byText("tick 2")).toBeNull();
    await key("Escape", { shiftKey: true }, document.body);
    await waitFor(() => byRole("status", /Ended: stopped/) !== null, "the stream to end");
    expect(byRole("button", /Restart/)).not.toBeNull();
    // Closing a tab with a running stream asks first.
    await key("Enter", { ctrlKey: true }, document.body);
    await waitFor(() => byRole("status", /^Live/) !== null, "a running stream");
    await key("W", { altKey: true, shiftKey: true }, document.body);
    await waitFor(() => dialogWith("Close Ticks · lab?") !== null, "the close confirmation");
    await click(byRole("button", "Cancel"));
    await settle(2);

    // Reload: the tab comes back disconnected and connects when it is focused.
    await settle(4);
    view.unmount();
    const connects = calls(fake, "echo.connect").length;
    await mount(fake);
    await waitFor(() => byRole("tab", /Ticks · lab/) !== null, "the restored tab");
    await waitFor(() => calls(fake, "echo.connect").length === connects + 1, "connect on focus");
    await waitFor(() => byRole("button", /^Start$/) !== null, "the tab's screen");
    // Live streams never restart by themselves.
    expect(calls(fake, "echo.ticks")).toHaveLength(2);
  });

  test("a failed connect shows the error with its remedy; disconnect dims the tab", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile({ name: "bad", secrets: { token: "wrong" } }));
    await fake.storage.putProfile(profile({ name: "lab" }));
    await mount(fake);
    await waitFor(() => treeItem("bad") !== null, "the profiles");
    await doubleClick(treeItem("bad"));
    await waitFor(() => treeItem("bad")?.querySelector("[data-status=failed]") != null, "the failure");
    expect(treeItem("bad")?.textContent).toContain("failed");

    await openTicks(fake);
    // Disconnect from the palette: the tab shows "Connect to lab".
    await key("k", { ctrlKey: true });
    await waitFor(() => byRole("option", /Disconnect Echo: lab/) !== null, "the palette");
    await click(byRole("option", /Disconnect Echo: lab/));
    await waitFor(() => byText("Connect to lab") !== null, "the disconnected state");
    expect(calls(fake, "echo.disconnect")).toHaveLength(1);
    await click(byRole("button", "Connect"));
    await waitFor(() => byText("Connect to lab") === null, "connected again");
  });

  test("losing the server shows the overlay; when it returns the profiles connect again", async () => {
    const fake = createFakeServices();
    await fake.storage.putProfile(profile({ name: "lab" }));
    await mount(fake);
    await waitFor(() => treeItem("lab") !== null, "the profile");
    await openTicks(fake);
    expect(calls(fake, "echo.connect")).toHaveLength(1);
    await act(async () => fake.drop());
    await waitFor(() => byText("Lost the connection to mightyconsole-server, retrying…") !== null, "the overlay");
    expect(byRole("alertdialog")).not.toBeNull();
    await act(async () => fake.restore());
    await click(byRole("button", "Retry now"));
    await waitFor(() => byText("Lost the connection to mightyconsole-server, retrying…") === null, "the overlay to go");
    await waitFor(() => calls(fake, "echo.connect").length === 2, "connect again");
    await waitFor(() => fake.server.handles.size === 1, "a new handle");
    expect(calls(fake, "app.events").length).toBe(2);
  });
});

describe("keyboard, palette, dialogs (spec §3.3, §3.4, §3.6)", () => {
  test("the palette lists every action with its binding; the shortcuts dialog every row", async () => {
    const fake = createFakeServices();
    await mount(fake);
    await key("k", { ctrlKey: true });
    await waitFor(() => byRole("dialog", /Type a command/) !== null || document.querySelector("[role=listbox]") !== null, "the palette");
    const text = document.querySelector("[role=listbox]")?.textContent ?? "";
    for (const a of ACTIONS) {
      if (a.id === "palette") continue;
      // toolN switches to the Nth tool of the registry, or says there is none.
      const tool = a.id.startsWith("tool") ? TOOLS[Number(a.id.slice(4)) - 1] : undefined;
      const label = tool ? `Switch to ${tool.label}` : a.id.startsWith("tool") ? `${a.label} (no tool)` : a.label;
      expect(text, a.id).toContain(label);
      if (a.keys[0]) expect(text, a.id).toContain(displayBinding(a.keys[0]));
    }
    await key("Escape");
    await key("/", { ctrlKey: true });
    await waitFor(() => dialogWith("Keyboard shortcuts") !== null, "the shortcuts dialog");
    const rows = Array.from(dialogWith("Keyboard shortcuts")!.querySelectorAll("tbody tr"));
    expect(rows.length).toBe(ACTIONS.filter((a) => a.keys.length > 0).length + LOCAL_KEYS.length);
    for (const label of ["Command palette", "Switch to tool 6", "Add connection", "Stop the tab's stream", "Pause or resume a live view", "Next pane", "Toggle sidebar", "Settings"]) {
      expect(rows.some((r) => r.textContent?.includes(label)), label).toBe(true);
    }
  });

  test("Settings and About; density and theme apply", async () => {
    const fake = createFakeServices();
    await mount(fake);
    await key(",", { ctrlKey: true });
    await waitFor(() => dialogWith("Changes apply at once") !== null, "Settings");
    for (const tab of ["Appearance", "Live views", "Profiles", "Advanced"]) expect(byRole("tab", tab)).not.toBeNull();
    await click(byRole("button", "Compact"));
    await waitFor(() => document.documentElement.dataset["density"] === "compact", "compact density");
    await click(byRole("button", "Dark"));
    await waitFor(() => document.documentElement.dataset["theme"] === "dark", "dark theme");
    await key("Escape");
    await waitFor(() => dialogWith("Changes apply at once") === null, "Settings to close");
    await click(byRole("button", "About Mightyconsole"));
    await waitFor(() => dialogWith("About Mightyconsole") !== null, "About");
    const about = dialogWith("About Mightyconsole")!.textContent ?? "";
    expect(about).toContain("https://localhost:7443");
    expect(about).toContain("AB:CD");
    expect(about).toContain("AGPL-3.0-only");
    expect(about).toContain("No errors this session.");
  });

  test("Alt+Shift+1 switches tools; F6 moves between panes", async () => {
    const fake = createFakeServices();
    await mount(fake);
    // The navigation's order: Messaging (NATS), Infrastructure (Docker), Workflows and agents
    // (Temporal, LangGraph), then Other (Echo).
    await key("!", { altKey: true, shiftKey: true, code: "Digit1" } as KeyboardEventInit, document.body);
    expect(byRole("button", "NATS")?.getAttribute("aria-current")).toBe("page");
    await key("@", { altKey: true, shiftKey: true, code: "Digit2" } as KeyboardEventInit, document.body);
    expect(byRole("button", "Docker")?.getAttribute("aria-current")).toBe("page");
    await key("#", { altKey: true, shiftKey: true, code: "Digit3" } as KeyboardEventInit, document.body);
    expect(byRole("button", "Temporal")?.getAttribute("aria-current")).toBe("page");
    await key("%", { altKey: true, shiftKey: true, code: "Digit5" } as KeyboardEventInit, document.body);
    expect(byRole("button", "Echo")?.getAttribute("aria-current")).toBe("page");
    await key("F6", {}, document.body);
    expect(document.activeElement?.closest("[data-pane]")).not.toBeNull();
  });

  test("the rail draws each tool's own mark, or its Fluent icon when it has none (DOC-21 OQ 45 (e))", async () => {
    const fake = createFakeServices();
    await mount(fake);
    expect(byRole("button", "NATS")?.querySelector("svg[data-icon]")?.getAttribute("data-icon")).toBe("mark-natsdotio");
    expect(byRole("button", "Temporal")?.querySelector("svg[data-icon]")?.getAttribute("data-icon")).toBe("mark-temporal");
    expect(byRole("button", "LangGraph")?.querySelector("svg[data-icon]")?.getAttribute("data-icon")).toBe("mark-langgraph");
    expect(byRole("button", "Echo")?.querySelector("svg[data-icon]")?.getAttribute("data-icon")).toBe("braces");
    // Docker keeps Fluent's box-multiple until Docker approves its logo (OQ 45 (e)).
    expect(byRole("button", "Docker")?.querySelector("svg[data-icon]")?.getAttribute("data-icon")).toBe("box-multiple");
  });

  describe("the tool navigation (DOC-21 §3.1)", () => {
    const setWidth = async (px: number) => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
      await act(async () => void window.dispatchEvent(new Event("resize")));
    };
    afterEach(() => setWidth(1024));
    const nav = () => document.querySelector<HTMLElement>("nav[aria-label='Tools']")!;
    const groups = () => [...nav().querySelectorAll("[role=group]")].map((g) => g.getAttribute("aria-label"));

    test("a drawer by category from 1280 px, the rail below; the toggle switches and is remembered", async () => {
      await setWidth(1440);
      const fake = createFakeServices();
      await mount(fake);
      expect(nav().hasAttribute("data-collapsed")).toBe(false);
      expect(groups()).toEqual(["Messaging", "Infrastructure", "Workflows and agents", "Other"]);
      expect(nav().textContent).toContain("Temporal");
      await click(byRole("button", "Collapse the tool list")!);
      expect(nav().hasAttribute("data-collapsed")).toBe(true);
      await setWidth(1100);
      expect(nav().hasAttribute("data-collapsed")).toBe(true);
      await click(byRole("button", "Expand the tool list")!);
      expect(nav().hasAttribute("data-collapsed")).toBe(false);
      expect(nav().hasAttribute("data-overlay")).toBe(false);
    });

    test("below 1024 px an opened drawer floats over the panes and closes on a choice", async () => {
      await setWidth(900);
      const fake = createFakeServices();
      await mount(fake);
      expect(nav().hasAttribute("data-collapsed")).toBe(true);
      await click(byRole("button", "Expand the tool list")!);
      expect(nav().hasAttribute("data-overlay")).toBe(true);
      await click(byRole("button", "LangGraph")!);
      expect(nav().hasAttribute("data-collapsed")).toBe(true);
      expect(byRole("button", "LangGraph")?.getAttribute("aria-current")).toBe("page");
    });

    test("a pinned tool comes first and takes Alt+Shift+1; a folded category hides its tools", async () => {
      await setWidth(1440);
      const fake = createFakeServices();
      await mount(fake);
      const echo = byRole("button", "Echo")!;
      await act(async () => void echo.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
      await waitFor(() => byRole("menuitem", "Pin to the top") !== null, "the pin item");
      await click(byRole("menuitem", "Pin to the top"));
      expect(groups()[0]).toBe("Pinned");
      await key("!", { altKey: true, shiftKey: true, code: "Digit1" } as KeyboardEventInit, document.body);
      expect(byRole("button", "Echo")?.getAttribute("aria-current")).toBe("page");
      await click(byRole("button", "Workflows and agents")!);
      expect(byRole("button", "Temporal")).toBeNull();
    });

    test("one tab stop; arrows and type-ahead move between tools", async () => {
      await setWidth(1440);
      const fake = createFakeServices();
      await mount(fake);
      const items = [...nav().querySelectorAll<HTMLElement>("[data-nav-item]")];
      expect(items.filter((b) => b.tabIndex === 0)).toHaveLength(1);
      items[0]!.focus();
      await key("ArrowDown", {}, items[0]!);
      expect(document.activeElement).toBe(items[1]);
      await key("e", {}, items[1]!);
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Echo");
    });
  });
});

describe("accessibility (spec §18: axe on the shell)", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const density of ["comfortable", "compact"] as const) {
      test(`the shell with a profile and a tab, ${theme}, ${density}`, async () => {
        const fake = createFakeServices();
        await fake.storage.putProfile(profile({ name: "lab" }));
        await mount(fake, { theme, density });
        await waitFor(() => treeItem("lab") !== null, "the profile");
        await openTicks(fake);
        expect(await axeViolations()).toEqual([]);
      });
    }
  }

  test("the empty shell", async () => {
    const fake = createFakeServices();
    await mount(fake);
    expect(await axeViolations()).toEqual([]);
  });
});
