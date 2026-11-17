// Browser storage (Mightyconsole spec §4.1): IndexedDB database `mightyconsole` through `idb`,
// with the object stores `profiles` (index `tool`), `profilesBackup`, `workspace` and `settings`.
// Every write is one transaction. Other browser tabs hear about profile changes on the
// `BroadcastChannel("mightyconsole")`. When IndexedDB cannot be opened (a private window, a
// quota, a browser that blocks it) the app runs on an in-memory store and says so.
import { type IDBPDatabase, openDB } from "idb";
import type { ProfileRecord } from "./record";

export const DB_NAME = "mightyconsole";
export const DB_VERSION = 1;
export const CHANNEL = "mightyconsole";

export type WorkspaceKey = "tabs" | "layout";

export interface AppStorage {
  readonly kind: "indexeddb" | "memory";
  /** Why the in-memory store is used, when it is. */
  readonly fallbackReason: string | null;
  listProfiles(): Promise<ProfileRecord[]>;
  getProfile(id: string): Promise<ProfileRecord | undefined>;
  putProfile(record: ProfileRecord): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  /** Writes the record and its pre-migration copy in one transaction. */
  putMigrated(record: ProfileRecord, before: ProfileRecord): Promise<void>;
  listBackups(): Promise<ProfileRecord[]>;
  deleteBackup(id: string): Promise<void>;
  getWorkspace<T>(key: WorkspaceKey): Promise<T | undefined>;
  putWorkspace(key: WorkspaceKey, value: unknown): Promise<void>;
  getSettings<T>(): Promise<T | undefined>;
  putSettings(value: unknown): Promise<void>;
  /** Bytes used by this origin, when the browser says. */
  estimate(): Promise<number | null>;
  /** Deletes everything this app stored in the browser. */
  forgetEverything(): Promise<void>;
  /** Called when another tab changed the profiles. */
  onExternalChange(listener: () => void): () => void;
  /** Tells other tabs the profiles changed. */
  announce(): void;
  close(): void;
}

interface Schema {
  profiles: { key: string; value: ProfileRecord; indexes: { tool: string } };
  profilesBackup: { key: string; value: ProfileRecord };
  workspace: { key: string; value: unknown };
  settings: { key: string; value: unknown };
}

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
}

class IdbStorage implements AppStorage {
  readonly kind = "indexeddb" as const;
  readonly fallbackReason = null;
  readonly #db: IDBPDatabase<Schema>;
  readonly #channel = channel();
  readonly #listeners = new Set<() => void>();

  constructor(db: IDBPDatabase<Schema>) {
    this.#db = db;
    this.#channel?.addEventListener("message", () => this.#listeners.forEach((l) => l()));
    // A newer version of the app opened the database elsewhere: let it upgrade.
    db.addEventListener("versionchange", () => db.close());
  }

  listProfiles() {
    return this.#db.getAll("profiles");
  }
  getProfile(id: string) {
    return this.#db.get("profiles", id);
  }
  async putProfile(record: ProfileRecord) {
    await this.#db.put("profiles", record);
  }
  async deleteProfile(id: string) {
    await this.#db.delete("profiles", id);
  }
  async putMigrated(record: ProfileRecord, before: ProfileRecord) {
    const tx = this.#db.transaction(["profiles", "profilesBackup"], "readwrite");
    await Promise.all([tx.objectStore("profilesBackup").put(before), tx.objectStore("profiles").put(record), tx.done]);
  }
  listBackups() {
    return this.#db.getAll("profilesBackup");
  }
  async deleteBackup(id: string) {
    await this.#db.delete("profilesBackup", id);
  }
  async getWorkspace<T>(key: WorkspaceKey) {
    return (await this.#db.get("workspace", key)) as T | undefined;
  }
  async putWorkspace(key: WorkspaceKey, value: unknown) {
    await this.#db.put("workspace", value, key);
  }
  async getSettings<T>() {
    return (await this.#db.get("settings", "settings")) as T | undefined;
  }
  async putSettings(value: unknown) {
    await this.#db.put("settings", value, "settings");
  }
  async estimate() {
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    return estimate?.usage ?? null;
  }
  async forgetEverything() {
    this.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("deleteDatabase failed"));
      request.onblocked = () => resolve();
    });
  }
  onExternalChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  announce() {
    this.#channel?.postMessage("profiles");
  }
  close() {
    this.#channel?.close();
    this.#db.close();
  }
}

/** The fallback: the same interface over maps; nothing survives a reload. */
export class MemoryStorage implements AppStorage {
  readonly kind = "memory" as const;
  readonly fallbackReason: string | null;
  readonly profiles = new Map<string, ProfileRecord>();
  readonly backups = new Map<string, ProfileRecord>();
  readonly workspace = new Map<string, unknown>();
  settings: unknown;

  constructor(reason: string | null = null) {
    this.fallbackReason = reason;
  }

  async listProfiles() {
    return [...this.profiles.values()].map(clone);
  }
  async getProfile(id: string) {
    const r = this.profiles.get(id);
    return r ? clone(r) : undefined;
  }
  async putProfile(record: ProfileRecord) {
    this.profiles.set(record.id, clone(record));
  }
  async deleteProfile(id: string) {
    this.profiles.delete(id);
  }
  async putMigrated(record: ProfileRecord, before: ProfileRecord) {
    this.backups.set(before.id, clone(before));
    this.profiles.set(record.id, clone(record));
  }
  async listBackups() {
    return [...this.backups.values()].map(clone);
  }
  async deleteBackup(id: string) {
    this.backups.delete(id);
  }
  async getWorkspace<T>(key: WorkspaceKey) {
    return this.workspace.get(key) as T | undefined;
  }
  async putWorkspace(key: WorkspaceKey, value: unknown) {
    this.workspace.set(key, structuredClone(value));
  }
  async getSettings<T>() {
    return this.settings as T | undefined;
  }
  async putSettings(value: unknown) {
    this.settings = structuredClone(value);
  }
  async estimate() {
    return null;
  }
  async forgetEverything() {
    this.profiles.clear();
    this.backups.clear();
    this.workspace.clear();
    this.settings = undefined;
  }
  onExternalChange() {
    return () => {};
  }
  announce() {}
  close() {}
}

const clone = (r: ProfileRecord): ProfileRecord => structuredClone(r);

/**
 * Opens IndexedDB, or the in-memory store with the reason when it cannot be opened. idb opens the
 * global factory; `factory` only says whether there is one (`null`: none).
 */
export async function openStorage(factory: IDBFactory | null = globalThis.indexedDB ?? null): Promise<AppStorage> {
  if (factory === null) return new MemoryStorage("this browser has no IndexedDB");
  try {
    const db = await openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const profiles = db.createObjectStore("profiles", { keyPath: "id" });
        profiles.createIndex("tool", "tool");
        db.createObjectStore("profilesBackup", { keyPath: "id" });
        db.createObjectStore("workspace");
        db.createObjectStore("settings");
      },
    });
    return new IdbStorage(db);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return new MemoryStorage(`the browser refused IndexedDB (${reason})`);
  }
}
