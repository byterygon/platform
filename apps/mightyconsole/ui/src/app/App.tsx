// The shell (Mightyconsole spec §3.1, on DBee's Fluent 2 shell of TSK-64): the window paints the
// backdrop; a title area with the sidebar toggle, the app mark, the tabs as a Fluent TabList, the
// command search, Settings and Help; below it the tool rail, the sidebar layer (the selected
// tool's connection list) and the tab layer (a command bar, then the screen); a status bar. The
// command palette is the menu. Every action of spec §3.4 is here with its binding.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CommandPalette, type CommandGroup } from "@/components/ui/command-palette";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Sidebar, SidebarContent, SidebarHeader, SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { StatusBar, StatusBarButton, StatusBarItem, StatusBarSpacer } from "@/components/ui/status-bar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toast, useToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AppEvent } from "@/gen/api";
import { cn } from "@/lib/cn";
import { layerSurface } from "@/lib/control";
import { Add, ArrowImport, Info, Options, QuestionCircle, Search, Server, Settings as SettingsIcon, Window } from "@/lib/icons";
import { loadProfiles } from "@/profiles/migrate";
import type { ProfileRecord } from "@/profiles/record";
import { applyImport, exportFile, exportFileName, type ImportPlan, planImport } from "@/profiles/transfer";
import { TOOLS, toolById } from "@/tools/registry";
import type { DescribedError, LiveState, ResourceNode, TabActionHandlers, TabProps, TabRecord, ToolModule } from "@/tools/types";
import { useServices } from "./client";
import { AboutDialog, ShortcutsDialog } from "./dialogs/InfoDialogs";
import { CloseTabDialog, DeleteProfileDialog, ExportDialog, ImportDialog, ProfileSheet } from "./dialogs/ProfileDialogs";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { describeError } from "./messages";
import { applyAppearance, followSystemScheme } from "./presets";
import { ACTIONS, type ActionId, actionFor, bindingOf, inTextControl } from "./shortcuts";
import { ConnectionList, parseNode, profileNodeId } from "./sidebar/ConnectionList";
import { DisconnectedState, ErrorState, liveText } from "./states";
import { type ConnState, tabIdOf, useStore } from "./store";
import { Supervisor } from "./supervisor";

/** A resize handle in the gap between two layers (TSK-64). */
const gapHandle =
  "bg-transparent hover:bg-transparent focus-visible:bg-transparent data-dragging:bg-transparent data-[orientation=horizontal]:w-gap-sm data-[orientation=vertical]:h-gap-sm hover:[&>span]:bg-border-focus data-dragging:[&>span]:bg-border-focus";

const PANES = ["rail", "sidebar", "tab"] as const;

/** After this long, "Connecting…" says what it is still waiting for and offers Cancel (spec §3.5). */
export const SLOW_CONNECT_MS = 10_000;

export interface AppProps {
  tools?: readonly ToolModule[];
}

export function App({ tools = TOOLS }: AppProps) {
  return (
    <Toast placement="bottom-end">
      <Shell tools={tools} />
    </Toast>
  );
}

const DISCONNECTED: ConnState = { status: "disconnected", connId: null };

