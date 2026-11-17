// The app's state (Mightyconsole spec §3, §4): profiles and their live connections, tabs, the
// selected tool, layout, settings, dialogs and the server's status. Tabs and layout persist in the
// `workspace` store, settings in `settings` (spec §4.1), written shortly after each change.
import { type Dispatch, type ReactNode, createContext, useContext, useEffect, useReducer, useRef } from "react";
import type { AppInfo } from "@/gen/api";
import type { RecordState } from "@/profiles/migrate";
import type { ProfileRecord } from "@/profiles/record";
import type { AppStorage } from "@/profiles/storage";
import type { DescribedError, LiveState, TabRecord } from "@/tools/types";
import { type Appearance, DEFAULT_APPEARANCE, isPreset } from "./presets";
import type { ServerStatus } from "./supervisor";

export const SETTINGS_VERSION = 1;

export interface Settings extends Appearance {
  editorFontSize: number;
  /** Messages kept in a live view (spec §3.6, Open question 10). */
  liveBuffer: number;
  /** Lines kept in a log view. */
  logBuffer: number;
  /** Messages a consume reads by default. */
  consumeLimit: number;
}

export const DEFAULT_SETTINGS: Settings = { ...DEFAULT_APPEARANCE, editorFontSize: 13, liveBuffer: 10_000, logBuffer: 50_000, consumeLimit: 500 };

export interface Layout {
  sidebarOpen: boolean;
  /** Percent sizes of the sidebar and the main area. */
  shellSizes: number[];
  /** The selected tool. */
  tool: string;
}

export interface Persisted {
  tabs: TabRecord[];
  activeTab: string | null;
  layout: Layout;
  settings: Settings;
}

/** A profile's connection as the UI tracks it. */
export interface ConnState {
  status: "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";
  connId: string | null;
  error?: DescribedError;
  message?: string;
  /** When the status became `connecting`, for "still waiting" after 10 s. */
  since?: number;
}

export type Dialog =
  | { kind: "none" }
  | { kind: "profile"; tool: string; editId?: string; duplicateOf?: string }
  | { kind: "deleteProfile"; id: string }
  | { kind: "export"; ids: string[] | null }
  | { kind: "import" }
  | { kind: "settings" }
  | { kind: "about" }
  | { kind: "shortcuts" }
  | { kind: "closeTab"; id: string };

export interface State {
  profiles: ProfileRecord[] | null;
  recordStates: Record<string, RecordState>;
  storageKind: "indexeddb" | "memory";
  conns: Record<string, ConnState>;
  tabs: TabRecord[];
  activeTab: string | null;
  /** Live state per tab, from the tab components. */
  live: Record<string, LiveState | null>;
  layout: Layout;
  settings: Settings;
  server: ServerStatus;
  info: AppInfo | null;
  dialog: Dialog;
  paletteOpen: boolean;
  selectedNode: string | null;
  diagnostics: string[];
}

export type Action =
  | { type: "profiles"; profiles: ProfileRecord[]; recordStates?: Record<string, RecordState> }
  | { type: "conn"; profileId: string; conn: ConnState }
  | { type: "connsReset"; status: ConnState["status"]; message?: string }
  | { type: "openTab"; tab: TabRecord }
  | { type: "closeTab"; id: string }
  | { type: "activateTab"; id: string }
  | { type: "reorderTab"; id: string; index: number }
  | { type: "live"; id: string; live: LiveState | null }
  | { type: "layout"; layout: Partial<Layout> }
  | { type: "settings"; settings: Partial<Settings> }
  | { type: "server"; status: ServerStatus }
  | { type: "info"; info: AppInfo }
  | { type: "dialog"; dialog: Dialog }
  | { type: "palette"; open: boolean }
  | { type: "select"; nodeId: string | null }
  | { type: "diagnostic"; line: string };

export function initialState(persisted: Persisted, storageKind: "indexeddb" | "memory"): State {
  return {
    profiles: null,
    recordStates: {},
    storageKind,
    conns: {},
    tabs: persisted.tabs,
    activeTab: persisted.activeTab,
    live: {},
    layout: persisted.layout,
    settings: persisted.settings,
    server: "connecting",
    info: null,
    dialog: { kind: "none" },
    paletteOpen: false,
    selectedNode: null,
    diagnostics: [],
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "profiles":
      return { ...state, profiles: action.profiles, recordStates: action.recordStates ?? state.recordStates };
    case "conn":
      return { ...state, conns: { ...state.conns, [action.profileId]: action.conn } };
    case "connsReset": {
      const conns: Record<string, ConnState> = {};
      for (const [id, c] of Object.entries(state.conns)) {
        conns[id] = c.status === "disconnected" ? c : { status: action.status, connId: null, ...(action.message ? { message: action.message } : {}) };
      }
      return { ...state, conns };
    }
    case "openTab": {
      if (state.tabs.some((t) => t.id === action.tab.id)) return { ...state, activeTab: action.tab.id };
      return { ...state, tabs: [...state.tabs, action.tab], activeTab: action.tab.id };
    }
    case "closeTab": {
      const i = state.tabs.findIndex((t) => t.id === action.id);
      if (i < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      const activeTab = state.activeTab === action.id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : state.activeTab;
      const { [action.id]: _, ...live } = state.live;
      return { ...state, tabs, activeTab, live, dialog: state.dialog.kind === "closeTab" ? { kind: "none" } : state.dialog };
    }
    case "activateTab":
      return state.tabs.some((t) => t.id === action.id) ? { ...state, activeTab: action.id } : state;
    case "reorderTab": {
      const tab = state.tabs.find((t) => t.id === action.id);
      if (!tab) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      tabs.splice(Math.max(0, Math.min(action.index, tabs.length)), 0, tab);
      return { ...state, tabs };
    }
    case "live":
      return { ...state, live: { ...state.live, [action.id]: action.live } };
    case "layout":
      return { ...state, layout: { ...state.layout, ...action.layout } };
    case "settings":
      return { ...state, settings: { ...state.settings, ...action.settings } };
    case "server":
      return { ...state, server: action.status };
    case "info":
      return { ...state, info: action.info };
    case "dialog":
      return { ...state, dialog: action.dialog };
    case "palette":
      return { ...state, paletteOpen: action.open };
    case "select":
      return { ...state, selectedNode: action.nodeId };
    case "diagnostic":
      return { ...state, diagnostics: [action.line, ...state.diagnostics].slice(0, 100) };
  }
}

/** The tab id for a resource, so opening it again focuses the same tab (spec §3.2). */
export function tabIdOf(tool: string, profileId: string, kind: string, params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort();
  return `${tool}|${profileId}|${kind}|${keys.map((k) => `${k}=${JSON.stringify(params[k])}`).join("&")}`;
}

// --- Persistence ---------------------------------------------------------------------------------

const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback);

