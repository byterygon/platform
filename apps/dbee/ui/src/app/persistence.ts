// What survives a restart (DBee spec §14, Decision 26): the query tabs with their text and
// connection, the sidebar width, the editor/results split, the settings. Kept in the webview's
// storage of the shell (the desktop webview's or the browser's localStorage); the core's
// settings.json and tabs.json have no procedure in spec §5 yet (spec Open question, batch 4).
import { type Appearance, DEFAULT_APPEARANCE, isPreset } from "./presets";

export const STORAGE_KEY = "dbee.workspace.v1";

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

export interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Reads the persisted state, taking defaults for anything missing or malformed. */
export function load(storage: Storage | undefined = defaultStorage()): Persisted {
  const text = storage?.getItem(STORAGE_KEY);
  if (!text) return DEFAULT_PERSISTED;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_PERSISTED;
  }
  if (!isRecord(raw)) return DEFAULT_PERSISTED;
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

export function save(state: Persisted, storage: Storage | undefined = defaultStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable: the session still works, nothing persists.
  }
}

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
