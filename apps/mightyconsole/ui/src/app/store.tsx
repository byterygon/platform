// The app's state (Mightyconsole spec §3, §4): profiles and their live connections, tabs, the
// selected tool, layout, settings, dialogs and the server's status. Tabs and layout persist in the
// `workspace` store, settings in `settings` (spec §4.1), written shortly after each change. Each
// tab keeps its own back and forward history (DOC-21 §3.7), saved with it. Tabs are grouped by tool
// (DOC-21 §3.2.1, TSK-111): `tabs` is kept in group order, each group's tabs together.
import { type Dispatch, type ReactNode, createContext, useContext, useEffect, useReducer, useRef } from "react";
import type { AppInfo } from "@/gen/api";
import type { RecordState } from "@/profiles/migrate";
import type { ProfileRecord } from "@/profiles/record";
import type { AppStorage } from "@/profiles/storage";
import type { DescribedError, LiveState, TabPlace, TabRecord } from "@/tools/types";
import { type Appearance, DEFAULT_APPEARANCE, isPreset } from "./presets";
import type { ServerStatus } from "./supervisor";
import { goTab, migrateTab, placeHas, placeOf, pushPlace, replacePlace, stepTab } from "./tab-history";

export const SETTINGS_VERSION = 1;
/**
 * The `tabs` workspace document: version 2 added each tab's history (DOC-21 §3.7), version 3 the
 * groups' order and each group's last focused tab (DOC-21 §3.2.1).
 */
export const TABS_VERSION = 3;
/** Closed tabs kept with their history while the page lives, so a browser step back reopens one. */
export const CLOSED_TABS_KEPT = 20;

export interface Settings extends Appearance {
  editorFontSize: number;
  /** Messages kept in a live view (spec §3.6, Open question 10). */
  liveBuffer: number;
  /** Lines kept in a log view. */
  logBuffer: number;
  /** Messages a consume reads by default. */
  consumeLimit: number;
  /** The order of a Temporal workflow's History and Timeline (TSK-109): newest first unless changed. */
  historyOrder: "newest" | "oldest";
}

export const DEFAULT_SETTINGS: Settings = { ...DEFAULT_APPEARANCE, editorFontSize: 13, liveBuffer: 10_000, logBuffer: 50_000, consumeLimit: 500, historyOrder: "newest" };

export interface Layout {
  sidebarOpen: boolean;
  /** Percent sizes of the sidebar and the main area. */
  shellSizes: number[];
  /** The selected tool. */
  tool: string;
  /**
   * The tool navigation (DOC-21 §3.1): `true` the rail, `false` the drawer, `null` by window
   * width (the drawer from 1280 px, the rail below).
   */
  navCollapsed: boolean | null;
  /** Tools pinned to the top of the navigation, in pin order. */
  pinnedTools: string[];
  /** Navigation categories the user folded. */
  closedCategories: string[];
}

/** The expanded tree nodes of each profile (tree ids, `p:<profile id>` and below), saved as the workspace's `tree` (DOC-21 §3.2.1). */
export type TreeExpanded = Record<string, string[]>;

/**
 * A reveal of the focused tab's node (DOC-21 §3.2.1): the tree selects `path`'s deepest node that
 * it draws, and the last one once it shows. `seq` counts reveals, so one can be asked again.
 */
export interface Reveal {
  profileId: string;
  /** Tree ids from the profile node down; the last is the tab's node. */
  path: string[];
  seq: number;
}

