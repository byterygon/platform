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
  /** Every browser record has moved and the browser's profile stores are empty. */
  cleared: boolean;
}

/** The browser records still to move: not moved yet. */
export function toMove(records: readonly ProfileRecord[]): ProfileRecord[] {
  return records.filter((r) => r.importedAs === undefined);
}

export async function moveToServer(client: MightyClient, storage: AppStorage, records: readonly ProfileRecord[], shared: ReadonlySet<string> = new Set(), onMoved?: (moved: Moved) => void): Promise<MoveResult> {
  const moved: Moved[] = [];
  for (const record of toMove(records)) {
    let to: string;
    try {
      to = (await importRecord(client, record, shared.has(record.id))).id;
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
