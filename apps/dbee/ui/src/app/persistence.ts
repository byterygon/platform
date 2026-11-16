// What survives a restart (DBee spec §14, Decision 26): the query tabs with their text, connection
// and row limit, the active tab, the sidebar width, the editor/results split, the settings. They
// live in the workspace directory (spec §2, Open question 11 decided 2026-11-16) as two documents
// the core stores whole through `app.getWorkspace` / `app.setWorkspace`:
//
//   settings.json  { version: 1, settings: Settings, layout: { shellSizes, splitSizes, sidebarOpen } }
//   tabs.json      { version: 1, tabs: PersistedTab[], activeTab }
//
// The layout and its version are the UI's; the core never reads them. Reading is tolerant: a
// missing or malformed field takes its default, so an older or newer document still opens.
// Versions before 0.1 kept the same state in the webview's localStorage under LEGACY_STORAGE_KEY;
// workspace.ts reads it once to migrate it.
import type { JsonValue } from "@/gen/api";
import { type Appearance, DEFAULT_APPEARANCE, isPreset } from "./presets";

/** Where PR #57 kept the state in webview storage; read once for the migration, then removed. */
export const LEGACY_STORAGE_KEY = "dbee.workspace.v1";

/** Version of the layout of both documents. */
export const DOCUMENT_VERSION = 1;

export interface PersistedTab {
  id: string;
  connectionId: string | null;
  sql: string;
  /** Row limit for a run; null is unlimited (Decision 13). */
  maxRows: number | null;
}

export interface Settings extends Appearance {
  editorFontSize: number;
  gridFontSize: number;
  tabSize: number;
  wordWrap: boolean;
  /** Always on in FUV (Decision 12); shown read-only. */
  confirmDestructive: true;
  screenReaderOptimized: boolean;
}

export interface Persisted {
  tabs: PersistedTab[];
  activeTab: string | null;
  /** Percent sizes of the sidebar and the main area. */
  shellSizes: number[];
  /** Percent sizes of the editor and the results panel. */
  splitSizes: number[];
  sidebarOpen: boolean;
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_APPEARANCE,
  editorFontSize: 13,
  gridFontSize: 13,
  tabSize: 2,
  wordWrap: false,
  confirmDestructive: true,
  screenReaderOptimized: false,
};

export const DEFAULT_PERSISTED: Persisted = {
  tabs: [],
  activeTab: null,
  shellSizes: [22, 78],
  splitSizes: [45, 55],
  sidebarOpen: true,
  settings: DEFAULT_SETTINGS,
};

/** The two documents as `app.setWorkspace` takes them. */
export interface Documents {
  settings: { [key: string]: JsonValue };
  tabs: { [key: string]: JsonValue };
}

export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The state from its flat form (the legacy blob, or the two documents merged), defaults for anything missing or malformed. */
function normalize(raw: Record<string, unknown>): Persisted {
  const tabs: PersistedTab[] = Array.isArray(raw["tabs"])
    ? raw["tabs"].filter(isRecord).flatMap((t) =>
        typeof t["id"] === "string"
          ? [
              {
                id: t["id"],
                connectionId: typeof t["connectionId"] === "string" ? t["connectionId"] : null,
                sql: typeof t["sql"] === "string" ? t["sql"] : "",
                maxRows: typeof t["maxRows"] === "number" ? t["maxRows"] : null,
              },
            ]
          : [],
      )
    : [];
  const s = isRecord(raw["settings"]) ? raw["settings"] : {};
  const sizes = (v: unknown, fallback: number[]) => (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && n > 0 && n < 100) ? (v as number[]) : fallback);
  const settings: Settings = {
    preset: isPreset(s["preset"]) ? s["preset"] : DEFAULT_SETTINGS.preset,
    colorScheme: s["colorScheme"] === "light" || s["colorScheme"] === "dark" ? s["colorScheme"] : "system",
    density: s["density"] === "comfortable" ? "comfortable" : "compact",
    editorFontSize: typeof s["editorFontSize"] === "number" ? s["editorFontSize"] : DEFAULT_SETTINGS.editorFontSize,
    gridFontSize: typeof s["gridFontSize"] === "number" ? s["gridFontSize"] : DEFAULT_SETTINGS.gridFontSize,
    tabSize: typeof s["tabSize"] === "number" ? s["tabSize"] : DEFAULT_SETTINGS.tabSize,
    wordWrap: s["wordWrap"] === true,
    confirmDestructive: true,
    screenReaderOptimized: s["screenReaderOptimized"] === true,
  };
  const activeTab = typeof raw["activeTab"] === "string" && tabs.some((t) => t.id === raw["activeTab"]) ? raw["activeTab"] : (tabs[0]?.id ?? null);
  return {
    tabs,
    activeTab,
    shellSizes: sizes(raw["shellSizes"], DEFAULT_PERSISTED.shellSizes),
    splitSizes: sizes(raw["splitSizes"], DEFAULT_PERSISTED.splitSizes),
    sidebarOpen: raw["sidebarOpen"] !== false,
    settings,
  };
}

/** The state as the two workspace documents. */
export function toDocuments(state: Persisted): Documents {
  return {
    settings: {
      version: DOCUMENT_VERSION,
      settings: { ...state.settings },
      layout: { shellSizes: [...state.shellSizes], splitSizes: [...state.splitSizes], sidebarOpen: state.sidebarOpen },
    },
    tabs: {
      version: DOCUMENT_VERSION,
      tabs: state.tabs.map((t) => ({ id: t.id, connectionId: t.connectionId, sql: t.sql, maxRows: t.maxRows })),
      activeTab: state.activeTab,
    },
  };
}

/** The state from the documents of `app.getWorkspace`; `null` when neither was ever written. */
export function fromDocuments(settings: JsonValue, tabs: JsonValue): Persisted | null {
  if (settings === null && tabs === null) return null;
  const s = isRecord(settings) ? settings : {};
  const t = isRecord(tabs) ? tabs : {};
  const layout = isRecord(s["layout"]) ? s["layout"] : {};
  return normalize({ ...layout, settings: s["settings"], tabs: t["tabs"], activeTab: t["activeTab"] });
}

/** The state PR #57 kept in webview storage, if any is there and readable. */
export function readLegacy(storage: Storage | undefined = defaultStorage()): Persisted | null {
  let text: string | null | undefined;
  try {
    text = storage?.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const raw: unknown = JSON.parse(text);
    return isRecord(raw) ? normalize(raw) : null;
  } catch {
    return null;
  }
}

/** Removes the legacy state once the workspace holds it. */
export function clearLegacy(storage: Storage | undefined = defaultStorage()): void {
  try {
    storage?.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Unavailable storage: nothing to remove.
  }
}

export function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
