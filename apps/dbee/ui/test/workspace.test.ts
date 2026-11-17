// Tabs and settings in the workspace (spec §5 app.getWorkspace / app.setWorkspace, Open question
// 11): the start-up read, the one-time migration of the webview state of PR #57, and the saver
// (debounced, changed documents only, the revision of the last write, stop on conflict).
import { RpcError } from "@byterygon/ambidex";
import { describe, expect, test } from "vitest";
import type { DbeeClient } from "@/app/client";
import { DEFAULT_PERSISTED, LEGACY_STORAGE_KEY, type Persisted, SETTINGS_VERSION, fromDocuments, readLegacy, toDocuments } from "@/app/persistence";
import { type WorkspaceProblem, WorkspaceSaver, loadWorkspace } from "@/app/workspace";
import { createFakeServices } from "./support/fake-client";

function memory(initial?: Persisted) {
  const store = new Map<string, string>();
  if (initial) store.set(LEGACY_STORAGE_KEY, JSON.stringify(initial));
  return { store, storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
}

const tab = (id: string, sql: string) => ({ id, connectionId: "conn-1", sql, maxRows: null });
const withTabs = (...tabs: ReturnType<typeof tab>[]): Persisted => ({ ...DEFAULT_PERSISTED, tabs, activeTab: tabs[0]?.id ?? null });
const writes = (fake: ReturnType<typeof createFakeServices>) => fake.state.calls.filter((c) => c.procedure === "app.setWorkspace");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("loadWorkspace", () => {
  test("a fresh workspace and no legacy state: defaults, and opening writes nothing", async () => {
    const fake = createFakeServices();
    const { persisted, saver } = await loadWorkspace(fake.client, { storage: memory().storage, delayMs: 0 });
    expect(persisted).toEqual(DEFAULT_PERSISTED);
    saver.schedule(persisted);
    await saver.flush();
    expect(writes(fake)).toHaveLength(0);
  });

  test("the workspace's documents win; the legacy key is left alone", async () => {
    const saved = withTabs(tab("w1", "select 'workspace'"));
    const docs = toDocuments(saved);
    const fake = createFakeServices({ workspace: { settings: docs.settings, tabs: docs.tabs, writes: 3 } });
    const { store, storage } = memory(withTabs(tab("l1", "select 'legacy'")));
    const { persisted } = await loadWorkspace(fake.client, { storage, delayMs: 0 });
    expect(persisted).toEqual(saved);
    expect(store.has(LEGACY_STORAGE_KEY)).toBe(true);
    expect(writes(fake)).toHaveLength(0);
  });

  test("an empty workspace takes the legacy tabs, writes them, then removes the key", async () => {
    const legacy = withTabs(tab("l1", "select 'legacy'"), tab("l2", ""));
    const fake = createFakeServices();
    const { store, storage } = memory(legacy);
    const { persisted, saver } = await loadWorkspace(fake.client, { storage, delayMs: 0 });
    expect(persisted).toEqual(legacy);
    expect(writes(fake)).toHaveLength(1);
    expect(fake.state.workspace.tabs).toEqual(toDocuments(legacy).tabs);
    expect(fake.state.workspace.settings).toEqual(toDocuments(legacy).settings);
    expect(store.has(LEGACY_STORAGE_KEY)).toBe(false);
    // The store's first schedule of the same state writes nothing again.
    saver.schedule(persisted);
    await saver.flush();
    expect(writes(fake)).toHaveLength(1);
  });

  test("a failed migration write keeps the legacy key and the tabs; the next change writes them", async () => {
    const legacy = withTabs(tab("l1", "select 'legacy'"));
    const fake = createFakeServices({ failNext: { "app.setWorkspace": new RpcError("Unavailable", "audit log unavailable", { correlation_id: "corr-audit" }) } });
    const { store, storage } = memory(legacy);
    const { persisted, saver } = await loadWorkspace(fake.client, { storage, delayMs: 0 });
    expect(persisted).toEqual(legacy);
    expect(store.has(LEGACY_STORAGE_KEY)).toBe(true);
    const problems: (WorkspaceProblem | null)[] = [];
    saver.subscribe((p) => problems.push(p));
    expect(problems[0]?.kind).toBe("failed");
    saver.schedule({ ...persisted, sidebarOpen: false });
    await saver.flush();
    expect(fake.state.workspace.tabs).toEqual(toDocuments(legacy).tabs);
    expect(store.has(LEGACY_STORAGE_KEY)).toBe(false);
    expect(problems.at(-1)).toBeNull();
  });

  test("an unreadable workspace saves nothing this session and says so", async () => {
    const fake = createFakeServices({ failNext: { "app.getWorkspace": new RpcError("PermissionDenied", "denied", { correlation_id: "corr-read" }) } });
    const legacy = withTabs(tab("l1", "select 'legacy'"));
    const { store, storage } = memory(legacy);
    const { persisted, saver } = await loadWorkspace(fake.client, { storage, delayMs: 0 });
    expect(persisted).toEqual(legacy);
    let problem: WorkspaceProblem | null = null;
    saver.subscribe((p) => (problem = p));
    expect(problem).toMatchObject({ kind: "unreadable" });
    saver.schedule({ ...persisted, tabs: [] });
    await saver.flush();
    expect(writes(fake)).toHaveLength(0);
    expect(store.has(LEGACY_STORAGE_KEY)).toBe(true);
  });
});

describe("WorkspaceSaver", () => {
  test("a burst of edits is one write after the pause, with only the document that changed", async () => {
    const fake = createFakeServices();
    const { persisted, saver } = await loadWorkspace(fake.client, { storage: memory().storage, delayMs: 30 });
    const tabs = [tab("t1", "")];
    for (const sql of ["s", "se", "sel", "select 1"]) saver.schedule({ ...persisted, tabs: [{ ...tabs[0]!, sql }], activeTab: "t1" });
    expect(writes(fake)).toHaveLength(0);
    await sleep(80);
    expect(writes(fake)).toHaveLength(1);
    const input = writes(fake)[0]!.input as { settings?: unknown; tabs?: { tabs: { sql: string }[] }; baseRevision: string };
    expect(input.settings).toBeUndefined();
    expect(input.tabs!.tabs[0]!.sql).toBe("select 1");
    expect(input.baseRevision).toBe("rev-0");

    // The next write carries the revision of the last one.
    saver.schedule({ ...persisted, tabs: [{ ...tabs[0]!, sql: "select 1" }], activeTab: "t1", settings: { ...persisted.settings, density: "compact" } });
    await saver.flush();
    const second = writes(fake)[1]!.input as { settings?: unknown; tabs?: unknown; baseRevision: string };
    expect(second.tabs).toBeUndefined();
    expect(second.settings).toBeDefined();
    expect(second.baseRevision).toBe("rev-1");
    saver.dispose();
  });

  test("a conflict stops saving instead of overwriting the other window's state", async () => {
    const fake = createFakeServices();
    const { persisted, saver } = await loadWorkspace(fake.client, { storage: memory().storage, delayMs: 0 });
    // Another window writes first.
    fake.state.workspace = { ...fake.state.workspace, tabs: toDocuments(withTabs(tab("other", "select 'other'"))).tabs, writes: 1 };
    const problems: (WorkspaceProblem | null)[] = [];
    saver.subscribe((p) => problems.push(p));
    saver.schedule(withTabs(tab("mine", "select 'mine'")));
    await saver.flush();
    expect(problems.at(-1)).toEqual({ kind: "conflict" });
    expect(JSON.stringify(fake.state.workspace.tabs)).toContain("other");
    saver.schedule({ ...persisted, sidebarOpen: false });
    await saver.flush();
    expect(writes(fake)).toHaveLength(1);
  });

  test("one call at a time: a change during a write is written after it", async () => {
    const fake = createFakeServices();
    let release!: () => void;
    let first = true;
    const client: DbeeClient = {
      ...fake.client,
      app: {
        ...fake.client.app,
        setWorkspace: async (input, options) => {
          if (first) {
            first = false;
            await new Promise<void>((r) => (release = r));
          }
          return fake.client.app.setWorkspace(input, options);
        },
      },
    };
    const saver = new WorkspaceSaver(client, { revision: "rev-0", delayMs: 0 });
    saver.schedule(withTabs(tab("t1", "one")));
    const flushing = saver.flush();
    await sleep(0);
    saver.schedule(withTabs(tab("t1", "two")));
    const second = saver.flush();
    release();
    await Promise.all([flushing, second]);
    expect(writes(fake).map((c) => (c.input as { baseRevision: string }).baseRevision)).toEqual(["rev-0", "rev-1"]);
    expect(JSON.stringify(fake.state.workspace.tabs)).toContain("two");
  });
});

describe("default density (TSK-64, spec Open question 17)", () => {
  const settingsDoc = (version: number | undefined, density: string) => ({ ...(version === undefined ? {} : { version }), settings: { ...DEFAULT_PERSISTED.settings, density }, layout: {} });

  test("a new workspace starts comfortable and is written as settings version 2", () => {
    expect(DEFAULT_PERSISTED.settings.density).toBe("comfortable");
    expect(SETTINGS_VERSION).toBe(2);
    expect(toDocuments(DEFAULT_PERSISTED).settings["version"]).toBe(2);
  });

  test("compact from an older settings document moves to comfortable once", () => {
    expect(fromDocuments(settingsDoc(1, "compact"), null)?.settings.density).toBe("comfortable");
    expect(fromDocuments(settingsDoc(undefined, "compact"), null)?.settings.density).toBe("comfortable");
  });

  test("compact chosen under version 2 stays compact, and survives a write and a read", () => {
    const loaded = fromDocuments(settingsDoc(2, "compact"), null)!;
    expect(loaded.settings.density).toBe("compact");
    const docs = toDocuments(loaded);
    expect(fromDocuments(docs.settings, docs.tabs)?.settings.density).toBe("compact");
  });

  test("the webview-storage state of PR #57 predates version 2: compact becomes comfortable", () => {
    const { storage } = memory({ ...DEFAULT_PERSISTED, settings: { ...DEFAULT_PERSISTED.settings, density: "compact" } });
    expect(readLegacy(storage)?.settings.density).toBe("comfortable");
  });
});
