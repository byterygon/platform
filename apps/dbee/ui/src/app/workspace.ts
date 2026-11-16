// Tabs and settings in the workspace (DBee spec §5 `app.getWorkspace` / `app.setWorkspace`, Open
// question 11). At start the UI reads both documents once; while it runs, a saver writes what
// changed:
//
// - debounced (typing in a tab is one write after a pause, not one per key: every write is a Write
//   call with two audit entries),
// - one call at a time, always with the revision of the last read or write,
// - only the documents whose text changed,
// - on `Conflict` (another window wrote the workspace since) it stops and says so rather than
//   overwrite what it has not read; reloading takes the other window's state,
// - any other failure is reported and retried with the next change.
//
// Migration: a workspace with neither document, in a webview that still holds the localStorage
// state of PR #57, starts from that state and writes it; the localStorage key is removed only once
// a write succeeded, so no tab is lost when the first write fails.
import { isRpcError } from "@byterygon/ambidex";
import type { DbeeClient } from "./client";
import { type Described, describeError } from "./messages";
import { DEFAULT_PERSISTED, type Persisted, type Storage, clearLegacy, defaultStorage, fromDocuments, readLegacy, toDocuments } from "./persistence";

export type WorkspaceProblem =
  /** `app.getWorkspace` failed: nothing is saved this session, so nothing on disk is overwritten. */
  | { kind: "unreadable"; error: Described }
  /** Another window wrote the workspace; this one stopped saving. */
  | { kind: "conflict" }
  /** A write failed; the next change tries again. */
  | { kind: "failed"; error: Described };

type Listener = (problem: WorkspaceProblem | null) => void;

export interface SaverOptions {
  /** Revision of the last read; `null` disables saving (the workspace could not be read). */
  revision: string | null;
  /** The documents' text as the workspace holds them (`null`: never written). */
  saved?: { settings: string | null; tabs: string | null };
  problem?: WorkspaceProblem | null;
  /** Pause after the last change before writing. */
  delayMs?: number;
  /** Called after each successful write. */
  onSaved?: () => void;
}

export class WorkspaceSaver {
  private revision: string | null;
  private saved: { settings: string | null; tabs: string | null };
  private latest: Persisted | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private problem: WorkspaceProblem | null;
  private readonly listeners = new Set<Listener>();
  private readonly delayMs: number;
  private readonly onSaved: (() => void) | undefined;

  constructor(
    private readonly client: DbeeClient,
    options: SaverOptions,
  ) {
    this.revision = options.revision;
    this.saved = options.saved ?? { settings: null, tabs: null };
    this.problem = options.problem ?? null;
    this.delayMs = options.delayMs ?? 800;
    this.onSaved = options.onSaved;
  }

  /** The current problem, then every change of it. Returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.problem);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Records the state to save; writes after the pause. */
  schedule(state: Persisted): void {
    this.latest = state;
    if (!this.enabled()) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Writes the latest state now (page hide, tests). Resolves when nothing is left to write. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.inFlight) await this.inFlight;
    if (!this.enabled() || this.latest === null) return;
    this.inFlight = this.write(this.latest).finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private enabled(): boolean {
    return this.revision !== null && !this.stopped;
  }

  private async write(state: Persisted): Promise<void> {
    const docs = toDocuments(state);
    const text = { settings: JSON.stringify(docs.settings), tabs: JSON.stringify(docs.tabs) };
    const changedSettings = text.settings !== this.saved.settings;
    const changedTabs = text.tabs !== this.saved.tabs;
    if (!changedSettings && !changedTabs) return;
    try {
      const out = await this.client.app.setWorkspace({
        ...(changedSettings ? { settings: docs.settings } : {}),
        ...(changedTabs ? { tabs: docs.tabs } : {}),
        baseRevision: this.revision!,
      });
      this.revision = out.revision;
      this.saved = {
        settings: changedSettings ? text.settings : this.saved.settings,
        tabs: changedTabs ? text.tabs : this.saved.tabs,
      };
      this.report(null);
      this.onSaved?.();
    } catch (e) {
      if (isRpcError(e) && (e.details as { kind?: string } | undefined)?.kind === "Conflict") {
        this.stopped = true;
        this.report({ kind: "conflict" });
      } else {
        this.report({ kind: "failed", error: describeError(e, "workspace") });
      }
    }
  }

  private report(problem: WorkspaceProblem | null): void {
    if (problem === null && this.problem === null) return;
    this.problem = problem;
    for (const listener of this.listeners) listener(problem);
  }
}

export interface LoadedWorkspace {
  persisted: Persisted;
  saver: WorkspaceSaver;
}

/**
 * Reads the workspace documents (migrating the legacy webview state into an empty workspace) and
 * returns the state to start from with the saver that keeps it.
 */
export async function loadWorkspace(client: DbeeClient, options: { storage?: Storage | undefined; delayMs?: number } = {}): Promise<LoadedWorkspace> {
  const storage = "storage" in options ? options.storage : defaultStorage();
  const delayMs = options.delayMs ?? 800;
  let read;
  try {
    read = await client.app.getWorkspace({});
  } catch (e) {
    // Without a revision nothing is written, so a workspace that exists but could not be read is
    // never replaced by defaults. The legacy state, if any, still gives this session its tabs.
    const saver = new WorkspaceSaver(client, { revision: null, problem: { kind: "unreadable", error: describeError(e) }, delayMs });
    return { persisted: readLegacy(storage) ?? DEFAULT_PERSISTED, saver };
  }
  // What the saver compares with is the documents as this UI writes them, so opening the app
  // writes nothing; an older layout on disk is rewritten with the first change.
  const asWritten = (state: Persisted) => {
    const docs = toDocuments(state);
    return { settings: JSON.stringify(docs.settings), tabs: JSON.stringify(docs.tabs) };
  };
  const stored = fromDocuments(read.settings, read.tabs);
  if (stored !== null) {
    return { persisted: stored, saver: new WorkspaceSaver(client, { revision: read.revision, saved: asWritten(stored), delayMs }) };
  }
  const legacy = readLegacy(storage);
  if (legacy === null) {
    return { persisted: DEFAULT_PERSISTED, saver: new WorkspaceSaver(client, { revision: read.revision, saved: asWritten(DEFAULT_PERSISTED), delayMs }) };
  }
  const saved = { settings: null, tabs: null };
  let migrated = false;
  const saver = new WorkspaceSaver(client, {
    revision: read.revision,
    saved,
    delayMs,
    onSaved: () => {
      if (migrated) return;
      migrated = true;
      clearLegacy(storage);
    },
  });
  saver.schedule(legacy);
  await saver.flush();
  return { persisted: legacy, saver };
}