export interface Persisted {
  tabs: TabRecord[];
  activeTab: string | null;
  /** The tab groups' order: tool ids (DOC-21 §3.2.1). */
  groups: string[];
  /** Each group's last focused tab, by tool. */
  lastActive: Record<string, string>;
  /** The expanded tree nodes per profile. */
  treeExpanded?: TreeExpanded;
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
  /** `name` fills a new profile's name (a link's missing profile). */
  | { kind: "profile"; tool: string; editId?: string; duplicateOf?: string; name?: string }
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
  /** In group order: each tool's tabs together, the groups as `groups` says. */
  tabs: TabRecord[];
  activeTab: string | null;
  /** The tab groups' order, one per tool with tabs (DOC-21 §3.2.1). */
  groups: string[];
  /** Each group's last focused tab, by tool: a folded group opens on it. */
  lastActive: Record<string, string>;
  /** The last closed tabs, newest first (memory only). */
  closedTabs: TabRecord[];
  /** Live state per tab, from the tab components. */
  live: Record<string, LiveState | null>;
  layout: Layout;
  settings: Settings;
  server: ServerStatus;
  info: AppInfo | null;
  dialog: Dialog;
  paletteOpen: boolean;
  selectedNode: string | null;
  /** The expanded tree nodes per profile (DOC-21 §3.2.1): the store's, so a reveal works across tools. */
  treeExpanded: TreeExpanded;
  /** The focused tab's node, until the tree has selected it or the person picks another. */
  reveal: Reveal | null;
  /** The last reveal's seq: each reveal counts on from it. */
  revealSeq: number;
  diagnostics: string[];
  /** A link naming a profile this browser lacks (DOC-21 §3.7): its page shows in a link tab. */
  missingLink: MissingLink | null;
}

/** What a link to a missing profile names. */
export interface MissingLink {
  tool: string;
  profileName: string;
  /** The router href, without the base path. */
  href: string;
  /** The place it points to; `null` for a profile's own URL. */
  place: Omit<TabPlace, "title"> | null;
  /** The link tab's title: the place's, or the profile name. */
  title: string;
}

export type Action =
  | { type: "profiles"; profiles: ProfileRecord[]; recordStates?: Record<string, RecordState> }
  | { type: "conn"; profileId: string; conn: ConnState }
  | { type: "connsReset"; status: ConnState["status"]; message?: string }
  /**
   * Opens a resource, or focuses its tab. With `preview`, a new tab goes into the tool's preview
   * tab, replacing it in place; without, the tab is (or becomes) a normal one (DOC-21 §3.2.1).
   */
  | { type: "openTab"; tab: TabRecord; preview?: boolean }
  /** A preview tab kept: a normal tab from now on. */
  | { type: "keepTab"; id: string }
  /** A step of the tab: pushed onto its history, or replacing its current step. */
  | { type: "navigateTab"; id: string; place: TabPlace; replace?: boolean }
  /** Back (`-1`) or forward (`1`) in the tab's history. */
  | { type: "tabGo"; id: string; delta: number }
  /** The tab at a step of its history, activated. */
  | { type: "tabStep"; id: string; step: number }
  /** A closed tab back, at a step of its history. */
  | { type: "reopenTab"; id: string; step: number }
  | { type: "closeTab"; id: string }
  | { type: "activateTab"; id: string }
  /** A tab moved inside its group, to `index` among the group's tabs. */
  | { type: "moveTab"; id: string; index: number }
  /** A group moved to `index` among the groups. */
  | { type: "moveGroup"; tool: string; index: number }
  /** A group opened on its last focused tab. */
  | { type: "openGroup"; tool: string }
  | { type: "live"; id: string; live: LiveState | null }
  | { type: "layout"; layout: Partial<Layout> }
  | { type: "settings"; settings: Partial<Settings> }
  | { type: "server"; status: ServerStatus }
  | { type: "info"; info: AppInfo }
  | { type: "dialog"; dialog: Dialog }
  | { type: "palette"; open: boolean }
  /** A node picked by the person; it ends a reveal in progress. */
  | { type: "select"; nodeId: string | null }
  /** A node selected by a reveal (the tree drew it); `done` when it is the tab's own node. */
  | { type: "revealed"; seq: number; nodeId: string; done: boolean }
  /** Shows the focused tab's node in the tree: its tool, its ancestors expanded, then selected. */
  | { type: "reveal"; tool: string; profileId: string; path: string[] }
  /** The expanded nodes of one profile's tree. */
  | { type: "treeExpanded"; profileId: string; ids: string[] }
  | { type: "diagnostic"; line: string }
  /** The missing-profile page shown, or dropped. */
  | { type: "missingLink"; link: MissingLink | null };

