// Application state (DBee spec §3): the connections and their live status, the schema cache, the
// query tabs with their runs, the open dialogs and the settings. One reducer, one context; what
// must survive a restart goes to the workspace through the WorkspaceSaver (workspace.ts).
import type { ArrowBatch, ArrowField } from "@byterygon/ambidex/arrow";
import { type Dispatch, type ReactNode, createContext, useContext, useEffect, useMemo, useReducer } from "react";
import type { AppInfo, ColumnInfo, ConnectionStatus, ConnectionSummary, ExecuteSummary, TableInfo } from "@/gen/api";
import type { Described } from "./messages";
import { DEFAULT_PERSISTED, type Persisted, type PersistedTab, type Settings } from "./persistence";
import type { WorkspaceProblem, WorkspaceSaver } from "./workspace";

export type RunStatus = "idle" | "running" | "done" | "error" | "cancelled";

export interface Run {
  status: RunStatus;
  startedAt: number;
  elapsedMs: number;
  fields: readonly ArrowField[];
  batches: ArrowBatch[];
  rows: number;
  summary?: ExecuteSummary;
  error?: Described;
  /** Rows kept when the run was cancelled or paused by the memory budget. */
  note?: string;
}

export interface Tab extends PersistedTab {
  /** The database session of this tab, opened lazily on the first run. */
  sessionId: string | null;
  /** The text changed since the last run. */
  modified: boolean;
  run: Run | null;
  /** Statements in the current selection or under the cursor, from the editor. */
  statementsInRun: number;
}

export interface SchemaNodeState<T> {
  loading: boolean;
  items?: readonly T[];
  error?: string;
}

export interface SchemaCache {
  schemas: SchemaNodeState<string>;
  tables: Record<string, SchemaNodeState<TableInfo>>;
  columns: Record<string, SchemaNodeState<ColumnInfo>>;
}

export type DialogState =
  | { kind: "none" }
  | { kind: "connection"; editId?: string; renew?: boolean }
  | { kind: "deleteConnection"; id: string }
  | { kind: "export"; tabId: string }
  | { kind: "settings" }
  | { kind: "about" }
  | { kind: "shortcuts" }
  | { kind: "confirmDestructive"; tabId: string; sql: string; statementKind: string }
  | { kind: "password"; connectionId: string; then: "connect" | "run" };

export interface State extends Persisted {
  info: AppInfo | null;
  connections: ConnectionSummary[] | null;
  connectionsError: Described | null;
  statuses: Record<string, ConnectionStatus>;
  connectError: Record<string, Described | undefined>;
  schema: Record<string, SchemaCache>;
  tabsRuntime: Record<string, Pick<Tab, "sessionId" | "modified" | "run" | "statementsInRun">>;
  selectedNode: string | null;
  dialog: DialogState;
  paletteOpen: boolean;
  /** The pane with focus, for F6. */
  pane: "tree" | "editor" | "results";
  /** Why tabs and settings are not being saved, if they are not. */
  workspaceProblem: WorkspaceProblem | null;
}

export type Action =
  | { type: "info"; info: AppInfo }
  | { type: "connections"; connections: ConnectionSummary[] }
  | { type: "connectionsError"; error: Described }
  | { type: "status"; id: string; status: ConnectionStatus }
  | { type: "connectError"; id: string; error: Described | undefined }
  | { type: "schemaLoading"; connectionId: string; key: string }
  | { type: "schemas"; connectionId: string; items?: string[]; error?: string }
  | { type: "tables"; connectionId: string; schema: string; items?: TableInfo[]; error?: string }
  | { type: "columns"; connectionId: string; key: string; items?: ColumnInfo[]; error?: string }
  | { type: "schemaForget"; connectionId: string }
  | { type: "openTab"; tab: PersistedTab }
  | { type: "closeTab"; id: string }
  | { type: "activateTab"; id: string }
  | { type: "reorderTab"; id: string; index: number }
  | { type: "editTab"; id: string; sql?: string; connectionId?: string | null; maxRows?: number | null; statementsInRun?: number }
  | { type: "session"; id: string; sessionId: string | null }
  | { type: "run"; id: string; run: Run | null }
  | { type: "select"; nodeId: string | null }
  | { type: "dialog"; dialog: DialogState }
  | { type: "palette"; open: boolean }
  | { type: "pane"; pane: State["pane"] }
  | { type: "sizes"; shellSizes?: number[]; splitSizes?: number[] }
  | { type: "sidebar"; open: boolean }
  | { type: "settings"; settings: Partial<Settings> }
  | { type: "workspaceProblem"; problem: WorkspaceProblem | null };

