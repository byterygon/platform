// Export and import of profiles (Mightyconsole spec §4.3).
//
// Export writes `mightyconsole-profiles-<date>.json` with one profile, the selected ones or all;
// secrets are left out unless the user ticks "Include secrets". Import reads such a file,
// validates `format`, migrates each record, and lists every profile with what will happen; when
// the id or the name already exists the user chooses Replace, Keep both (a new id, the name
// suffixed " (2)") or Skip. A record of an unknown tool, or newer than the app knows, is listed
// and skipped with the reason. Nothing is written until the user presses Import.
import type { ProfileSchema } from "@/tools/types";
import { migrateRecord } from "./migrate";
import { type ProfileRecord, freeName, isRecord, ulid } from "./record";

export const EXPORT_FORMAT = "mightyconsole.profiles";
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  exportedAt: string;
  app: string;
  includesSecrets: boolean;
  profiles: ProfileRecord[];
}

export function exportFile(records: readonly ProfileRecord[], options: { includeSecrets: boolean; app: string; now?: Date }): ExportFile {
  const now = options.now ?? new Date();
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    app: options.app,
    includesSecrets: options.includeSecrets,
    profiles: records.map((r) => ({ ...structuredClone(r), secrets: options.includeSecrets ? structuredClone(r.secrets) : {} })),
  };
}

export function exportFileName(now: Date = new Date()): string {
  return `mightyconsole-profiles-${now.toISOString().slice(0, 10)}.json`;
}

export type ImportChoice = "replace" | "keepBoth" | "skip";

export interface ImportRow {
  /** The record as it will be written (migrated), or as read when skipped. */
  record: ProfileRecord;
  /** The stored profile with the same id, or else the same name, in the same tool. */
  conflict: ProfileRecord | null;
  /** Why the row cannot be imported, when it cannot. */
  skipReason: string | null;
  choice: ImportChoice;
}

export interface ImportPlan {
  includesSecrets: boolean;
  rows: ImportRow[];
}

/** Why a file is not a profiles export. */
export class ImportError extends Error {}

/** Parses and plans an import against the stored profiles. Writes nothing. */
export function planImport(text: string, stored: readonly ProfileRecord[], schemas: (tool: string) => ProfileSchema | undefined): ImportPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportError("The file is not JSON.");
  }
  const file = parsed as Partial<ExportFile> | null;
  if (typeof file !== "object" || file === null || file.format !== EXPORT_FORMAT) throw new ImportError("The file is not a Mightyconsole profiles export.");
  if (typeof file.formatVersion !== "number" || file.formatVersion > EXPORT_FORMAT_VERSION) throw new ImportError("The file was written by a newer Mightyconsole.");
  if (!Array.isArray(file.profiles)) throw new ImportError("The file has no profiles.");
  const rows: ImportRow[] = file.profiles.map((raw: unknown): ImportRow => {
    if (!isRecord(raw)) {
      const name = typeof (raw as { name?: unknown })?.name === "string" ? (raw as { name: string }).name : "(unnamed)";
      return skipped(placeholder(name), "not a valid profile record");
    }
    const schema = schemas(raw.tool);
    if (!schema) return skipped(raw, `the tool "${raw.tool}" is not in this version`);
    if (raw.version > schema.version) return skipped(raw, `made by a newer Mightyconsole (profile version ${raw.version})`);
    let record: ProfileRecord;
    try {
      record = migrateRecord(raw, schema);
    } catch (e) {
      return skipped(raw, `cannot be migrated: ${e instanceof Error ? e.message : String(e)}`);
    }
    const conflict = stored.find((s) => s.id === record.id) ?? stored.find((s) => s.tool === record.tool && s.name === record.name) ?? null;
    return { record, conflict, skipReason: null, choice: conflict ? "keepBoth" : "replace" };
  });
  return { includesSecrets: file.includesSecrets === true, rows };
}

function skipped(record: ProfileRecord, reason: string): ImportRow {
  return { record, conflict: null, skipReason: reason, choice: "skip" };
}

function placeholder(name: string): ProfileRecord {
  return { id: "", tool: "", version: 0, name, createdAt: "", updatedAt: "", fields: {}, secrets: {}, extras: {} };
}

/**
 * The records to write for a plan: Replace keeps the stored profile's id (so its tabs still
 * point at it) and its secrets when the file has none; Keep both gets a new id and a free name.
 */
export function applyImport(plan: ImportPlan, stored: readonly ProfileRecord[], now: Date = new Date()): { writes: ProfileRecord[]; deletes: string[] } {
  const writes: ProfileRecord[] = [];
  const deletes: string[] = [];
  const names = new Map<string, Set<string>>();
  const namesOf = (tool: string) => {
    let set = names.get(tool);
    if (!set) {
      set = new Set(stored.filter((s) => s.tool === tool).map((s) => s.name));
      names.set(tool, set);
    }
    return set;
  };
  for (const row of plan.rows) {
    if (row.skipReason !== null || row.choice === "skip") continue;
    const record = structuredClone(row.record);
    if (row.conflict === null) {
      namesOf(record.tool).add(record.name);
      writes.push(record);
    } else if (row.choice === "replace") {
      const target = row.conflict;
      if (target.id !== record.id) deletes.push(target.id);
      writes.push({
        ...record,
        id: target.id,
        secrets: Object.keys(record.secrets).length > 0 ? record.secrets : target.secrets,
        createdAt: target.createdAt,
        updatedAt: now.toISOString(),
      });
    } else {
      const taken = namesOf(record.tool);
      const name = freeName(record.name, taken);
      taken.add(name);
      writes.push({ ...record, id: ulid(now.getTime()), name, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    }
  }
  return { writes, deletes: deletes.filter((id) => !writes.some((w) => w.id === id)) };
}
