// Profiles (Mightyconsole spec §4): IndexedDB through idb (on fake-indexeddb), migration from a
// test version 0 with the backup kept, a newer version left alone, export without and with
// secrets, import with Replace, Keep both and Skip, and the in-memory fallback.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadProfiles, migrateRecord } from "@/profiles/migrate";
import { type ProfileRecord, freeName, isRecord, ulid } from "@/profiles/record";
import { type AppStorage, MemoryStorage, openStorage } from "@/profiles/storage";
import { EXPORT_FORMAT, ImportError, applyImport, exportFile, exportFileName, planImport } from "@/profiles/transfer";
import type { ProfileSchema } from "@/tools/types";
import { echoTool } from "@/tools/echo";

/** A test tool at version 2: version 0 had `host:port` in one field, version 1 renamed `pw`. */
const schemaV2: ProfileSchema = {
  version: 2,
  defaults: () => ({ fields: { host: "", port: 4222 }, secrets: {}, extras: {} }),
  validate: () => ({}),
  migrations: {
    0: (r) => {
      const [host, port] = String(r.fields["address"] ?? "").split(":");
      const { address: _, ...rest } = r.fields;
      return { ...r, fields: { ...rest, host, port: Number(port) } };
    },
    1: (r) => {
      const { pw, ...rest } = r.secrets;
      return { ...r, secrets: { ...rest, password: pw } };
    },
  },
  toConnect: (r) => r.fields,
};

const schemas = (tool: string) => (tool === "test" ? schemaV2 : tool === "echo" ? echoTool.profile : undefined);

function record(patch: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: ulid(),
    tool: "echo",
    version: 1,
    name: "lab",
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    fields: { greeting: "hi" },
    secrets: { token: "s3cret" },
    extras: {},
    ...patch,
  };
}

let storage: AppStorage;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  storage = await openStorage();
});

afterEach(() => storage.close());

describe("storage (spec §4.1)", () => {
  test("IndexedDB holds profiles, backups, the workspace and settings", async () => {
    expect(storage.kind).toBe("indexeddb");
    const a = record({ name: "a" });
    await storage.putProfile(a);
    await storage.putProfile({ ...a, name: "a2" });
    expect((await storage.getProfile(a.id))?.name).toBe("a2");
    expect(await storage.listProfiles()).toHaveLength(1);
    await storage.putWorkspace("tabs", { tabs: [], activeTab: null });
    expect(await storage.getWorkspace("tabs")).toEqual({ tabs: [], activeTab: null });
    await storage.putSettings({ version: 1, settings: { density: "compact" } });
    expect(await storage.getSettings()).toEqual({ version: 1, settings: { density: "compact" } });
    await storage.deleteProfile(a.id);
    expect(await storage.listProfiles()).toEqual([]);
    // A second open sees the same data.
    await storage.putProfile(a);
    storage.close();
    storage = await openStorage();
    expect((await storage.listProfiles()).map((p) => p.id)).toEqual([a.id]);
  });

  test("without IndexedDB the app runs in memory and says why", async () => {
    const memory = await openStorage(null);
    expect(memory.kind).toBe("memory");
    expect(memory.fallbackReason).toMatch(/no IndexedDB/);
    const broken = { open: () => { throw new Error("quota exceeded"); } } as unknown as IDBFactory;
    globalThis.indexedDB = broken;
    const refused = await openStorage(broken);
    expect(refused.kind).toBe("memory");
    expect(refused.fallbackReason).toMatch(/quota exceeded/);
    await refused.putProfile(record());
    expect(await refused.listProfiles()).toHaveLength(1);
  });
});

describe("records", () => {
  test("ULIDs, the record shape and free names", () => {
    const id = ulid(0, (n) => new Uint8Array(n));
    expect(id).toBe("0".repeat(26));
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulid(2)).not.toBe(ulid(2));
    expect(isRecord(record())).toBe(true);
    expect(isRecord({ ...record(), fields: [] })).toBe(false);
    expect(isRecord({ ...record(), version: 1.5 })).toBe(false);
    expect(freeName("lab", new Set(["lab", "lab (2)"]))).toBe("lab (3)");
    expect(freeName("lab (2)", new Set(["lab (2)"]))).toBe("lab (3)");
  });
});

describe("migration (spec §4.4)", () => {
  test("a version 0 record is migrated step by step and its backup kept until a clean start", async () => {
    const old = record({ tool: "test", version: 0, fields: { address: "nats.lab:4222" }, secrets: { pw: "x" } });
    await storage.putProfile(old);
    expect(migrateRecord(old, schemaV2)).toMatchObject({ version: 2, fields: { host: "nats.lab", port: 4222 }, secrets: { password: "x" } });

    const first = await loadProfiles(storage, schemas);
    expect(first.migrated).toBe(1);
    expect(first.states[old.id]).toEqual({ kind: "current" });
    expect(first.records[0]).toMatchObject({ version: 2, fields: { host: "nats.lab", port: 4222 } });
    expect((await storage.getProfile(old.id))?.version).toBe(2);
    expect(await storage.listBackups()).toEqual([old]);

    // The next start loads everything without error: the backup goes.
    const second = await loadProfiles(storage, schemas);
    expect(second.migrated).toBe(0);
    expect(await storage.listBackups()).toEqual([]);
  });

  test("a newer record is left as it is; a failing migration keeps the stored record", async () => {
    const newer = record({ tool: "test", version: 7, name: "from the future" });
    const broken = record({ tool: "test", version: -1, name: "broken" });
    const unknown = record({ tool: "nope", name: "unknown" });
    for (const r of [newer, broken, unknown]) await storage.putProfile(r);
    const loaded = await loadProfiles(storage, schemas);
    expect(loaded.states[newer.id]).toEqual({ kind: "newer", version: 7 });
    expect(loaded.states[unknown.id]).toEqual({ kind: "unknownTool" });
    expect(loaded.states[broken.id]).toMatchObject({ kind: "failed" });
    expect((await storage.getProfile(newer.id))?.version).toBe(7);
    expect((await storage.getProfile(broken.id))?.version).toBe(-1);
    expect(loaded.records.map((r) => r.name)).toEqual(["broken", "from the future", "unknown"]);
  });
});