export const emptyCache = (): SchemaCache => ({ schemas: { loading: false }, tables: {}, columns: {} });

let counter = 0;
export const newId = (): string => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "info":
      return { ...state, info: action.info };
    case "connections": {
      const statuses = { ...state.statuses };
      for (const c of action.connections) statuses[c.id] ??= c.status;
      return { ...state, connections: action.connections, connectionsError: null, statuses };
    }
    case "connectionsError":
      return { ...state, connectionsError: action.error };
    case "status":
      return { ...state, statuses: { ...state.statuses, [action.id]: action.status } };
    case "connectError":
      return { ...state, connectError: { ...state.connectError, [action.id]: action.error } };
    case "schemaLoading": {
      const cache = state.schema[action.connectionId] ?? emptyCache();
      const next: SchemaCache = action.key === "" ? { ...cache, schemas: { ...cache.schemas, loading: true } } : action.key.startsWith("t:") ? { ...cache, tables: { ...cache.tables, [action.key.slice(2)]: { ...cache.tables[action.key.slice(2)], loading: true } } } : { ...cache, columns: { ...cache.columns, [action.key]: { ...cache.columns[action.key], loading: true } } };
      return { ...state, schema: { ...state.schema, [action.connectionId]: next } };
    }
    case "schemas": {
      const cache = state.schema[action.connectionId] ?? emptyCache();
      const node: SchemaNodeState<string> = { loading: false, ...(action.items ? { items: action.items } : {}), ...(action.error ? { error: action.error } : {}) };
      return { ...state, schema: { ...state.schema, [action.connectionId]: { ...cache, schemas: node } } };
    }
    case "tables": {
      const cache = state.schema[action.connectionId] ?? emptyCache();
      const node: SchemaNodeState<TableInfo> = { loading: false, ...(action.items ? { items: action.items } : {}), ...(action.error ? { error: action.error } : {}) };
      return { ...state, schema: { ...state.schema, [action.connectionId]: { ...cache, tables: { ...cache.tables, [action.schema]: node } } } };
    }
    case "columns": {
      const cache = state.schema[action.connectionId] ?? emptyCache();
      const node: SchemaNodeState<ColumnInfo> = { loading: false, ...(action.items ? { items: action.items } : {}), ...(action.error ? { error: action.error } : {}) };
      return { ...state, schema: { ...state.schema, [action.connectionId]: { ...cache, columns: { ...cache.columns, [action.key]: node } } } };
    }
    case "schemaForget": {
      const schema = { ...state.schema };
      delete schema[action.connectionId];
      return { ...state, schema };
    }
    case "openTab":
      return { ...state, tabs: [...state.tabs, action.tab], activeTab: action.tab.id, tabsRuntime: { ...state.tabsRuntime, [action.tab.id]: { sessionId: null, modified: false, run: null, statementsInRun: 1 } } };
    case "closeTab": {
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      const runtime = { ...state.tabsRuntime };
      delete runtime[action.id];
      const activeTab = state.activeTab === action.id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : state.activeTab;
      return { ...state, tabs, activeTab, tabsRuntime: runtime };
    }
    case "activateTab":
      return state.tabs.some((t) => t.id === action.id) ? { ...state, activeTab: action.id } : state;
    case "reorderTab": {
      const from = state.tabs.findIndex((t) => t.id === action.id);
      if (from < 0) return state;
      const tabs = [...state.tabs];
      const [tab] = tabs.splice(from, 1);
      tabs.splice(Math.max(0, Math.min(action.index, tabs.length)), 0, tab!);
      return { ...state, tabs };
    }
    case "editTab": {
      const tabs = state.tabs.map((t) => (t.id === action.id ? { ...t, ...(action.sql !== undefined ? { sql: action.sql } : {}), ...(action.connectionId !== undefined ? { connectionId: action.connectionId } : {}), ...(action.maxRows !== undefined ? { maxRows: action.maxRows } : {}) } : t));
      const current = state.tabsRuntime[action.id];
      if (!current) return { ...state, tabs };
      const changedConnection = action.connectionId !== undefined && action.connectionId !== state.tabs.find((t) => t.id === action.id)?.connectionId;
      return {
        ...state,
        tabs,
        tabsRuntime: {
          ...state.tabsRuntime,
          [action.id]: {
            ...current,
            ...(action.sql !== undefined && current.run !== null ? { modified: true } : {}),
            ...(action.statementsInRun !== undefined ? { statementsInRun: action.statementsInRun } : {}),
            ...(changedConnection ? { sessionId: null } : {}),
          },
        },
      };
    }
    case "session": {
      const current = state.tabsRuntime[action.id];
      return current ? { ...state, tabsRuntime: { ...state.tabsRuntime, [action.id]: { ...current, sessionId: action.sessionId } } } : state;
    }
    case "run": {
      const current = state.tabsRuntime[action.id];
      return current ? { ...state, tabsRuntime: { ...state.tabsRuntime, [action.id]: { ...current, run: action.run, modified: false } } } : state;
    }
    case "select":
      return { ...state, selectedNode: action.nodeId };
    case "dialog":
      return { ...state, dialog: action.dialog };
    case "palette":
      return { ...state, paletteOpen: action.open };
    case "pane":
      return { ...state, pane: action.pane };
    case "sizes":
      return { ...state, ...(action.shellSizes ? { shellSizes: action.shellSizes } : {}), ...(action.splitSizes ? { splitSizes: action.splitSizes } : {}) };
    case "sidebar":
      return { ...state, sidebarOpen: action.open };
    case "settings":
      return { ...state, settings: { ...state.settings, ...action.settings, confirmDestructive: true } };
    case "workspaceProblem":
      return { ...state, workspaceProblem: action.problem };
  }
}

