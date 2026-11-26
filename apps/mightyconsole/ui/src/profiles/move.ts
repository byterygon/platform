// "Move my profiles to the server" (DOC-25 §3.4.9, TSK-139): the browser's own records, migrated
// to their tools' versions, become profiles on the server. One record at a time: import it
// (`profiles.import`, idempotent by its id), check that the server holds every secret sent, and
// only then remove its secrets from IndexedDB, keeping `{ importedAs }`. A failure stops there and
// leaves the remaining records untouched; running the step again resumes. Once every record has
// moved, the `profiles` and `profilesBackup` stores are cleared.
import type { MightyClient } from "@/app/client";
import type { ProfileRecord } from "./record";
import { importRecord } from "./server";
import type { AppStorage } from "./storage";

export interface Moved {
  /** Browser id → the server profile it became. */
  from: string;
  to: string;
}

export interface MoveResult {
  moved: Moved[];
  /** The record that did not move, and why; the ones after it were not tried. */
  failed?: { record: ProfileRecord; error: unknown };
  /** The person stopped the run before it reached the end (DOC-25 §3.4.9: starting again resumes). */
  stopped?: boolean;
  /** Every browser record has moved and the browser's profile stores are empty. */
  cleared: boolean;
}

/** What the person chose in the dialog beyond which records are shared. */
export interface MoveOptions {
  /** Only these browser ids move; the others stay in the browser untouched. All when left out. */
  only?: ReadonlySet<string>;
  /** The name a record moves under, by browser id (a name that clashes is renamed first). */
  names?: Readonly<Record<string, string>>;
  /** Stops before the next record once aborted; the one in flight finishes with its secrets checked. */
  signal?: AbortSignal;
  /** Called before each record starts: its place in the run. */
  onProgress?(step: { index: number; total: number; record: ProfileRecord }): void;
}

const key = (tool: string, name: string) => `${tool}\u0000${name.trim().toLowerCase()}`;

/**
 * The name each record moves under: its own, or, when the server already has a profile of that tool
 * and name (or an earlier record of this move takes it), `<name>-mine`, then `-mine-2`, and so on.
 * The server refuses duplicates, so the clash is settled here and shown to the person.
 */
export function moveNames(records: readonly Pick<ProfileRecord, "id" | "tool" | "name">[], existing: readonly Pick<ProfileRecord, "tool" | "name">[]): Record<string, { name: string; renamed: boolean }> {
  const taken = new Set(existing.map((p) => key(p.tool, p.name)));
  const out: Record<string, { name: string; renamed: boolean }> = {};
  for (const r of records) {
    let name = r.name;
    for (let n = 1; taken.has(key(r.tool, name)); n++) name = n === 1 ? `${r.name}-mine` : `${r.name}-mine-${n}`;
    taken.add(key(r.tool, name));
    out[r.id] = { name, renamed: name !== r.name };
  }
  return out;
}

/** The browser records still to move: not moved yet. */
export function toMove(records: readonly ProfileRecord[]): ProfileRecord[] {
  return records.filter((r) => r.importedAs === undefined);
}

export async function moveToServer(client: MightyClient, storage: AppStorage, records: readonly ProfileRecord[], shared: ReadonlySet<string> = new Set(), onMoved?: (moved: Moved) => void, options: MoveOptions = {}): Promise<MoveResult> {
  const moved: Moved[] = [];
  const todo = toMove(records).filter((r) => options.only === undefined || options.only.has(r.id));
  for (const [index, record] of todo.entries()) {
    if (options.signal?.aborted) return { moved, stopped: true, cleared: false };
    options.onProgress?.({ index, total: todo.length, record });
    let to: string;
    try {
      const name = options.names?.[record.id];
      to = (await importRecord(client, name === undefined || name === record.name ? record : { ...record, name }, shared.has(record.id))).id;
    } catch (error) {
      return { moved, failed: { record, error }, cleared: false };
    }
    // The server holds every secret: the browser keeps none, only where the record went.
    await storage.putProfile({ ...record, secrets: {}, importedAs: to });
    const m = { from: record.id, to };
    moved.push(m);
    onMoved?.(m);
  }
  const left = await storage.listProfiles();
  if (toMove(left).length > 0) return { moved, cleared: false };
  for (const r of left) await storage.deleteProfile(r.id);
  for (const b of await storage.listBackups()) await storage.deleteBackup(b.id);
  storage.announce();
  return { moved, cleared: true };
}