export function initialState(persisted: Persisted, storageKind: "indexeddb" | "memory"): State {
  return {
    profiles: null,
    recordStates: {},
    storageKind,
    conns: {},
    ...arrange(persisted.tabs, persisted.groups, persisted.lastActive, persisted.activeTab),
    activeTab: persisted.activeTab,
    closedTabs: [],
    live: {},
    layout: persisted.layout,
    settings: persisted.settings,
    server: "connecting",
    info: null,
    dialog: { kind: "none" },
    paletteOpen: false,
    selectedNode: null,
    treeExpanded: persisted.treeExpanded ?? {},
    reveal: null,
    revealSeq: 0,
    diagnostics: [],
    missingLink: null,
  };
}

/**
 * Puts each tool's tabs together in the groups' order (a tool not in `groups` goes last, a group
 * without tabs goes away) and keeps each group's last focused tab pointing at one of its tabs.
 */
export function arrange(tabs: readonly TabRecord[], groups: readonly string[], lastActive: Readonly<Record<string, string>>, activeTab: string | null): { tabs: TabRecord[]; groups: string[]; lastActive: Record<string, string> } {
  const order = groups.filter((g, i) => groups.indexOf(g) === i && tabs.some((t) => t.tool === g));
  for (const t of tabs) if (!order.includes(t.tool)) order.push(t.tool);
  const arranged = order.flatMap((g) => tabs.filter((t) => t.tool === g));
  const last: Record<string, string> = {};
  for (const g of order) {
    const mine = arranged.filter((t) => t.tool === g);
    const kept = lastActive[g];
    last[g] = kept && mine.some((t) => t.id === kept) ? kept : mine[0]!.id;
  }
  const active = activeTab ? arranged.find((t) => t.id === activeTab) : undefined;
  if (active) last[active.tool] = active.id;
  return { tabs: arranged, groups: order, lastActive: last };
}

/** The tool whose group is open: the focused tab's. */
export function openGroupOf(state: Pick<State, "tabs" | "activeTab">): string | null {
  return state.tabs.find((t) => t.id === state.activeTab)?.tool ?? null;
}

/**
 * The tab to focus when the focused tab closes (DOC-21 §3.2.1): its right neighbour in its group,
 * else its left one, else the last focused tab of the next group, then of the groups before.
 */
function nextAfterClose(state: State, closing: TabRecord): string | null {
  const mine = state.tabs.filter((t) => t.tool === closing.tool);
  const i = mine.indexOf(closing);
  const neighbour = mine[i + 1] ?? mine[i - 1];
  if (neighbour) return neighbour.id;
  const at = state.groups.indexOf(closing.tool);
  for (const g of [...state.groups.slice(at + 1), ...state.groups.slice(0, Math.max(0, at)).reverse()]) {
    const id = state.lastActive[g];
    if (id && state.tabs.some((t) => t.id === id)) return id;
    const first = state.tabs.find((t) => t.tool === g);
    if (first) return first.id;
  }
  return null;
}