export function initialState(persisted: Persisted): State {
  const tabsRuntime: State["tabsRuntime"] = {};
  for (const tab of persisted.tabs) tabsRuntime[tab.id] = { sessionId: null, modified: false, run: null, statementsInRun: 1 };
  return {
    ...persisted,
    info: null,
    connections: null,
    connectionsError: null,
    statuses: {},
    connectError: {},
    schema: {},
    tabsRuntime,
    selectedNode: null,
    dialog: { kind: "none" },
    paletteOpen: false,
    pane: "editor",
    workspaceProblem: null,
  };
}

export const StoreContext = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);

export function useStore(): { state: State; dispatch: Dispatch<Action> } {
  const store = useContext(StoreContext);
  if (store === null) throw new Error("StoreContext is missing");
  return store;
}

/** A tab with its runtime, or undefined. */
export function tabOf(state: State, id: string | null): Tab | undefined {
  if (id === null) return undefined;
  const tab = state.tabs.find((t) => t.id === id);
  const runtime = state.tabsRuntime[id];
  return tab && runtime ? { ...tab, ...runtime } : undefined;
}

/** The store; with a `saver`, every change of the persisted part is handed to it. */
export function StoreProvider({ children, persisted = DEFAULT_PERSISTED, saver }: { children: ReactNode; persisted?: Persisted; saver?: WorkspaceSaver }) {
  const [state, dispatch] = useReducer(reducer, persisted, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  const { tabs, activeTab, shellSizes, splitSizes, sidebarOpen, settings } = state;
  useEffect(() => saver?.subscribe((problem) => dispatch({ type: "workspaceProblem", problem })), [saver]);
  useEffect(() => {
    saver?.schedule({ tabs, activeTab, shellSizes, splitSizes, sidebarOpen, settings });
  }, [saver, tabs, activeTab, shellSizes, splitSizes, sidebarOpen, settings]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
