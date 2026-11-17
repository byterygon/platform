// Profile migrations (Mightyconsole spec §4.4). On start the app migrates every stored record
// whose version is lower than its tool's, one step at a time, in one transaction per record,
// after copying it to `profilesBackup`. A record with a higher version (made by a newer
// Mightyconsole) is left as it is and shown read-only. The backups are deleted at the next start
// that loads every profile without error.
import type { ProfileSchema } from "@/tools/types";
import type { ProfileRecord } from "./record";
import type { AppStorage } from "./storage";

export type RecordState =
  /** At the tool's version. */
  | { kind: "current" }
  /** Made by a newer Mightyconsole: read-only. */
  | { kind: "newer"; version: number }
  /** Its tool is not in this app. */
  | { kind: "unknownTool" }
  /** A migration step failed; the stored record and its backup are unchanged. */
  | { kind: "failed"; message: string };

/** Runs the record through the schema's steps from its version to the schema's. */
export function migrateRecord(record: ProfileRecord, schema: ProfileSchema): ProfileRecord {
  let current = structuredClone(record);
  for (let v = current.version; v < schema.version; v++) {
    const step = schema.migrations[v];
    if (!step) throw new Error(`no migration from version ${v}`);
    current = { ...step(current), version: v + 1 };
  }
  return current;
}

export interface LoadedProfiles {
  records: ProfileRecord[];
  states: Record<string, RecordState>;
  /** How many records were migrated now. */
  migrated: number;
}

/**
 * Loads every profile, migrating older ones (each with its backup), and deletes the backups of a
 * previous start when this one loaded everything without error.
 */
export async function loadProfiles(storage: AppStorage, schemas: (tool: string) => ProfileSchema | undefined): Promise<LoadedProfiles> {
  const stored = await storage.listProfiles();
  const records: ProfileRecord[] = [];
  const states: Record<string, RecordState> = {};
  const migratedNow = new Set<string>();
  let failures = 0;
  const backupsBefore = await storage.listBackups();
  for (const record of stored) {
    const schema = schemas(record.tool);
    if (!schema) {
      states[record.id] = { kind: "unknownTool" };
      records.push(record);
      continue;
    }
    if (record.version > schema.version) {
      states[record.id] = { kind: "newer", version: record.version };
      records.push(record);
      continue;
    }
    if (record.version === schema.version) {
      states[record.id] = { kind: "current" };
      records.push(record);
      continue;
    }
    try {
      const next = migrateRecord(record, schema);
      await storage.putMigrated(next, record);
      states[record.id] = { kind: "current" };
      records.push(next);
      migratedNow.add(record.id);
    } catch (e) {
      failures++;
      states[record.id] = { kind: "failed", message: e instanceof Error ? e.message : String(e) };
      records.push(record);
    }
  }
  // Backups written by an earlier start are kept until a start that loads everything cleanly.
  if (failures === 0) {
    for (const backup of backupsBefore) if (!migratedNow.has(backup.id)) await storage.deleteBackup(backup.id);
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  return { records, states, migrated: migratedNow.size };
}