function Shell({ tools }: { tools: readonly ToolModule[] }) {
  const services = useServices();
  const { client, storage } = services;
  const { state, dispatch } = useStore();
  const toast = useToast();
  const stateRef = useRef(state);
  stateRef.current = state;
  const tool = toolById(tools, state.layout.tool) ?? tools[0]!;
  const profiles = state.profiles ?? [];
  const profileById = (id: string) => stateRef.current.profiles?.find((p) => p.id === id);
  const connOf = (id: string): ConnState => stateRef.current.conns[id] ?? DISCONNECTED;
  const activeTab = state.tabs.find((t) => t.id === state.activeTab) ?? null;
  const activeProfile = activeTab ? profiles.find((p) => p.id === activeTab.profileId) : state.selectedNode ? profiles.find((p) => p.id === parseNode(state.selectedNode!)?.profileId) : undefined;
  const tabActions = useRef(new Map<string, () => TabActionHandlers>());
  const supervisor = useRef<Supervisor | null>(null);
  const [focusPane, setFocusPane] = useState(0);

  const note = useCallback(
    (error: unknown): DescribedError => {
      const d = describeError(error);
      if (d.correlationId) dispatch({ type: "diagnostic", line: `${new Date().toISOString()} ${d.code ?? ""} ${d.correlationId} ${d.title}` });
      return d;
    },
    [dispatch],
  );

  // Appearance follows the settings and the OS.
  const { preset, colorScheme, density } = state.settings;
  useEffect(() => applyAppearance({ preset, colorScheme, density }), [preset, colorScheme, density]);
  useEffect(() => followSystemScheme(() => ({ preset, colorScheme, density })), [preset, colorScheme, density]);

  // --- Profiles ---------------------------------------------------------------------------------

  const schemaOf = useCallback((id: string) => toolById(tools, id)?.profile, [tools]);
  const reloadProfiles = useCallback(async () => {
    try {
      const loaded = await loadProfiles(storage, schemaOf);
      dispatch({ type: "profiles", profiles: loaded.records, recordStates: loaded.states });
      return loaded;
    } catch (e) {
      const d = note(e);
      toast.add({ title: "Could not read the profiles", description: d.title, type: "danger", timeout: 0 });
      dispatch({ type: "profiles", profiles: [] });
      return null;
    }
  }, [storage, schemaOf, dispatch, note, toast]);

  useEffect(() => {
    void reloadProfiles().then((loaded) => {
      if (loaded && loaded.migrated > 0) toast.add({ title: `Updated ${loaded.migrated} profile${loaded.migrated === 1 ? "" : "s"} to this version`, description: "The previous versions are kept until the next start.", type: "info" });
    });
    // A store opened in memory on purpose (tests) has no reason and no warning.
    if (storage.kind === "memory" && storage.fallbackReason !== null) {
      toast.add({
        title: "Profiles are not saved in this browser",
        description: `IndexedDB is unavailable (${storage.fallbackReason ?? "unknown reason"}): profiles, tabs and settings last until this page closes. Export what you add.`,
        type: "warning",
        timeout: 0,
        priority: "high",
      });
    }
    return storage.onExternalChange(() => void reloadProfiles());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage]);

  const saveProfile = async (record: ProfileRecord) => {
    await storage.putProfile(record);
    storage.announce();
    await reloadProfiles();
  };

  // --- Connections ------------------------------------------------------------------------------

  const connectProfile = useCallback(
    async (profileId: string): Promise<boolean> => {
      const profile = profileById(profileId);
      const t = profile ? toolById(tools, profile.tool) : undefined;
      if (!profile || !t) return false;
      const current = connOf(profileId);
      if (current.status === "connected") return true;
      if (current.status === "connecting") return false;
      dispatch({ type: "conn", profileId, conn: { status: "connecting", connId: null, since: Date.now() } });
      try {
        const { connId } = await t.connect(client, profile);
        // Cancelled while it was connecting: release what arrived.
        if (connOf(profileId).status !== "connecting") {
          void t.disconnect(client, connId).catch(() => {});
          return false;
        }
        dispatch({ type: "conn", profileId, conn: { status: "connected", connId } });
        return true;
      } catch (e) {
        const error = note(e);
        if (connOf(profileId).status === "connecting") dispatch({ type: "conn", profileId, conn: { status: "failed", connId: null, error } });
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, tools, dispatch, note],
  );

  const disconnectProfile = (profileId: string) => {
    const conn = connOf(profileId);
    const profile = profileById(profileId);
    const t = profile ? toolById(tools, profile.tool) : undefined;
    dispatch({ type: "conn", profileId, conn: DISCONNECTED });
    if (conn.connId && t) void t.disconnect(client, conn.connId).catch(note);
  };

  const handleEvent = (event: AppEvent) => {
    if (event.kind === "StreamProgress") return services.progress.publish(event);
    if (event.kind !== "ConnectionStatus") return;
    const entry = Object.entries(stateRef.current.conns).find(([, c]) => c.connId === event.connId);
    if (!entry) return;
    const [profileId, conn] = entry;
    switch (event.status) {
      case "closed":
        dispatch({ type: "conn", profileId, conn: { status: "disconnected", connId: null, ...(event.message ? { message: event.message } : {}) } });
        if (event.message) toast.add({ title: `${profileById(profileId)?.name ?? "A connection"} was closed`, description: event.message, type: "info" });
        break;
      case "reconnecting":
        dispatch({ type: "conn", profileId, conn: { ...conn, status: "reconnecting", ...(event.message ? { message: event.message } : {}) } });
        break;
      case "connected":
        dispatch({ type: "conn", profileId, conn: { ...conn, status: "connected" } });
        break;
      case "failed":
        dispatch({ type: "conn", profileId, conn: { status: "failed", connId: null, error: { title: event.message ?? "The connection failed" } } });
        break;
      case "connecting":
        break;
    }
  };

  /** After the server came back: connect every profile that was connected again (spec §2.2). */
  const reconnectAll = () => {
    const ids = Object.entries(stateRef.current.conns)
      .filter(([, c]) => c.status !== "disconnected" && c.status !== "failed")
      .map(([id]) => id);
    for (const id of ids) dispatch({ type: "conn", profileId: id, conn: DISCONNECTED });
    for (const id of ids) void connectProfile(id);
  };

  // The server connection: info, events, the overlay while it is lost.
  useEffect(() => {
    const sup = new Supervisor(client, {
      status: (status) => {
        dispatch({ type: "server", status });
        if (status === "lost") dispatch({ type: "connsReset", status: "reconnecting", message: "the server connection was lost" });
      },
      info: (info) => dispatch({ type: "info", info }),
      event: handleEvent,
      reconnected: reconnectAll,
    });
    supervisor.current = sup;
    void sup.run();
    return () => sup.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Handles are released when the page goes away (best effort; the server also releases them
  // when the WebSocket closes).
  useEffect(() => {
    const release = () => {
      for (const [profileId, conn] of Object.entries(stateRef.current.conns)) {
        const t = toolById(tools, profileById(profileId)?.tool ?? "");
        if (conn.connId && t) void t.disconnect(client, conn.connId).catch(() => {});
      }
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tools]);

  // A restored or focused tab whose profile is disconnected connects (spec §3.2).
  const autoConnected = useRef(new Set<string>());
  useEffect(() => {
    if (!activeTab || state.server !== "online" || state.profiles === null) return;
    const key = `${activeTab.id}`;
    if (autoConnected.current.has(key)) return;
    autoConnected.current.add(key);
    if (connOf(activeTab.profileId).status === "disconnected") void connectProfile(activeTab.profileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, state.server, state.profiles]);

  // --- Tabs -------------------------------------------------------------------------------------

  const openResource = (profileId: string, node: ResourceNode) => {
    const profile = profileById(profileId);
    if (!profile || !node.open) return;
    const id = tabIdOf(profile.tool, profileId, node.open.kind, node.open.params);
    dispatch({ type: "openTab", tab: { id, tool: profile.tool, profileId, kind: node.open.kind, params: node.open.params, title: node.open.title, pinned: false } });
  };

  const closeTab = (id: string, force = false) => {
    const live = stateRef.current.live[id];
    if (!force && live && live.status !== "ended") {
      dispatch({ type: "dialog", dialog: { kind: "closeTab", id } });
      return;
    }
    tabActions.current.get(id)?.().stop?.();
    autoConnected.current.delete(id);
    dispatch({ type: "closeTab", id });
  };

  const useTabActionsFor = useCallback(
    (tabId: string) =>
      function useTabActions(handlers: TabActionHandlers) {
        const latest = useRef(handlers);
        latest.current = handlers;
        useEffect(() => {
          tabActions.current.set(tabId, () => latest.current);
          return () => {
            tabActions.current.delete(tabId);
          };
        }, []);
      },
    [],
  );
  const tabHooks = useRef(new Map<string, (h: TabActionHandlers) => void>());
  const hookFor = (tabId: string) => {
    let hook = tabHooks.current.get(tabId);
    if (!hook) {
      hook = useTabActionsFor(tabId);
      tabHooks.current.set(tabId, hook);
    }
    return hook;
  };
  const liveSetters = useRef(new Map<string, (live: LiveState | null) => void>());
  const liveFor = (tabId: string) => {
    let set = liveSetters.current.get(tabId);
    if (!set) {
      set = (live) => dispatch({ type: "live", id: tabId, live });
      liveSetters.current.set(tabId, set);
    }
    return set;
  };

  // --- Actions ----------------------------------------------------------------------------------

  const switchTool = (index: number) => {
    const t = tools[index];
    if (t) dispatch({ type: "layout", layout: { tool: t.id } });
  };

  const cyclePanes = (back: boolean) => {
    const order = PANES;
    const current = document.activeElement?.closest<HTMLElement>("[data-pane]")?.dataset["pane"];
    const i = order.indexOf((current as (typeof PANES)[number]) ?? "tab");
    const next = order[(i + (back ? order.length - 1 : 1)) % order.length]!;
    const el = document.querySelector<HTMLElement>(`[data-pane="${next}"]`);
    (el?.querySelector<HTMLElement>("[role=tree], [role=tab][aria-selected=true], button:not([disabled]), input, [tabindex='0']") ?? el)?.focus();
    setFocusPane((n) => n + 1);
  };

  const exportIds = (ids: string[] | null) => dispatch({ type: "dialog", dialog: { kind: "export", ids } });

  const perform = (id: ActionId) => {
    const handlers = state.activeTab ? tabActions.current.get(state.activeTab)?.() : undefined;
    switch (id) {
      case "palette":
        dispatch({ type: "palette", open: !state.paletteOpen });
        break;
      case "tool1":
      case "tool2":
      case "tool3":
      case "tool4":
      case "tool5":
      case "tool6":
        switchTool(Number(id.slice(4)) - 1);
        break;
      case "addConnection":
        dispatch({ type: "dialog", dialog: { kind: "profile", tool: tool.id } });
        break;
      case "exportProfiles":
        exportIds(null);
        break;
      case "importProfiles":
        dispatch({ type: "dialog", dialog: { kind: "import" } });
        break;
      case "closeTab":
        if (state.activeTab) closeTab(state.activeTab);
        break;
      case "nextTab":
      case "prevTab": {
        if (state.tabs.length === 0) break;
        const i = state.tabs.findIndex((t) => t.id === state.activeTab);
        const next = state.tabs[(i + (id === "nextTab" ? 1 : state.tabs.length - 1)) % state.tabs.length]!;
        dispatch({ type: "activateTab", id: next.id });
        break;
      }
      case "primary":
        handlers?.primary?.();
        break;
      case "stop":
        handlers?.stop?.();
        break;
      case "pause":
        handlers?.pause?.();
        break;
      case "clear":
        handlers?.clear?.();
        break;
      case "find":
        handlers?.find?.();
        break;
      case "refresh":
        if (handlers?.refresh) handlers.refresh();
        else if (activeProfile && connOf(activeProfile.id).status === "failed") void connectProfile(activeProfile.id);
        break;
      case "focusSidebar":
        if (!state.layout.sidebarOpen) dispatch({ type: "layout", layout: { sidebarOpen: true } });
        requestAnimationFrame(() => (document.querySelector<HTMLElement>("[data-pane='sidebar'] [role=tree]") ?? document.querySelector<HTMLElement>("[data-pane='sidebar'] button"))?.focus());
        break;
      case "nextPane":
        cyclePanes(false);
        break;
      case "prevPane":
        cyclePanes(true);
        break;
      case "toggleSidebar":
        dispatch({ type: "layout", layout: { sidebarOpen: !state.layout.sidebarOpen } });
        break;
      case "settings":
        dispatch({ type: "dialog", dialog: { kind: "settings" } });
        break;
      case "shortcuts":
        dispatch({ type: "dialog", dialog: { kind: "shortcuts" } });
        break;
      case "about":
        dispatch({ type: "dialog", dialog: { kind: "about" } });
        break;
    }
  };

  // Global shortcuts (spec §3.4). Text controls keep Mod+F; Mod+Enter goes to the tab.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const action = actionFor(event);
      if (!action) return;
      if (state.dialog.kind !== "none" || state.paletteOpen) return;
      const inText = inTextControl(event.target);
      if (action.id === "find" && (inText || !state.activeTab)) return;
      if (action.id === "stop" && !(state.activeTab && state.live[state.activeTab]?.status !== "ended" && state.live[state.activeTab])) return;
      event.preventDefault();
      perform(action.id);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  });

  // --- Palette ----------------------------------------------------------------------------------

  const paletteGroups: CommandGroup[] = useMemo(() => {
    type Item = CommandGroup["items"][number];
    const goTo: Item[] = [];
    const actions: Item[] = [];
    const connections: Item[] = [];
    const app: Item[] = [];
    for (const [i, t] of tools.entries()) {
      goTo.push({ id: `tool:${t.id}`, label: `Tool: ${t.label}`, shortcut: i < 6 ? bindingOf(`tool${i + 1}` as ActionId) : "", keywords: [t.id], onSelect: () => switchTool(i) });
    }
    for (const p of profiles) {
      const t = toolById(tools, p.tool);
      const conn = state.conns[p.id];
      if (!t || conn?.status !== "connected" || !conn.connId) continue;
      const walk = (nodes: readonly ResourceNode[]) => {
        for (const n of nodes) {
          if (n.open) goTo.push({ id: `res:${p.id}/${n.id}`, label: n.open.title, keywords: [p.name, t.label], onSelect: () => openResource(p.id, n) });
          if (n.children) walk(n.children);
        }
      };
      walk(t.sidebarTree({ profile: p, connId: conn.connId }));
    }
    for (const tab of state.tabs) goTo.push({ id: `tab:${tab.id}`, label: `Tab: ${tab.title}`, onSelect: () => dispatch({ type: "activateTab", id: tab.id }) });
    for (const a of ACTIONS) {
      if (a.id === "palette") continue;
      const toolIndex = a.id.startsWith("tool") ? Number(a.id.slice(4)) - 1 : -1;
      const label = toolIndex >= 0 ? (tools[toolIndex] ? `Switch to ${tools[toolIndex]!.label}` : `${a.label} (no tool)`) : a.label;
      const item: Item = {
        id: a.id,
        label,
        shortcut: bindingOf(a.id),
        ...(a.keywords ? { keywords: a.keywords } : {}),
        disabled: (toolIndex >= 0 && !tools[toolIndex]) || ((a.group === "Live views" || a.id === "primary" || a.id === "closeTab") && !state.activeTab),
        onSelect: () => perform(a.id),
      };
      if (a.group === "App") app.push(item);
      else if (a.group === "Connections") connections.push(item);
      else actions.push(item);
    }
    for (const p of profiles) {
      const t = toolById(tools, p.tool);
      if (!t) continue;
      const conn = state.conns[p.id] ?? DISCONNECTED;
      if (conn.status === "connected" || conn.status === "connecting") connections.push({ id: `disconnect:${p.id}`, label: `Disconnect ${t.label}: ${p.name}`, onSelect: () => disconnectProfile(p.id) });
      else connections.push({ id: `connect:${p.id}`, label: `Connect ${t.label}: ${p.name}`, keywords: [t.id], onSelect: () => void connectProfile(p.id) });
      if (conn.status === "connected" && conn.connId) {
        for (const ta of t.actions) actions.push({ id: `action:${p.id}:${ta.id}`, label: `${ta.label} (${p.name})`, ...(ta.keywords ? { keywords: ta.keywords } : {}), onSelect: () => void ta.run({ client, profile: p, connId: conn.connId! }) });
      }
    }
    for (const t of tools) connections.push({ id: `add:${t.id}`, label: `Add ${t.label} connection`, onSelect: () => dispatch({ type: "dialog", dialog: { kind: "profile", tool: t.id } }) });
    return [
      { label: "Go to", items: goTo },
      { label: "Actions", items: actions },
      { label: "Connections", items: connections },
      { label: "App", items: app },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools, profiles, state.conns, state.tabs, state.activeTab, client]);

  // --- Dialog helpers ---------------------------------------------------------------------------

  const dialog = state.dialog;
  const closeDialog = () => dispatch({ type: "dialog", dialog: { kind: "none" } });
  const profileDialog = dialog.kind === "profile" ? dialog : null;
  const sheetTool = profileDialog ? (toolById(tools, profileDialog.tool) ?? tool) : tool;
  const sheetBase = profileDialog?.editId ? profiles.find((p) => p.id === profileDialog.editId) : profileDialog?.duplicateOf ? profiles.find((p) => p.id === profileDialog.duplicateOf) : undefined;
  const sheetMode = profileDialog?.editId ? "edit" : profileDialog?.duplicateOf ? "duplicate" : "add";
  const takenNames = new Set(profiles.filter((p) => p.tool === sheetTool.id && !(sheetMode === "edit" && p.id === sheetBase?.id)).map((p) => p.name));
  const exportCount = dialog.kind === "export" ? (dialog.ids ?? profiles.map((p) => p.id)).length : 0;
  const deleting = dialog.kind === "deleteProfile" ? profiles.find((p) => p.id === dialog.id) : undefined;
  const closing = dialog.kind === "closeTab" ? state.tabs.find((t) => t.id === dialog.id) : undefined;

  const doExport = (includeSecrets: boolean) => {
    if (dialog.kind !== "export") return;
    const ids = new Set(dialog.ids ?? profiles.map((p) => p.id));
    const file = exportFile(
      profiles.filter((p) => ids.has(p.id)),
      { includeSecrets, app: state.info?.version ?? "0.1.0" },
    );
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeDialog();
    toast.add({ title: `Exported ${ids.size} profile${ids.size === 1 ? "" : "s"}`, description: includeSecrets ? "The file holds secrets in plain text." : "Secrets were left out.", type: "success" });
  };

  const doImport = async (plan: ImportPlan) => {
    const stored = await storage.listProfiles();
    const { writes, deletes } = applyImport(plan, stored);
    for (const id of deletes) await storage.deleteProfile(id);
    for (const record of writes) await storage.putProfile(record);
    storage.announce();
    await reloadProfiles();
    closeDialog();
    toast.add({ title: `Imported ${writes.length} profile${writes.length === 1 ? "" : "s"}`, type: "success" });
  };

  const doDelete = async (id: string) => {
    disconnectProfile(id);
    for (const t of stateRef.current.tabs) if (t.profileId === id) closeTab(t.id, true);
    await storage.deleteProfile(id);
    storage.announce();
    await reloadProfiles();
    closeDialog();
  };

  // --- Render -----------------------------------------------------------------------------------

  const activeConn = activeProfile ? (state.conns[activeProfile.id] ?? DISCONNECTED) : null;
  const activeLive = state.activeTab ? state.live[state.activeTab] : null;
  const anyConnected = (t: ToolModule) => profiles.some((p) => p.tool === t.id && state.conns[p.id]?.status === "connected");

  return (
    <SidebarProvider open={state.layout.sidebarOpen} onOpenChange={(open) => dispatch({ type: "layout", layout: { sidebarOpen: open } })} className="h-full">
      <Tabs value={state.activeTab ?? ""} onValueChange={(v) => dispatch({ type: "activateTab", id: String(v) })} size="medium" className="mc-root flex h-full min-h-0 w-full flex-col gap-0 text-fg">
        <header className="flex shrink-0 items-center gap-inline-md py-inset-xs ps-inset-xs pe-inset-sm" aria-label="Title area">
          <SidebarTrigger />
          <span className="flex shrink-0 items-center gap-inline-md pe-inline-lg text-body-1-strong">
            <Icon icon={Server} filled size="lg" tone="accent" />
            Mightyconsole
          </span>
          {state.tabs.length > 0 ? (
            <TabsList aria-label="Tabs" onReorder={(value, index) => dispatch({ type: "reorderTab", id: String(value), index })} className="min-w-0 border-b-0">
              {state.tabs.map((t) => {
                const live = state.live[t.id];
                const conn = state.conns[t.profileId];
                const icon =
                  conn?.status === "connecting" ? (
                    <Spinner size="sm" label="Connecting" />
                  ) : conn?.status === "failed" ? (
                    <span role="img" aria-label="error" className="size-icon-xs rounded-full bg-danger" />
                  ) : live?.status === "live" ? (
                    <span role="img" aria-label="live" className="size-icon-xs rounded-full bg-success" />
                  ) : undefined;
                return (
                  <TabsTrigger key={t.id} value={t.id} icon={icon} onClose={() => closeTab(t.id)} onAuxClick={(e) => e.button === 1 && closeTab(t.id)}>
                    {t.title}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          ) : null}
          <span className="flex-1" />
          <Button appearance="secondary" className="w-panel-xs justify-start font-normal text-fg-muted" aria-haspopup="dialog" onClick={() => dispatch({ type: "palette", open: true })}>
            <Icon icon={Search} />
            <span className="flex-1 text-start">Search commands</span>
            <Kbd>{bindingOf("palette")}</Kbd>
          </Button>
          <Tooltip>
            <TooltipTrigger render={<IconButton aria-label="Settings" onClick={() => perform("settings")} />}>
              <Icon icon={SettingsIcon} />
            </TooltipTrigger>
            <TooltipContent>Settings ({bindingOf("settings")})</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<IconButton aria-label="Keyboard shortcuts" onClick={() => perform("shortcuts")} />}>
              <Icon icon={QuestionCircle} />
            </TooltipTrigger>
            <TooltipContent>Keyboard shortcuts ({bindingOf("shortcuts")})</TooltipContent>
          </Tooltip>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Tools" data-pane="rail" className="flex w-control-xl shrink-0 flex-col items-center gap-stack-xs pb-inset-xs">
            {tools.map((t, i) => (
              <Tooltip key={t.id}>
                <TooltipTrigger
                  render={
                    <IconButton
                      aria-label={t.label}
                      aria-pressed={t.id === tool.id}
                      appearance={t.id === tool.id ? "secondary" : "subtle"}
                      className="relative"
                      onClick={() => dispatch({ type: "layout", layout: { tool: t.id } })}
                    />
                  }
                >
                  <Icon icon={t.icon} filled={t.id === tool.id} />
                  {anyConnected(t) ? <span role="img" aria-label="connected" className="absolute inset-e-0 top-0 size-icon-xs rounded-full border-2 border-bg-canvas bg-success" /> : null}
                </TooltipTrigger>
                <TooltipContent>
                  {t.label}
                  {i < 6 ? ` (${bindingOf(`tool${i + 1}` as ActionId)})` : ""}
                </TooltipContent>
              </Tooltip>
            ))}
            <span className="flex-1" />
            <Tooltip>
              <TooltipTrigger render={<IconButton aria-label="About Mightyconsole" appearance="subtle" onClick={() => perform("about")} />}>
                <Icon icon={Info} />
              </TooltipTrigger>
              <TooltipContent>About</TooltipContent>
            </Tooltip>
          </nav>
          <Resizable orientation="horizontal" sizes={state.layout.sidebarOpen ? state.layout.shellSizes : [0, 100]} onSizesChange={(sizes) => state.layout.sidebarOpen && dispatch({ type: "layout", layout: { shellSizes: sizes } })} className="min-h-0 flex-1 pe-gap-sm" aria-label="Sidebar and workspace">
            <ResizablePanel minSize={state.layout.sidebarOpen ? 12 : 0} maxSize={state.layout.sidebarOpen ? 50 : 0}>
              <Sidebar aria-label={`${tool.label} connections`} collapsible="offcanvas" className="h-full w-full rounded-lg border shadow-layer" data-pane="sidebar">
                <SidebarHeader className="flex-row items-center justify-between py-inset-xs pe-inset-xs">
                  <span className="text-body-1-strong">{tool.label}</span>
                  <span className="flex items-center">
                    <Tooltip>
                      <TooltipTrigger render={<IconButton aria-label="Import profiles" onClick={() => perform("importProfiles")} />}>
                        <Icon icon={ArrowImport} />
                      </TooltipTrigger>
                      <TooltipContent>Import profiles</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger render={<IconButton aria-label="Add connection" onClick={() => perform("addConnection")} />}>
                        <Icon icon={Add} />
                      </TooltipTrigger>
                      <TooltipContent>Add connection ({bindingOf("addConnection")})</TooltipContent>
                    </Tooltip>
                  </span>
                </SidebarHeader>
                <SidebarContent className="min-h-0 flex-1 p-0">
                  <ConnectionList
                    tool={tool}
                    profiles={state.profiles === null ? null : profiles.filter((p) => p.tool === tool.id)}
                    recordStates={state.recordStates}
                    conns={state.conns}
                    selected={state.selectedNode}
                    onSelect={(nodeId) => dispatch({ type: "select", nodeId })}
                    onConnect={connectProfile}
                    onDisconnect={disconnectProfile}
                    onOpenResource={openResource}
                    onAdd={() => perform("addConnection")}
                    onImport={() => perform("importProfiles")}
                    onEdit={(id) => dispatch({ type: "dialog", dialog: { kind: "profile", tool: tool.id, editId: id } })}
                    onDuplicate={(id) => dispatch({ type: "dialog", dialog: { kind: "profile", tool: tool.id, duplicateOf: id } })}
                    onExport={(id) => exportIds([id])}
                    onDelete={(id) => dispatch({ type: "dialog", dialog: { kind: "deleteProfile", id } })}
                  />
                </SidebarContent>
              </Sidebar>
            </ResizablePanel>
            <ResizableHandle aria-label="Resize sidebar" disabled={!state.layout.sidebarOpen} withGrip className={gapHandle} />
            <ResizablePanel minSize={40}>
              <SidebarInset className="flex h-full min-h-0 flex-col" data-pane="tab">
                {state.tabs.length === 0 ? (
                  <section aria-label="Start" className={cn(layerSurface, "flex h-full min-h-0 flex-col")}>
                    <EmptyState className="m-auto">
                      <EmptyStateIcon className="size-auto bg-accent-subtle p-inset-md text-accent-subtle-fg [&_svg]:size-inset-xl!">
                        <Icon icon={tool.icon} />
                      </EmptyStateIcon>
                      <EmptyStateTitle className="text-subtitle-1">{profiles.some((p) => p.tool === tool.id) ? "No tabs open" : `Add a ${tool.label} connection`}</EmptyStateTitle>
                      <EmptyStateDescription>Connect a profile on the left, then open what you need from its tree or the command palette.</EmptyStateDescription>
                      <EmptyStateActions>
                        <Button appearance="primary" onClick={() => perform("addConnection")}>
                          <Icon icon={Add} /> Add connection
                        </Button>
                      </EmptyStateActions>
                      <dl className="mt-stack-md flex flex-col gap-stack-sm text-start">
                        {(["palette", "addConnection", "settings", "shortcuts"] as const).map((id) => (
                          <div key={id} className="flex items-center gap-inline-lg">
                            <dt className="flex w-panel-xs justify-end">
                              <Kbd>{bindingOf(id)}</Kbd>
                            </dt>
                            <dd className="m-0 w-panel-xs text-fg-muted">{ACTIONS.find((a) => a.id === id)!.label}</dd>
                          </div>
                        ))}
                      </dl>
                    </EmptyState>
                  </section>
                ) : (
                  state.tabs.map((t) => (
                    <TabsContent key={t.id} value={t.id} keepMounted className="min-h-0 flex-1 p-0">
                      <section aria-label={t.title} className={cn(layerSurface, "flex h-full min-h-0 flex-col")}>
                        <TabBody
                          tab={t}
                          tools={tools}
                          profile={profiles.find((p) => p.id === t.profileId)}
                          conn={state.conns[t.profileId] ?? DISCONNECTED}
                          active={state.activeTab === t.id}
                          connect={() => void connectProfile(t.profileId)}
                          cancelConnect={() => dispatch({ type: "conn", profileId: t.profileId, conn: DISCONNECTED })}
                          editProfile={() => dispatch({ type: "dialog", dialog: { kind: "profile", tool: t.tool, editId: t.profileId } })}
                          tabProps={{
                            client,
                            useTabActions: hookFor(t.id),
                            onLive: liveFor(t.id),
                            note,
                            openTab: (open) => openResource(t.profileId, { id: "", label: open.title, open }),
                            updateProfile: async (change) => {
                              const record = profileById(t.profileId);
                              if (record) await saveProfile({ ...change(record), updatedAt: new Date().toISOString() });
                            },
                          }}
                        />
                      </section>
                    </TabsContent>
                  ))
                )}
              </SidebarInset>
            </ResizablePanel>
          </Resizable>
        </div>
        <StatusBar aria-label="Status" className="h-auto gap-inline-md border-t-0 bg-transparent py-inset-xs ps-inset-sm pe-inset-xs">
          <StatusBarItem className="text-fg">
            <Icon icon={tool.icon} />
            <span>{activeProfile ? `${toolById(tools, activeProfile.tool)?.label ?? activeProfile.tool} · ${activeProfile.name}` : tool.label}</span>
          </StatusBarItem>
          {activeConn ? (
            <StatusBarItem>
              <span>{activeConn.status}</span>
            </StatusBarItem>
          ) : null}
          <StatusBarItem live>
            <span>{activeLive ? liveText(activeLive) : ""}</span>
          </StatusBarItem>
          <StatusBarSpacer />
          <StatusBarItem>
            <Icon icon={Server} />
            <span>{state.server === "online" ? (state.info?.publicOrigin ?? location.host) : state.server === "connecting" ? "Connecting…" : "Server lost"}</span>
          </StatusBarItem>
          <StatusBarButton className="h-control-sm" title="Density (Settings → Appearance)" onClick={() => dispatch({ type: "settings", settings: { density: state.settings.density === "compact" ? "comfortable" : "compact" } })}>
            <Icon icon={Options} />
            <span>{state.settings.density === "compact" ? "Compact" : "Comfortable"}</span>
          </StatusBarButton>
          <StatusBarButton className="h-control-sm" title="Colour scheme (Settings → Appearance)" onClick={() => dispatch({ type: "settings", settings: { colorScheme: state.settings.colorScheme === "dark" ? "light" : state.settings.colorScheme === "light" ? "system" : "dark" } })}>
            <Icon icon={Window} />
            <span>{state.settings.colorScheme === "system" ? "System theme" : state.settings.colorScheme === "dark" ? "Dark" : "Light"}</span>
          </StatusBarButton>
          {state.info ? (
            <StatusBarButton className="h-control-sm" onClick={() => perform("about")}>
              Mightyconsole {state.info.version}
            </StatusBarButton>
          ) : null}
        </StatusBar>
      </Tabs>

      <CommandPalette groups={paletteGroups} open={state.paletteOpen} onOpenChange={(open) => dispatch({ type: "palette", open })} hotkeys={["Mod+K", "Mod+Shift+P"]} placeholder="Type a command, a resource or a connection" />

      <ProfileSheet
        open={profileDialog !== null}
        onOpenChange={(open) => !open && closeDialog()}
        tool={sheetTool}
        {...(sheetBase ? { base: sheetBase } : {})}
        mode={sheetMode}
        takenNames={takenNames}
        {...(sheetBase && state.recordStates[sheetBase.id] ? { recordState: state.recordStates[sheetBase.id]! } : {})}
        onSave={async (record) => {
          await saveProfile(record);
          closeDialog();
          dispatch({ type: "select", nodeId: profileNodeId(record.id) });
          toast.add({ title: `${record.name} saved`, description: "Connect when you are ready.", type: "success" });
        }}
      />
      <DeleteProfileDialog open={deleting !== undefined} name={deleting?.name ?? ""} onCancel={closeDialog} onDelete={() => deleting && void doDelete(deleting.id)} />
      <CloseTabDialog open={closing !== undefined} title={closing?.title ?? ""} onCancel={closeDialog} onClose={() => closing && closeTab(closing.id, true)} />
      <ExportDialog open={dialog.kind === "export"} onOpenChange={(open) => !open && closeDialog()} count={exportCount} onExport={doExport} />
      <ImportDialog open={dialog.kind === "import"} onOpenChange={(open) => !open && closeDialog()} plan={(text) => planImport(text, profiles, schemaOf)} onImport={doImport} toolLabel={(id) => toolById(tools, id)?.label ?? id} />
      <SettingsDialog
        open={dialog.kind === "settings"}
        onOpenChange={(open) => !open && closeDialog()}
        settings={state.settings}
        onChange={(settings) => dispatch({ type: "settings", settings })}
        serverAddress={state.info?.publicOrigin ?? location.origin}
        storageKind={state.storageKind}
        profileCount={profiles.length}
        storageUsed={() => storage.estimate()}
        onExportAll={() => exportIds(null)}
        onImport={() => perform("importProfiles")}
        onForgetEverything={async () => {
          for (const [id, conn] of Object.entries(stateRef.current.conns)) if (conn.connId) disconnectProfile(id);
          await storage.forgetEverything();
          location.reload();
        }}
      />
      <AboutDialog open={dialog.kind === "about"} onOpenChange={(open) => !open && closeDialog()} info={state.info} diagnostics={state.diagnostics} />
      <ShortcutsDialog open={dialog.kind === "shortcuts"} onOpenChange={(open) => !open && closeDialog()} />
      {state.server === "lost" || state.server === "versionMismatch" ? <ServerOverlay status={state.server} onRetry={() => supervisor.current?.retryNow()} /> : null}
      <span className="sr-only" aria-live="polite" data-focus-pane={focusPane} />
    </SidebarProvider>
  );
}

/** "Lost the connection to mightyconsole-server, retrying…" over the whole shell (spec §3.5). */
function ServerOverlay({ status, onRetry }: { status: "lost" | "versionMismatch"; onRetry: () => void }) {
  return (
    <div className="fixed inset-0 z-[var(--by-z-modal)] flex items-center justify-center bg-overlay" data-testid="server-overlay">
      <div role="alertdialog" aria-modal="true" aria-labelledby="server-lost-title" className={cn(layerSurface, "flex max-w-panel-sm flex-col items-center gap-stack-md p-inset-lg text-center shadow-flyout")}>
        {status === "lost" ? <Spinner size="lg" label="Retrying" /> : null}
        <h2 id="server-lost-title" className="text-subtitle-2">
          {status === "lost" ? "Lost the connection to mightyconsole-server, retrying…" : "The server was updated"}
        </h2>
        <p className="text-body-1 text-fg-muted">{status === "lost" ? "Your profiles and tabs are safe in this browser. Connections and live views come back when the server answers." : "Reload the page to use the new version."}</p>
        {status === "lost" ? (
          <Button onClick={onRetry} autoFocus>
            Retry now
          </Button>
        ) : (
          <Button appearance="primary" onClick={() => location.reload()} autoFocus>
            Reload
          </Button>
        )}
      </div>
    </div>
  );
}

interface TabBodyProps {
  tab: TabRecord;
  tools: readonly ToolModule[];
  profile: ProfileRecord | undefined;
  conn: ConnState;
  active: boolean;
  connect: () => void;
  cancelConnect: () => void;
  editProfile: () => void;
  tabProps: Pick<TabProps, "client" | "useTabActions" | "onLive" | "note" | "openTab" | "updateProfile">;
}

/** A tab's states around the tool's screen: profile gone, Disconnected, Loading, Error (spec §3.5). */
function TabBody({ tab, tools, profile, conn, active, connect, cancelConnect, editProfile, tabProps }: TabBodyProps) {
  const t = toolById(tools, tab.tool);
  const kind = t?.tabKinds[tab.kind];
  let overlay: ReactNode = null;
  if (!profile || !t || !kind) {
    overlay = (
      <EmptyState className="m-auto">
        <EmptyStateTitle render={<p />}>{!profile ? "This tab's profile was deleted" : "This tab's tool is not in this version"}</EmptyStateTitle>
        <EmptyStateDescription>Close the tab.</EmptyStateDescription>
      </EmptyState>
    );
  } else if (conn.status === "connecting" || conn.status === "reconnecting") {
    overlay = <ConnectingState name={profile.name} since={conn.since ?? Date.now()} onCancel={cancelConnect} />;
  } else if (conn.status === "failed" && conn.error) {
    overlay = <ErrorState error={conn.error} onRetry={connect} onEditProfile={editProfile} onRefresh={connect} />;
  } else if (conn.status === "disconnected") {
    overlay = <DisconnectedState name={profile.name} onConnect={connect} />;
  }
  if (!profile || !t || !kind) return overlay;
  const Component = kind.Component;
  // The tool's screen stays mounted (its stream state survives a reconnect); while the profile is
  // not connected it is dimmed and inert, and the state is shown above it.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className={cn("flex min-h-0 flex-1 flex-col", overlay ? "pointer-events-none opacity-40" : "")} inert={overlay ? true : undefined} aria-hidden={overlay ? true : undefined}>
        <Component tab={tab} profile={profile} connId={conn.status === "connected" ? conn.connId : null} active={active} {...tabProps} />
      </div>
      {overlay ? <div className="absolute inset-0 flex flex-col overflow-auto">{overlay}</div> : null}
    </div>
  );
}

function ConnectingState({ name, since, onCancel }: { name: string; since: number; onCancel: () => void }) {
  const [slow, setSlow] = useState(Date.now() - since >= SLOW_CONNECT_MS);
  useEffect(() => {
    if (slow) return;
    const timer = setTimeout(() => setSlow(true), Math.max(0, SLOW_CONNECT_MS - (Date.now() - since)));
    return () => clearTimeout(timer);
  }, [since, slow]);
  return (
    <EmptyState className="m-auto" aria-busy="true">
      <Spinner size="lg" label={`Connecting to ${name}`} />
      <EmptyStateTitle render={<p />}>Connecting to {name}…</EmptyStateTitle>
      {slow ? (
        <>
          <EmptyStateDescription>Still waiting for {name} to answer.</EmptyStateDescription>
          <EmptyStateActions>
            <Button onClick={onCancel}>Cancel</Button>
          </EmptyStateActions>
        </>
      ) : null}
    </EmptyState>
  );
}
