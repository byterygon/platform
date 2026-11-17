// The pieces behind the screens: the shortcut table of spec §9 for both shells, the error mapping
// of spec §8, cell reading from Arrow buffers, what persists, and the registry install.
import { RpcError } from "@byterygon/ambidex";
import { type ArrowBatch, decodeArrow } from "@byterygon/ambidex/arrow";
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { describe, expect, test } from "vitest";
import { columnFormat } from "@byterygon/data-grid";
import { describeError, formatElapsed } from "@/app/messages";
import { DEFAULT_PERSISTED, DOCUMENT_VERSION, LEGACY_STORAGE_KEY, clearLegacy, fromDocuments, readLegacy, toDocuments } from "@/app/persistence";
import { PRESETS, PRESET_LABELS, applyAppearance, isPreset } from "@/app/presets";
import { ACTIONS, actionFor, bindingsOf, displayBinding, matchesBinding } from "@/app/shortcuts";
import { sampleIpc } from "./support/fake-client";

const press = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, ...init });

describe("shortcuts (spec §9)", () => {
  test("every row of the table has a binding in both shells, and browser-owned keys use Alt+Shift on web", () => {
    for (const a of ACTIONS) {
      expect(bindingsOf(a, "desktop").length).toBeGreaterThan(0);
      expect(bindingsOf(a, "web").length).toBeGreaterThan(0);
    }
    const by = (id: string) => ACTIONS.find((a) => a.id === id)!;
    expect(bindingsOf(by("newTab"), "desktop")).toEqual(["Mod+T"]);
    expect(bindingsOf(by("newTab"), "web")).toEqual(["Alt+Shift+T"]);
    expect(bindingsOf(by("closeTab"), "web")).toEqual(["Alt+Shift+W"]);
    expect(bindingsOf(by("nextTab"), "web")).toEqual(["Alt+Shift+]"]);
    expect(bindingsOf(by("refreshNode"), "web")).toEqual(["Alt+Shift+F5"]);
    expect(bindingsOf(by("palette"), "web")).toEqual(["Mod+K", "Mod+Shift+P"]);
  });

  test("bindings match key events with exact modifiers; Mod is Ctrl or Cmd", () => {
    expect(matchesBinding(press("k", { ctrlKey: true }), "Mod+K", false)).toBe(true);
    expect(matchesBinding(press("k", { metaKey: true }), "Mod+K", true)).toBe(true);
    expect(matchesBinding(press("k", { metaKey: true }), "Mod+K", false)).toBe(false);
    expect(matchesBinding(press("k", { ctrlKey: true, shiftKey: true }), "Mod+K", false)).toBe(false);
    expect(matchesBinding(press("}", { altKey: true, shiftKey: true, code: "BracketRight" } as KeyboardEventInit), "Alt+Shift+]", false)).toBe(true);
    expect(actionFor(press("t", { ctrlKey: true }), "desktop", false)?.id).toBe("newTab");
    expect(actionFor(press("t", { ctrlKey: true }), "web", false)).toBeUndefined();
    expect(actionFor(press("T", { altKey: true, shiftKey: true }), "web", false)?.id).toBe("newTab");
    expect(actionFor(press("c", { ctrlKey: true }), "desktop", false)).toBeUndefined(); // local to the grid
    expect(displayBinding("Mod+Shift+K", true)).toBe("⌘+Shift+K");
    expect(displayBinding("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
  });
});

describe("error mapping (spec §8)", () => {
  const rpc = (code: RpcError["code"], details?: unknown, local = false) => new RpcError(code, "backend text", { details, correlation_id: "corr-9", local });
  test("typed session errors become the spec's messages with their remedies", () => {
    expect(describeError(rpc("FailedPrecondition", { kind: "AuthenticationFailed", user: "app" }), "connect")).toMatchObject({ title: "Authentication failed for user app", remedy: "editConnection", correlationId: "corr-9" });
    expect(describeError(rpc("FailedPrecondition", { kind: "TlsFailed", policy: "pinned-ca" }), "connect")).toMatchObject({ title: "TLS failed", remedy: "editConnection" });
    expect(describeError(rpc("PermissionDenied", { kind: "PermissionDenied", reason: { kind: "AddressNotAllowed", address: "10.1.2.3" } }), "connect")).toMatchObject({ title: "10.1.2.3 is not an allowed address", remedy: "widenAddresses" });
    expect(describeError(rpc("PermissionDenied", { kind: "PermissionDenied", reason: { kind: "Expired", expiredAt: Date.UTC(2026, 0, 1, 14, 2) } }), "connect").title).toMatch(/^Access to this connection expired at/);
    expect(describeError(rpc("PermissionDenied", { kind: "PermissionDenied", reason: { kind: "Revoked" } }), "connect").title).toBe("Access was revoked");
    expect(describeError(rpc("FailedPrecondition", { kind: "ConnectionLost" }), "connect")).toMatchObject({ title: "Connection lost", remedy: "reconnect" });
    expect(describeError(rpc("FailedPrecondition", { kind: "Timeout", host: "db", port: 5432 }), "connect")).toMatchObject({ title: "No answer from db:5432 in 10 s", remedy: "retry" });
    expect(describeError(rpc("FailedPrecondition", { kind: "SecretMissing" }), "connect")).toMatchObject({ remedy: "enterPassword" });
  });
  test("query errors carry SQLSTATE and position; codes without details map too", () => {
    expect(describeError(rpc("InvalidArgument", { kind: "Syntax", message: "syntax error", position: 8, sqlstate: "42601" }), "run")).toMatchObject({ title: "syntax error", position: 8, sqlstate: "42601" });
    expect(describeError(rpc("Cancelled"), "run").title).toBe("Cancelled");
    expect(describeError(rpc("DeadlineExceeded"), "run").title).toBe("Stopped after 1 h (maximum)");
    expect(describeError(rpc("ResourceExhausted"), "run").title).toBe("Too many calls in flight");
    expect(describeError(rpc("PermissionDenied", { kind: "AccessEnded" }), "run").title).toMatch(/outcome on the database is unknown/);
    expect(describeError(rpc("Unavailable"), "run")).toMatchObject({ title: "The audit log is unavailable; nothing ran", remedy: "openDiagnostics" });
    expect(describeError(rpc("Unavailable", undefined, true), "run")).toMatchObject({ title: "Lost the connection to the core", remedy: "reconnect" });
    expect(describeError(rpc("VersionMismatch"))).toMatchObject({ remedy: "reload" });
    expect(describeError(rpc("Unauthenticated")).title).toBe("Your session ended");
    expect(describeError(rpc("Internal")).description).toMatch(/correlation id/);
    expect(describeError(new Error("boom")).description).toBe("boom");
    expect(describeError(rpc("FailedPrecondition", { kind: "SecretStoreUnavailable", reason: "no keychain." }), "approve")).toMatchObject({ remedy: "continueWithoutPassword" });
    expect(describeError(rpc("FailedPrecondition", { kind: "PreviewStale" }), "approve").title).toBe("The preview changed");
  });
  test("elapsed time formats", () => {
    expect(formatElapsed(12)).toBe("12 ms");
    expect(formatElapsed(6100)).toBe("6.1 s");
  });
});

describe("cells from Arrow buffers (spec §6)", () => {
  async function batches(rows: number): Promise<{ fields: Awaited<ReturnType<typeof decodeArrow>["schema"]>; batches: ArrowBatch[] }> {
    const chunks = sampleIpc(rows);
    const stream = decodeArrow({ chunks: async function* () { yield* chunks; }, result: Promise.resolve(null), cancel() {} }, inThreadArrowDecoder());
    const fields = await stream.schema;
    const out: ArrowBatch[] = [];
    for await (const b of stream.batches()) out.push(b);
    return { fields, batches: out };
  }
  test("the grid's column formats read the fake's buffers: Int64, Utf8, NULL, Bool (spec §6)", async () => {
    const { fields, batches: b } = await batches(5);
    expect(fields.map((f) => f.name)).toEqual(["id", "name", "active"]);
    const formats = fields.map(columnFormat);
    expect(formats.map((f) => f.family)).toEqual(["integer", "text", "boolean"]);
    const batch = b[0]!;
    expect(formats[0]!.display(batch.columns[0]!, 4)).toBe("5");
    expect(formats[1]!.display(batch.columns[1]!, 0)).toBe("row 1");
    expect(formats[1]!.display(batch.columns[1]!, 1)).toBeNull();
    expect(formats[2]!.display(batch.columns[2]!, 0)).toBe("true");
    expect(formats[2]!.display(batch.columns[2]!, 1)).toBe("false");
  });
  test("a result without rows still has its schema", async () => {
    const { fields, batches: b } = await batches(0);
    expect(fields.length).toBe(3);
    expect(b.reduce((n, x) => n + x.numRows, 0)).toBe(0);
  });
});

describe("persistence (spec Decision 26): the workspace documents", () => {
  const state = { ...DEFAULT_PERSISTED, tabs: [{ id: "t1", connectionId: "c1", sql: "select 1", maxRows: 100 }], activeTab: "t1", shellSizes: [30, 70], sidebarOpen: false, settings: { ...DEFAULT_PERSISTED.settings, preset: "midnight" as const, density: "comfortable" as const } };

  test("tabs, sizes and settings round-trip through settings.json and tabs.json", () => {
    const docs = toDocuments(state);
    expect(docs.settings["version"]).toBe(DOCUMENT_VERSION);
    expect(docs.tabs["version"]).toBe(DOCUMENT_VERSION);
    // Tab text is in tabs.json only; settings.json holds no SQL.
    expect(JSON.stringify(docs.settings)).not.toContain("select 1");
    expect(fromDocuments(JSON.parse(JSON.stringify(docs.settings)), JSON.parse(JSON.stringify(docs.tabs)))).toEqual(state);
  });

  test("result column widths round-trip per tab; malformed entries are dropped (spec §6)", () => {
    const withWidths = { ...state, tabs: [{ ...state.tabs[0]!, columnWidths: { id: 80, name: 240 } }] };
    const docs = toDocuments(withWidths);
    expect(fromDocuments(JSON.parse(JSON.stringify(docs.settings)), JSON.parse(JSON.stringify(docs.tabs)))).toEqual(withWidths);
    const tabs = JSON.parse(JSON.stringify(docs.tabs));
    tabs.tabs[0].columnWidths = { id: 80, bad: "x", neg: -3, inf: null };
    expect(fromDocuments(JSON.parse(JSON.stringify(docs.settings)), tabs)?.tabs[0]?.columnWidths).toEqual({ id: 80 });
  });

  test("never-written documents are null; malformed fields take their defaults", () => {
    expect(fromDocuments(null, null)).toBeNull();
    expect(fromDocuments({ version: 1, settings: { preset: "nope", density: "huge" }, layout: { shellSizes: [0, 100] } }, { version: 1, tabs: [{ id: 1 }] })).toEqual(DEFAULT_PERSISTED);
    expect(fromDocuments(null, { tabs: [{ id: "a", sql: "x" }], activeTab: "missing" })!.activeTab).toBe("a");
    // A newer layout still opens with what this version understands.
    expect(fromDocuments({ version: 9, settings: { density: "comfortable", future: true } }, "not an object")!.settings.density).toBe("comfortable");
  });

  test("the legacy webview state is read tolerantly and removed on request", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    expect(readLegacy(storage)).toBeNull();
    store.set(LEGACY_STORAGE_KEY, "not json");
    expect(readLegacy(storage)).toBeNull();
    store.set(LEGACY_STORAGE_KEY, JSON.stringify(state));
    expect(readLegacy(storage)).toEqual(state);
    clearLegacy(storage);
    expect(store.has(LEGACY_STORAGE_KEY)).toBe(false);
    expect(readLegacy(undefined)).toBeNull();
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => {}, removeItem: () => { throw new Error("denied"); } };
    expect(readLegacy(throwing)).toBeNull();
    expect(() => clearLegacy(throwing)).not.toThrow();
  });
});

describe("appearance presets", () => {
  test("Aurora is the default and Classic, the earlier look, is a preset of its own", () => {
    expect(PRESETS.slice(0, 2)).toEqual(["default", "classic"]);
    expect(PRESET_LABELS.default).toContain("Aurora");
    expect(isPreset("classic")).toBe(true);
    expect(DEFAULT_PERSISTED.settings.preset).toBe("default");
  });

  test("applying Classic swaps its tokens in and applying the default removes them", () => {
    applyAppearance({ preset: "classic", colorScheme: "light", density: "compact" });
    expect(document.getElementById("dbee-tokens")).not.toBeNull();
    expect(document.documentElement.dataset["preset"]).toBe("classic");
    applyAppearance({ preset: "default", colorScheme: "light", density: "compact" });
    expect(document.getElementById("dbee-tokens")).toBeNull();
  });
});