describe("export and import (spec §4.3)", () => {
  test("export leaves secrets out unless asked", () => {
    const r = record();
    const without = exportFile([r], { includeSecrets: false, app: "0.1.0", now: new Date("2026-11-17T12:00:00Z") });
    expect(without).toMatchObject({ format: EXPORT_FORMAT, formatVersion: 1, includesSecrets: false, app: "0.1.0", exportedAt: "2026-11-17T12:00:00.000Z" });
    expect(without.profiles[0]!.secrets).toEqual({});
    expect(without.profiles[0]!.fields).toEqual(r.fields);
    const withSecrets = exportFile([r], { includeSecrets: true, app: "0.1.0" });
    expect(withSecrets.profiles[0]!.secrets).toEqual({ token: "s3cret" });
    expect(r.secrets).toEqual({ token: "s3cret" });
    expect(exportFileName(new Date("2026-11-17T12:00:00Z"))).toBe("mightyconsole-profiles-2026-11-17.json");
  });

  test("import plans every profile, then Replace, Keep both and Skip write what they say", () => {
    const storedSame = record({ name: "same-id", secrets: { token: "kept" } });
    const storedName = record({ name: "same-name" });
    const stored = [storedSame, storedName];
    const incoming = [
      { ...storedSame, fields: { greeting: "new" }, secrets: {} },
      record({ name: "same-name", fields: { greeting: "other" } }),
      record({ name: "fresh" }),
      record({ name: "skip me" }),
      record({ tool: "nope", name: "unknown tool" }),
      record({ tool: "test", version: 9, name: "too new" }),
      record({ tool: "test", version: 0, fields: { address: "h:1" }, name: "old" }),
      { not: "a record" },
    ];
    const text = JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 1, exportedAt: "", app: "0.1.0", includesSecrets: false, profiles: incoming });
    const plan = planImport(text, stored, schemas);
    expect(plan.rows.map((r) => [r.record.name, r.conflict?.name ?? null, r.skipReason === null ? r.choice : "skip"])).toEqual([
      ["same-id", "same-id", "keepBoth"],
      ["same-name", "same-name", "keepBoth"],
      ["fresh", null, "replace"],
      ["skip me", null, "replace"],
      ["unknown tool", null, "skip"],
      ["too new", null, "skip"],
      ["old", null, "replace"],
      ["(unnamed)", null, "skip"],
    ]);
    expect(plan.rows[4]!.skipReason).toMatch(/not in this version/);
    expect(plan.rows[5]!.skipReason).toMatch(/newer Mightyconsole/);
    expect(plan.rows[6]!.record).toMatchObject({ version: 2, fields: { host: "h", port: 1 } });

    plan.rows[0]!.choice = "replace";
    plan.rows[3]!.choice = "skip";
    const { writes, deletes } = applyImport(plan, stored, new Date("2026-11-18T00:00:00Z"));
    expect(deletes).toEqual([]);
    const byName = Object.fromEntries(writes.map((w) => [w.name, w]));
    // Replace keeps the stored id and, with no secrets in the file, the stored secrets.
    expect(byName["same-id"]).toMatchObject({ id: storedSame.id, fields: { greeting: "new" }, secrets: { token: "kept" }, createdAt: storedSame.createdAt });
    // Keep both: a new id and a free name.
    expect(byName["same-name (2)"]?.id).not.toBe(storedName.id);
    expect(byName["same-name (2)"]?.fields).toEqual({ greeting: "other" });
    expect(Object.keys(byName).sort()).toEqual(["fresh", "old", "same-id", "same-name (2)"]);
  });

  test("Replace by name moves the import onto the stored profile's id", () => {
    const stored = [record({ name: "lab" })];
    const incoming = record({ name: "lab", fields: { greeting: "x" } });
    const text = JSON.stringify(exportFile([incoming], { includeSecrets: true, app: "0.1.0" }));
    const plan = planImport(text, stored, schemas);
    plan.rows[0]!.choice = "replace";
    const { writes, deletes } = applyImport(plan, stored);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: stored[0]!.id, fields: { greeting: "x" }, secrets: { token: "s3cret" } });
    expect(deletes).toEqual([]);
  });

  test("files that are not exports are refused", () => {
    expect(() => planImport("{", [], schemas)).toThrow(ImportError);
    expect(() => planImport("{}", [], schemas)).toThrow(/not a Mightyconsole profiles export/);
    expect(() => planImport(JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 2, profiles: [] }), [], schemas)).toThrow(/newer/);
  });
});

describe("the in-memory store", () => {
  test("copies on the way in and out", async () => {
    const memory = new MemoryStorage("test");
    const r = record();
    await memory.putProfile(r);
    r.name = "changed";
    expect((await memory.getProfile(r.id))?.name).toBe("lab");
  });
});