export function reducer(state: State, action: Action): State {
  const next = reduce(state, action);
  if (next === state) return next;
  if (next.tabs === state.tabs && next.groups === state.groups && next.activeTab === state.activeTab) return next;
  return { ...next, ...arrange(next.tabs, next.groups, next.lastActive, next.activeTab) };
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "profiles": {
      // A deleted profile's tree goes with it.
      const ids = new Set(action.profiles.map((p) => p.id));
      const gone = Object.keys(state.treeExpanded).filter((id) => !ids.has(id));
      const treeExpanded = gone.length === 0 ? state.treeExpanded : Object.fromEntries(Object.entries(state.treeExpanded).filter(([id]) => ids.has(id)));
      return { ...state, profiles: action.profiles, recordStates: action.recordStates ?? state.recordStates, treeExpanded };
    }
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
      // Opening a resource focuses the tab already showing it (spec §3.2): its current place has
      // every param asked for. A tab's id no longer follows its place, so a new id must be free.
      const { tab } = action;
      const existing = state.tabs.find((t) => t.tool === tab.tool && t.profileId === tab.profileId && placeHas(placeOf(t), tab));
      if (existing) {
        const kept = existing.preview && !action.preview ? mapTab(state, existing.id, keep) : state;
        return { ...kept, activeTab: existing.id, missingLink: null };
      }
      // The tool's preview tab is replaced in place (a new id, so its screen starts afresh).
      const replaced = action.preview ? state.tabs.find((t) => t.tool === tab.tool && t.preview) : undefined;
      const taken = new Set(state.tabs.filter((t) => t !== replaced).map((t) => t.id));
      let id = tab.id;
      for (let n = 2; taken.has(id); n++) id = `${tab.id}#${n}`;
      const fresh: TabRecord = { ...tab, id, preview: action.preview === true };
      if (!action.preview) delete fresh.preview;
      const tabs = replaced ? state.tabs.map((t) => (t === replaced ? fresh : t)) : [...state.tabs, fresh];
      const live = replaced ? Object.fromEntries(Object.entries(state.live).filter(([key]) => key !== replaced.id)) : state.live;
      return { ...state, tabs, live, activeTab: id, closedTabs: state.closedTabs.filter((t) => t.id !== id), missingLink: null };
    }
    case "keepTab":
      return mapTab(state, action.id, keep);
    case "navigateTab":
      // A step taken inside a preview tab keeps it: its Back history is not lost to the next click (Open question 64 (e)).
      return mapTab(state, action.id, (t) => (action.replace ? replacePlace(t, action.place) : keep(pushPlace(t, action.place))));
    case "tabGo":
      return mapTab(state, action.id, (t) => goTab(t, action.delta));
    case "tabStep": {
      const next = mapTab(state, action.id, (t) => stepTab(t, action.step));
      return next.tabs.some((t) => t.id === action.id) ? { ...next, activeTab: action.id, missingLink: null } : next;
    }
    case "reopenTab": {
      const closed = state.closedTabs.find((t) => t.id === action.id);
      if (!closed || state.tabs.some((t) => t.id === action.id)) return state;
      return { ...state, tabs: [...state.tabs, stepTab(closed, action.step)], activeTab: closed.id, closedTabs: state.closedTabs.filter((t) => t.id !== action.id), missingLink: null };
    }
    case "closeTab": {
      const i = state.tabs.findIndex((t) => t.id === action.id);
      if (i < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      const activeTab = state.activeTab === action.id ? nextAfterClose(state, state.tabs[i]!) : state.activeTab;
      const { [action.id]: _, ...live } = state.live;
      const closedTabs = [state.tabs[i]!, ...state.closedTabs.filter((t) => t.id !== action.id)].slice(0, CLOSED_TABS_KEPT);
      return { ...state, tabs, activeTab, live, closedTabs, dialog: state.dialog.kind === "closeTab" ? { kind: "none" } : state.dialog };
    }
    case "activateTab":
      return state.tabs.some((t) => t.id === action.id) ? { ...state, activeTab: action.id, missingLink: null } : state;
    case "moveTab": {
      const tab = state.tabs.find((t) => t.id === action.id);
      if (!tab) return state;
      const mine = state.tabs.filter((t) => t.tool === tab.tool && t.id !== tab.id);
      mine.splice(Math.max(0, Math.min(action.index, mine.length)), 0, tab);
      const tabs = state.tabs.filter((t) => t.tool !== tab.tool);
      return { ...state, tabs: [...tabs, ...mine] };
    }
    case "moveGroup": {
      if (!state.groups.includes(action.tool)) return state;
      const groups = state.groups.filter((g) => g !== action.tool);
      groups.splice(Math.max(0, Math.min(action.index, groups.length)), 0, action.tool);
      return groups.every((g, i) => g === state.groups[i]) ? state : { ...state, groups };
    }
    case "openGroup": {
      const id = state.lastActive[action.tool] ?? state.tabs.find((t) => t.tool === action.tool)?.id;
      return id && state.tabs.some((t) => t.id === id) ? { ...state, activeTab: id, missingLink: null } : state;
    }
    case "live": {
      const next = { ...state, live: { ...state.live, [action.id]: action.live } };
      // A running (or paused) stream is state to lose: its preview tab is kept (DOC-21 §3.2.1).
      return action.live?.status === "live" || action.live?.status === "paused" ? mapTab(next, action.id, keep) : next;
    }
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
      return { ...state, selectedNode: action.nodeId, reveal: null };
    case "reveal": {
      // The profile and the node's ancestors open now, also those still loading (they show open).
      const ancestors = action.path.slice(0, -1);
      const mine = state.treeExpanded[action.profileId] ?? [];
      const missing = ancestors.filter((id) => !mine.includes(id));
      return {
        ...state,
        layout: state.layout.tool === action.tool ? state.layout : { ...state.layout, tool: action.tool },
        treeExpanded: missing.length > 0 ? { ...state.treeExpanded, [action.profileId]: [...mine, ...missing] } : state.treeExpanded,
        reveal: { profileId: action.profileId, path: action.path, seq: state.revealSeq + 1 },
        revealSeq: state.revealSeq + 1,
      };
    }
    case "revealed":
      if (state.reveal?.seq !== action.seq) return state;
      return { ...state, selectedNode: action.nodeId, reveal: action.done ? null : state.reveal };
    case "treeExpanded": {
      const before = state.treeExpanded[action.profileId] ?? [];
      if (before.length === action.ids.length && before.every((id, i) => id === action.ids[i])) return state;
      return { ...state, treeExpanded: { ...state.treeExpanded, [action.profileId]: action.ids } };
    }
    case "diagnostic":
      return { ...state, diagnostics: [action.line, ...state.diagnostics].slice(0, 100) };
    case "missingLink":
      return { ...state, missingLink: action.link };
  }
}