/** Reads the persisted tabs, layout and settings; anything missing or malformed takes its default. */
export async function loadPersisted(storage: AppStorage, tools: readonly string[]): Promise<Persisted> {
  const [tabsDoc, layoutDoc, settingsDoc] = await Promise.all([
    storage.getWorkspace<{ tabs?: unknown; activeTab?: unknown }>("tabs").catch(() => undefined),
    storage.getWorkspace<Partial<Layout>>("layout").catch(() => undefined),
    storage.getSettings<{ version?: unknown; settings?: Partial<Settings> }>().catch(() => undefined),
  ]);
  const tabs = Array.isArray(tabsDoc?.tabs)
    ? (tabsDoc.tabs as unknown[]).filter((t): t is TabRecord => {
        const r = t as Partial<TabRecord>;
        return typeof r?.id === "string" && typeof r.tool === "string" && tools.includes(r.tool) && typeof r.profileId === "string" && typeof r.kind === "string" && typeof r.title === "string" && typeof r.params === "object" && r.params !== null;
      }).map((t) => ({ ...t, pinned: t.pinned === true }))
    : [];
  const activeTab = typeof tabsDoc?.activeTab === "string" && tabs.some((t) => t.id === tabsDoc.activeTab) ? tabsDoc.activeTab : (tabs[0]?.id ?? null);
  const s = settingsDoc?.settings ?? {};
  const sizes = layoutDoc?.shellSizes;
  return {
    tabs,
    activeTab,
    layout: {
      sidebarOpen: layoutDoc?.sidebarOpen !== false,
      shellSizes: Array.isArray(sizes) && sizes.length === 2 && sizes.every((n) => typeof n === "number") ? sizes : [22, 78],
      tool: typeof layoutDoc?.tool === "string" && tools.includes(layoutDoc.tool) ? layoutDoc.tool : (tools[0] ?? ""),
    },
    settings: {
      preset: isPreset(s.preset) ? s.preset : DEFAULT_SETTINGS.preset,
      colorScheme: s.colorScheme === "light" || s.colorScheme === "dark" || s.colorScheme === "system" ? s.colorScheme : DEFAULT_SETTINGS.colorScheme,
      density: s.density === "compact" || s.density === "comfortable" ? s.density : DEFAULT_SETTINGS.density,
      editorFontSize: num(s.editorFontSize, DEFAULT_SETTINGS.editorFontSize, 9, 32),
      liveBuffer: num(s.liveBuffer, DEFAULT_SETTINGS.liveBuffer, 100, 1_000_000),
      logBuffer: num(s.logBuffer, DEFAULT_SETTINGS.logBuffer, 1000, 1_000_000),
      consumeLimit: num(s.consumeLimit, DEFAULT_SETTINGS.consumeLimit, 1, 100_000),
    },
  };
}

// --- Provider ------------------------------------------------------------------------------------

interface StoreValue {
  state: State;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (value === null) throw new Error("StoreProvider is missing");
  return value;
}

/** Holds the state; writes tabs, layout and settings 200 ms after they change. */
export function StoreProvider({ persisted, storage, children, saveDelayMs = 200 }: { persisted: Persisted; storage: AppStorage; children: ReactNode; saveDelayMs?: number }) {
  const [state, dispatch] = useReducer(reducer, persisted, (p) => initialState(p, storage.kind));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => {
      void storage.putWorkspace("tabs", { tabs: state.tabs, activeTab: state.activeTab }).catch(() => {});
      void storage.putWorkspace("layout", state.layout).catch(() => {});
      void storage.putSettings({ version: SETTINGS_VERSION, settings: state.settings }).catch(() => {});
    }, saveDelayMs);
    return () => clearTimeout(timer);
  }, [state.tabs, state.activeTab, state.layout, state.settings, storage, saveDelayMs]);
  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}