/** The tab without its preview mark. */
function keep(tab: TabRecord): TabRecord {
  if (!tab.preview) return tab;
  const { preview: _, ...rest } = tab;
  return rest;
}

function mapTab(state: State, id: string, change: (tab: TabRecord) => TabRecord): State {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (t.id !== id) return t;
    const next = change(t);
    changed ||= next !== t;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

/**
 * The id a new tab of a resource starts with (spec §3.2). A tab keeps its id when it moves
 * (DOC-21 §3.7), so ids are compared only to keep them unique.
 */
export function tabIdOf(tool: string, profileId: string, kind: string, params: Record<string, unknown>): string {
  const keys = Object.keys(params).sort();
  return `${tool}|${profileId}|${kind}|${keys.map((k) => `${k}=${JSON.stringify(params[k])}`).join("&")}`;
}

// --- Persistence ---------------------------------------------------------------------------------

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const num = (v: unknown, fallback: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback);

/** Reads the persisted tabs, layout and settings; anything missing or malformed takes its default. */
export async function loadPersisted(storage: AppStorage, tools: readonly string[]): Promise<Persisted> {
  const [tabsDoc, layoutDoc, treeDoc, settingsDoc] = await Promise.all([
    storage.getWorkspace<{ version?: unknown; tabs?: unknown; activeTab?: unknown; groups?: unknown; lastActive?: unknown }>("tabs").catch(() => undefined),
    storage.getWorkspace<Partial<Layout>>("layout").catch(() => undefined),
    storage.getWorkspace<{ version?: unknown; profiles?: unknown }>("tree").catch(() => undefined),
    storage.getSettings<{ version?: unknown; settings?: Partial<Settings> }>().catch(() => undefined),
  ]);
  const tabs = Array.isArray(tabsDoc?.tabs)
    ? (tabsDoc.tabs as unknown[]).filter((t): t is TabRecord => {
        const r = t as Partial<TabRecord>;
        return typeof r?.id === "string" && typeof r.tool === "string" && tools.includes(r.tool) && typeof r.profileId === "string" && typeof r.kind === "string" && typeof r.title === "string" && typeof r.params === "object" && r.params !== null;
      })
        // Version 1 tabs (TSK-79) have no history: each gets its one step (DOC-21 §3.7).
        .map((t) => {
          const tab = migrateTab({ ...t, pinned: t.pinned === true });
          // A preview survives a reload (Open question 64 (h)); anything but true is a normal tab.
          if (tab.preview !== true) delete tab.preview;
          return tab;
        })
    : [];
  // Version 2 has no groups: they come in the order of each tool's first tab, the tabs keeping
  // their order inside a group (DOC-21 §3.2.1). Nothing is dropped.
  const saved = tabsDoc?.lastActive;
  const lastActive = typeof saved === "object" && saved !== null ? Object.fromEntries(Object.entries(saved).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  const requested = typeof tabsDoc?.activeTab === "string" && tabs.some((t) => t.id === tabsDoc.activeTab) ? tabsDoc.activeTab : null;
  const grouped = arrange(tabs, strings(tabsDoc?.groups).filter((g) => tools.includes(g)), lastActive, requested);
  const activeTab = requested ?? grouped.tabs[0]?.id ?? null;
  const s = settingsDoc?.settings ?? {};
  const sizes = layoutDoc?.shellSizes;
  return {
    tabs: grouped.tabs,
    activeTab,
    groups: grouped.groups,
    lastActive: grouped.lastActive,
    treeExpanded: Object.fromEntries(Object.entries(typeof treeDoc?.profiles === "object" && treeDoc.profiles !== null ? (treeDoc.profiles as Record<string, unknown>) : {}).map(([id, list]) => [id, strings(list)])),
    layout: {
      sidebarOpen: layoutDoc?.sidebarOpen !== false,
      shellSizes: Array.isArray(sizes) && sizes.length === 2 && sizes.every((n) => typeof n === "number") ? sizes : [24.45, 75.55],
      tool: typeof layoutDoc?.tool === "string" && tools.includes(layoutDoc.tool) ? layoutDoc.tool : (tools[0] ?? ""),
      navCollapsed: typeof layoutDoc?.navCollapsed === "boolean" ? layoutDoc.navCollapsed : null,
      pinnedTools: strings(layoutDoc?.pinnedTools).filter((id) => tools.includes(id)),
      closedCategories: strings(layoutDoc?.closedCategories),
    },
    settings: {
      preset: isPreset(s.preset) ? s.preset : DEFAULT_SETTINGS.preset,
      colorScheme: s.colorScheme === "light" || s.colorScheme === "dark" || s.colorScheme === "system" ? s.colorScheme : DEFAULT_SETTINGS.colorScheme,
      density: s.density === "compact" || s.density === "comfortable" ? s.density : DEFAULT_SETTINGS.density,
      editorFontSize: num(s.editorFontSize, DEFAULT_SETTINGS.editorFontSize, 9, 32),
      liveBuffer: num(s.liveBuffer, DEFAULT_SETTINGS.liveBuffer, 100, 1_000_000),
      logBuffer: num(s.logBuffer, DEFAULT_SETTINGS.logBuffer, 1000, 1_000_000),
      consumeLimit: num(s.consumeLimit, DEFAULT_SETTINGS.consumeLimit, 1, 100_000),
      historyOrder: s.historyOrder === "oldest" ? "oldest" : "newest",
    },
  };
}

// --- Provider ------------------------------------------------------------------------------------

interface StoreValue {
  state: State;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<StoreValue | null>(null);

/** The store when there is one (a tab rendered on its own, as in a test, has none). */
export function useStoreIfAny(): StoreValue | null {
  return useContext(StoreContext);
}

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
      void storage.putWorkspace("tabs", { version: TABS_VERSION, tabs: state.tabs, activeTab: state.activeTab, groups: state.groups, lastActive: state.lastActive }).catch(() => {});
      void storage.putWorkspace("layout", state.layout).catch(() => {});
      void storage.putWorkspace("tree", { version: 1, profiles: state.treeExpanded }).catch(() => {});
      void storage.putSettings({ version: SETTINGS_VERSION, settings: state.settings }).catch(() => {});
    }, saveDelayMs);
    return () => clearTimeout(timer);
  }, [state.tabs, state.activeTab, state.groups, state.lastActive, state.treeExpanded, state.layout, state.settings, storage, saveDelayMs]);
  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}
