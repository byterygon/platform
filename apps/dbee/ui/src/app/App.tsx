// The app shell (DBee spec §3.1): a resizable sidebar with the connections and schema tree, query
// tabs in the centre, a status bar at the bottom, the command palette as the menu (no menubar,
// Decision 25), toasts for background news (grant expiry, sessions ended). Every action of spec §9
// is here with its shortcut for this shell.
import { isRpcError } from "@byterygon/ambidex";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CommandPalette, type CommandGroup } from "@/components/ui/command-palette";
import { IconButton } from "@/components/ui/icon-button";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Sidebar, SidebarContent, SidebarHeader, SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { StatusBar, StatusBarButton, StatusBarItem, StatusBarSpacer } from "@/components/ui/status-bar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toast, useToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateTitle } from "@/components/ui/empty-state";
import type { AppEvent, ConnectionDraft, ConnectionSummary, GrantPreview } from "@/gen/api";
import { type Ctx, type RunHandle, connect, openTab, refreshConnections, runStatement } from "./actions";
import { useServices } from "./client";
import { type Approval, ApproveDialog } from "./connections/ApproveDialog";
import { ConnectionSheet } from "./connections/ConnectionSheet";
import { ConnectionsTree } from "./connections/ConnectionsTree";
import { ExpiryBadge } from "./connections/ExpiryBadge";
import { AboutDialog } from "./dialogs/AboutDialog";
import { ConfirmDestructiveDialog, DeleteConnectionDialog, PasswordDialog } from "./dialogs/Confirmations";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { ShortcutsDialog } from "./dialogs/ShortcutsDialog";
import { GearIcon, HelpIcon, PlusIcon } from "./icons";
import { describeError, formatCount, formatElapsed } from "./messages";
import { type Appearance, applyAppearance, followSystemScheme } from "./presets";
import { ExportDialog } from "./query/ExportDialog";
import { QueryTab } from "./query/QueryTab";
import { statusLine } from "./query/ResultsPanel";
import { ACTIONS, type ActionId, type Shell, actionFor, bindingsOf, currentShell, displayBinding, inTextControl } from "./shortcuts";
import { tabOf, useStore } from "./store";

const PANES = ["tree", "editor", "results"] as const;

function tabTitle(sql: string, index: number): string {
  const first = sql.split("\n").find((l) => l.trim() !== "")?.trim();
  return first ? (first.length > 32 ? `${first.slice(0, 32)}…` : first) : `Query ${index + 1}`;
}

export interface AppProps {
  shell?: Shell;
}

export function App({ shell = currentShell() }: AppProps) {
  return (
    <Toast placement="bottom-end">
      <Shell shell={shell} />
    </Toast>
  );
}

function Shell({ shell }: { shell: Shell }) {
  const services = useServices();
  const { state, dispatch } = useStore();
  const toast = useToast();
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctx: Ctx = { services, state, dispatch };
  const runs = useRef(new Map<string, RunHandle>());
  const [approval, setApproval] = useState<Approval | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [focusEditor, setFocusEditor] = useState(0);
  const connections = state.connections ?? [];
  const activeTab = tabOf(state, state.activeTab);
  const activeConnection = activeTab?.connectionId ? connections.find((c) => c.id === activeTab.connectionId) : undefined;

  const note = useCallback((error: unknown) => {
    const d = describeError(error);
    if (d.correlationId) setDiagnostics((list) => [`${new Date().toISOString()} ${d.code ?? ""} ${d.correlationId} ${d.title}`, ...list].slice(0, 100));
    return d;
  }, []);

  // Appearance follows the settings and the OS.
  const appearance: Appearance = useMemo(() => ({ preset: state.settings.preset, colorScheme: state.settings.colorScheme, density: state.settings.density }), [state.settings.preset, state.settings.colorScheme, state.settings.density]);
  useEffect(() => applyAppearance(appearance), [appearance]);
  useEffect(() => followSystemScheme(() => appearance), [appearance]);

  // Start: app.info, the connections, the event subscription.
  useEffect(() => {
    let cancelled = false;
    let subscription: { unsubscribe(): void } | undefined;
    void (async () => {
      try {
        const info = await services.client.app.info({});
        if (!cancelled) dispatch({ type: "info", info });
      } catch (e) {
        if (!cancelled) {
          const d = note(e);
          dispatch({ type: "connectionsError", error: d });
          return;
        }
      }
      await refreshConnections({ services, state: stateRef.current, dispatch });
      if (cancelled) return;
      const events = services.client.app.events({});
      subscription = events;
      try {
        for await (const event of events) handleEvent(event);
      } catch (e) {
        if (!cancelled) note(e);
      }
    })();
    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services]);

  // Tabs and settings that are not being saved (workspace.ts): one toast per new problem.
  const shownProblem = useRef<string | null>(null);
  useEffect(() => {
    const problem = state.workspaceProblem;
    const key = problem === null ? null : problem.kind === "conflict" ? "conflict" : `${problem.kind}:${problem.error.title}`;
    if (key === shownProblem.current) return;
    shownProblem.current = key;
    if (problem === null) return;
    switch (problem.kind) {
      case "unreadable": {
        const d = problem.error;
        if (d.correlationId) setDiagnostics((list) => [`${new Date().toISOString()} ${d.code ?? ""} ${d.correlationId} ${d.title}`, ...list].slice(0, 100));
        toast.add({
          title: "Could not read the workspace",
          description: `${problem.error.title}. Tabs and settings are not saved in this session, so nothing in the workspace is overwritten.`,
          type: "danger",
          timeout: 0,
          actionProps: { children: "Open diagnostics", onClick: () => dispatch({ type: "dialog", dialog: { kind: "about" } }) },
        });
        break;
      }
      case "conflict":
        toast.add({
          title: "The workspace changed in another window",
          description: "This window stopped saving its tabs and settings. Reload to continue with the saved ones.",
          type: "warning",
          timeout: 0,
          priority: "high",
          actionProps: { children: "Reload", onClick: () => location.reload() },
        });
        break;
      case "failed":
        toast.add({ title: "Could not save tabs and settings", description: `${problem.error.description ?? problem.error.title} It is tried again with the next change.`, type: "danger" });
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.workspaceProblem]);

  function handleEvent(event: AppEvent) {
    const current = stateRef.current;
    const name = (id: string) => current.connections?.find((c) => c.id === id)?.name ?? id;
    switch (event.kind) {
      case "ConnectionStatus":
        dispatch({ type: "status", id: event.connectionId, status: event.status });
        break;
      case "GrantExpiring":
        toast.add({
          title: `Access to ${name(event.connectionId)} expires in ${Math.max(1, Math.round((event.expiresAt - Date.now()) / 60_000))} min`,
          description: "Renew it to keep the sessions; a new grant replaces the old one.",
          type: "warning",
          timeout: 0,
          priority: "high",
          actionProps: { children: "Renew access", onClick: () => renew(event.connectionId) },
        });
        break;
      case "GrantExpired":
        dispatch({ type: "status", id: event.connectionId, status: "expired" });
        toast.add({ title: `Access to ${name(event.connectionId)} expired`, description: "A running statement's outcome on the database is unknown.", type: "danger", timeout: 0, actionProps: { children: "Renew access", onClick: () => renew(event.connectionId) } });
        void refreshConnections({ services, state: current, dispatch });
        break;
      case "SessionEnded":
        for (const tab of current.tabs) {
          if (current.tabsRuntime[tab.id]?.sessionId === event.sessionId) dispatch({ type: "session", id: tab.id, sessionId: null });
        }
        break;
    }
  }

  const connectionById = (id: string) => connections.find((c) => c.id === id);

  const renew = (id: string) => {
    // Renew access is the edit flow with the same target, a new expiry and a new approval (spec §4).
    dispatch({ type: "dialog", dialog: { kind: "connection", editId: id, renew: true } });
  };

  const disconnect = async (id: string) => {
    // Sessions close with their tabs; the browser session ends when the connection's status
    // changes. Closing every editor session of the connection is what "disconnect" means here.
    for (const tab of state.tabs) {
      const rt = state.tabsRuntime[tab.id];
      if (tab.connectionId === id && rt?.sessionId) {
        try {
          await services.client.sessions.close({ sessionId: rt.sessionId });
        } catch (e) {
          note(e);
        }
        dispatch({ type: "session", id: tab.id, sessionId: null });
      }
    }
    dispatch({ type: "status", id, status: "disconnected" });
    dispatch({ type: "schemaForget", connectionId: id });
  };

  const deleteConnection = async (id: string) => {
    setBusy(true);
    try {
      await services.client.connections.delete({ id });
      for (const tab of state.tabs) if (tab.connectionId === id) dispatch({ type: "editTab", id: tab.id, connectionId: null });
      await refreshConnections(ctx);
      dispatch({ type: "dialog", dialog: { kind: "none" } });
    } catch (e) {
      const d = note(e);
      toast.add({ title: "Could not delete the connection", description: d.title, type: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const run = async (tabId: string, sql: string) => {
    const tab = tabOf(stateRef.current, tabId);
    if (!tab || !tab.connectionId) return;
    const connection = connectionById(tab.connectionId);
    if (connection && !connection.hasSecret && state.statuses[connection.id] !== "connected" && !tab.sessionId && state.info?.secretStore === "session-only") {
      dispatch({ type: "dialog", dialog: { kind: "password", connectionId: connection.id, then: "run" } });
      return;
    }
    try {
      const classification = await services.client.query.classify({ sql });
      if (classification.risk === "Destructive") {
        dispatch({ type: "dialog", dialog: { kind: "confirmDestructive", tabId, sql, statementKind: classification.kind } });
        return;
      }
    } catch (e) {
      note(e);
    }
    start(tabId, sql);
  };

  const start = (tabId: string, sql: string) => {
    runs.current.get(tabId)?.cancel();
    const handle = runStatement({ services, state: stateRef.current, dispatch }, tabId, sql, () => stateRef.current);
    runs.current.set(tabId, handle);
    void handle.done.then(() => {
      runs.current.delete(tabId);
      const after = tabOf(stateRef.current, tabId);
      if (after?.run?.status === "error" && after.run.error?.correlationId) note({ ...after.run.error });
    });
  };

  const cancel = (tabId: string) => runs.current.get(tabId)?.cancel();

  const newTab = () => {
    const selectedConnection = state.selectedNode?.startsWith("c:") ? state.selectedNode.slice(2).split("/")[0] : undefined;
    const connectionId = activeTab?.connectionId ?? selectedConnection ?? connections[0]?.id ?? null;
    openTab(ctx, connectionId);
    setFocusEditor((n) => n + 1);
  };

  const closeTab = (id: string) => {
    const rt = state.tabsRuntime[id];
    runs.current.get(id)?.cancel();
    if (rt?.sessionId) void services.client.sessions.close({ sessionId: rt.sessionId }).catch(note);
    dispatch({ type: "closeTab", id });
  };

  const remedy = (what: string, connectionId: string | null) => {
    switch (what) {
      case "renewAccess":
        if (connectionId) renew(connectionId);
        break;
      case "editConnection":
      case "widenAddresses":
        if (connectionId) dispatch({ type: "dialog", dialog: { kind: "connection", editId: connectionId } });
        break;
      case "reconnect":
      case "retry":
        if (connectionId) void connect(ctx, connectionId);
        break;
      case "openDiagnostics":
        dispatch({ type: "dialog", dialog: { kind: "about" } });
        break;
      case "enterPassword":
        if (connectionId) dispatch({ type: "dialog", dialog: { kind: "password", connectionId, then: "connect" } });
        break;
      case "reload":
        location.reload();
        break;
    }
  };

  const cyclePanes = (back: boolean) => {
    const i = PANES.indexOf(state.pane);
    const next = PANES[(i + (back ? PANES.length - 1 : 1)) % PANES.length]!;
    dispatch({ type: "pane", pane: next });
    const el = document.querySelector<HTMLElement>(`[data-pane="${next}"]`);
    (el?.querySelector<HTMLElement>("[tabindex='0'], textarea, [role=textbox], [role=tree], button") ?? el)?.focus();
    if (next === "editor") setFocusEditor((n) => n + 1);
  };

  const perform = (id: ActionId) => {
    switch (id) {
      case "palette":
        dispatch({ type: "palette", open: !state.paletteOpen });
        break;
      case "addConnection":
        dispatch({ type: "dialog", dialog: { kind: "connection" } });
        break;
      case "newTab":
        newTab();
        break;
      case "closeTab":
        if (state.activeTab) closeTab(state.activeTab);
        break;
      case "nextTab":
      case "prevTab": {
        const i = state.tabs.findIndex((t) => t.id === state.activeTab);
        if (state.tabs.length === 0) break;
        const next = state.tabs[(i + (id === "nextTab" ? 1 : state.tabs.length - 1)) % state.tabs.length]!;
        dispatch({ type: "activateTab", id: next.id });
        break;
      }
      case "run":
        if (activeTab) void run(activeTab.id, activeTab.sql);
        break;
      case "cancel":
        if (activeTab) cancel(activeTab.id);
        break;
      case "toggleRowLimit":
        if (activeTab) dispatch({ type: "editTab", id: activeTab.id, maxRows: activeTab.maxRows === null ? 1000 : null });
        break;
      case "export":
        if (activeTab) dispatch({ type: "dialog", dialog: { kind: "export", tabId: activeTab.id } });
        break;
      case "focusTree":
        dispatch({ type: "pane", pane: "tree" });
        document.querySelector<HTMLElement>("[data-pane='tree'] [role=tree]")?.focus();
        break;
      case "cyclePanes":
        cyclePanes(false);
        break;
      case "cyclePanesBack":
        cyclePanes(true);
        break;
      case "refreshNode": {
        const id = state.selectedNode?.slice(2).split("/")[0];
        if (id) {
          dispatch({ type: "schemaForget", connectionId: id });
          if (state.statuses[id] === "connected") void connect(ctx, id);
        }
        break;
      }
      case "connectToggle": {
        const id = state.selectedNode?.slice(2).split("/")[0];
        if (!id) break;
        if (state.statuses[id] === "connected") void disconnect(id);
        else void connect(ctx, id);
        break;
      }
      case "settings":
        dispatch({ type: "dialog", dialog: { kind: "settings" } });
        break;
      case "toggleSidebar":
        dispatch({ type: "sidebar", open: !state.sidebarOpen });
        break;
      case "shortcuts":
        dispatch({ type: "dialog", dialog: { kind: "shortcuts" } });
        break;
      default:
        break;
    }
  };

  // Global shortcuts (spec §9). The editor keeps Ctrl+Enter, Ctrl+F and Ctrl+/ for itself; the
  // sidebar's provider owns Ctrl+B; F5 and Escape inside a text control belong to it.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const action = actionFor(event, shell);
      if (!action) return;
      if (action.id === "toggleSidebar" || action.id === "palette") return;
      const inText = inTextControl(event.target);
      if (inText && (action.id === "run" || action.id === "refreshNode" || (action.id === "shortcuts" && (event.target as HTMLElement).closest(".monaco-editor")))) return;
      if (action.id === "cancel" && !inText && !(activeTab?.run?.status === "running")) return;
      event.preventDefault();
      perform(action.id);
    };
    // Capture phase: popups and the toast region handle Escape on the document and stop it there.
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  });

  const paletteGroups: CommandGroup[] = useMemo(() => {
    const groups = new Map<string, CommandGroup>();
    for (const a of ACTIONS) {
      if (a.id === "palette") continue;
      const g = groups.get(a.group) ?? { label: a.group, items: [] };
      const disabled = (a.id === "run" || a.id === "cancel" || a.id === "export" || a.id === "closeTab" || a.id === "toggleRowLimit") && !activeTab || (a.id === "cancel" && activeTab?.run?.status !== "running") || ((a.id === "refreshNode" || a.id === "connectToggle") && !state.selectedNode);
      (g.items as (typeof g.items)[number][]).push({
        id: a.id,
        label: a.label,
        shortcut: displayBinding(bindingsOf(a, shell)[0] ?? ""),
        ...(a.keywords ? { keywords: a.keywords } : {}),
        disabled,
        onSelect: () => perform(a.id),
      });
      groups.set(a.group, g);
    }
    for (const c of connections) {
      const g = groups.get("Connections")!;
      (g.items as (typeof g.items)[number][]).push({ id: `connect:${c.id}`, label: `Connect: ${c.name}`, keywords: [c.host, c.database], onSelect: () => void connect(ctx, c.id) });
    }
    return [...groups.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.run?.status, state.selectedNode, connections, shell]);

  const onApproved = async (created: ConnectionSummary) => {
    setApproval(null);
    dispatch({ type: "dialog", dialog: { kind: "none" } });
    await refreshConnections(ctx);
    toast.add({ title: `${created.name} saved`, description: "Access was approved; connect when you are ready.", type: "success" });
    dispatch({ type: "select", nodeId: `c:${created.id}` });
  };

  const onPreview = (preview: GrantPreview, draft: ConnectionDraft, password: string | null, replaces: string | null) => {
    setApproval({ preview, draft, password, replaces });
  };

  const status = activeTab?.run ? statusLine(activeTab.run) : "";
  const expiring = activeConnection?.grant.expiresAt ?? null;
  const dialog = state.dialog;
  const editing = dialog.kind === "connection" && dialog.editId ? connectionById(dialog.editId) : undefined;
  const exportTab = dialog.kind === "export" ? tabOf(state, dialog.tabId) : undefined;
  const pwConnection = dialog.kind === "password" ? connectionById(dialog.connectionId) : undefined;

  return (
    <SidebarProvider open={state.sidebarOpen} onOpenChange={(open) => dispatch({ type: "sidebar", open })} className="h-full">
      <div className="flex h-full min-h-0 w-full flex-col bg-canvas text-fg">
        <Resizable orientation="horizontal" sizes={state.sidebarOpen ? state.shellSizes : [0, 100]} onSizesChange={(sizes) => state.sidebarOpen && dispatch({ type: "sizes", shellSizes: sizes })} className="min-h-0 flex-1" aria-label="Sidebar and workspace">
          <ResizablePanel minSize={state.sidebarOpen ? 12 : 0} maxSize={state.sidebarOpen ? 50 : 0}>
            <Sidebar aria-label="Connections" collapsible="offcanvas" className="h-full w-full border-e">
              <SidebarHeader className="flex-row items-center justify-between">
                <span className="text-label text-fg-muted">Connections</span>
                <Tooltip>
                  <TooltipTrigger render={<IconButton aria-label="Add connection" size="sm" onClick={() => perform("addConnection")} />}>
                    <PlusIcon className="size-icon-sm" />
                  </TooltipTrigger>
                  <TooltipContent>Add connection ({displayBinding(bindingsOf(ACTIONS[1]!, shell)[0]!)})</TooltipContent>
                </Tooltip>
              </SidebarHeader>
              <SidebarContent className="min-h-0 flex-1 p-0">
                <ConnectionsTree shell={shell} onAddConnection={() => perform("addConnection")} onEdit={(id) => dispatch({ type: "dialog", dialog: { kind: "connection", editId: id } })} onRenew={renew} onDelete={(id) => dispatch({ type: "dialog", dialog: { kind: "deleteConnection", id } })} onDisconnect={(id) => void disconnect(id)} />
              </SidebarContent>
            </Sidebar>
          </ResizablePanel>
          <ResizableHandle aria-label="Resize sidebar" disabled={!state.sidebarOpen} />
          <ResizablePanel minSize={40}>
            <SidebarInset className="flex h-full min-h-0 flex-col">
              {state.tabs.length === 0 ? (
                <EmptyState className="m-auto">
                  <EmptyStateTitle>No query tabs</EmptyStateTitle>
                  <EmptyStateDescription>Open a tab for a connection, or press Enter on a table in the tree.</EmptyStateDescription>
                  <EmptyStateActions>
                    <Button onClick={newTab} disabled={connections.length === 0}>
                      New query tab
                    </Button>
                  </EmptyStateActions>
                </EmptyState>
              ) : (
                <Tabs value={state.activeTab ?? ""} onValueChange={(v) => dispatch({ type: "activateTab", id: String(v) })} variant="enclosed" size="sm" className="flex h-full min-h-0 flex-col">
                  <div className="flex shrink-0 items-center border-b border-border">
                    <SidebarTrigger />
                    <TabsList onReorder={(value, index) => dispatch({ type: "reorderTab", id: String(value), index })} className="min-w-0 flex-1">
                      {state.tabs.map((t, i) => {
                        const rt = state.tabsRuntime[t.id];
                        const icon = rt?.run?.status === "running" ? <Spinner size="sm" label="Running" /> : rt?.modified ? <span role="img" aria-label="changed since the last run" className="size-icon-xs rounded-full bg-fg-muted" /> : undefined;
                        return (
                          <TabsTrigger key={t.id} value={t.id} icon={icon} onClose={() => closeTab(t.id)}>
                            {tabTitle(t.sql, i)}
                          </TabsTrigger>
                        );
                      })}
                    </TabsList>
                    <IconButton aria-label="New query tab" size="sm" onClick={newTab}>
                      <PlusIcon className="size-icon-sm" />
                    </IconButton>
                  </div>
                  {state.tabs.map((t) => {
                    const tab = tabOf(state, t.id);
                    return tab ? (
                      <TabsContent key={t.id} value={t.id} className="min-h-0 flex-1 p-0">
                        <QueryTab
                          tab={tab}
                          connections={connections}
                          shell={shell}
                          splitSizes={state.splitSizes}
                          onSplitSizes={(sizes) => dispatch({ type: "sizes", splitSizes: sizes })}
                          onChange={(patch) => dispatch({ type: "editTab", id: t.id, ...patch })}
                          onRun={(sql) => void run(t.id, sql)}
                          onCancel={() => cancel(t.id)}
                          onExport={() => dispatch({ type: "dialog", dialog: { kind: "export", tabId: t.id } })}
                          onRemedy={(r) => remedy(r, tab.connectionId)}
                          settings={state.settings}
                          focusEditorSignal={state.activeTab === t.id ? focusEditor : 0}
                        />
                      </TabsContent>
                    ) : null;
                  })}
                </Tabs>
              )}
            </SidebarInset>
          </ResizablePanel>
        </Resizable>
        <StatusBar aria-label="Status" className="shrink-0">
          <StatusBarItem>
            <span title={activeConnection ? `${activeConnection.user}@${activeConnection.host}:${activeConnection.port}/${activeConnection.database}` : undefined}>{activeConnection ? activeConnection.name : "No connection"}</span>
          </StatusBarItem>
          {activeConnection ? (
            <StatusBarItem>
              <span>{state.statuses[activeConnection.id] ?? activeConnection.status}</span>
            </StatusBarItem>
          ) : null}
          {activeTab?.sessionId ? (
            <StatusBarItem>
              <span>session open</span>
            </StatusBarItem>
          ) : null}
          <StatusBarItem live>
            <span>{status}</span>
          </StatusBarItem>
          {activeTab?.run?.status === "running" ? <StatusBarButton onClick={() => cancel(activeTab.id)}>Cancel</StatusBarButton> : null}
          <StatusBarSpacer />
          {expiring !== null ? (
            <StatusBarItem>
              <ExpiryBadge expiresAt={expiring} />
            </StatusBarItem>
          ) : null}
          <StatusBarButton onClick={() => dispatch({ type: "settings", settings: { density: state.settings.density === "compact" ? "comfortable" : "compact" } })}>{state.settings.density}</StatusBarButton>
          <StatusBarButton onClick={() => dispatch({ type: "settings", settings: { colorScheme: state.settings.colorScheme === "dark" ? "light" : state.settings.colorScheme === "light" ? "system" : "dark" } })}>{state.settings.colorScheme}</StatusBarButton>
          <StatusBarButton onClick={() => perform("shortcuts")} aria-label="Keyboard shortcuts">
            <HelpIcon className="size-icon-xs" />
          </StatusBarButton>
          <StatusBarButton onClick={() => perform("settings")} aria-label="Settings">
            <GearIcon className="size-icon-xs" />
          </StatusBarButton>
          {state.info ? <StatusBarButton onClick={() => dispatch({ type: "dialog", dialog: { kind: "about" } })}>DBee {state.info.version}</StatusBarButton> : null}
        </StatusBar>
      </div>

      <CommandPalette groups={paletteGroups} open={state.paletteOpen} onOpenChange={(open) => dispatch({ type: "palette", open })} hotkeys={["Mod+K", "Mod+Shift+P"]} placeholder="Type a command" />

      {dialog.kind === "connection" ? (
        <ConnectionSheet
          open={approval === null}
          onOpenChange={(open) => !open && dispatch({ type: "dialog", dialog: { kind: "none" } })}
          editing={editing}
          renewing={dialog.kind === "connection" && dialog.renew === true}
          existingNames={connections.map((c) => c.name)}
          onPreview={onPreview}
          onUpdated={() => {
            void refreshConnections(ctx);
            dispatch({ type: "dialog", dialog: { kind: "none" } });
          }}
        />
      ) : null}
      <ApproveDialog approval={approval} onBack={() => setApproval(null)} onApproved={(c) => void onApproved(c)} />
      {dialog.kind === "deleteConnection" ? <DeleteConnectionDialog name={connectionById(dialog.id)?.name ?? ""} busy={busy} onCancel={() => dispatch({ type: "dialog", dialog: { kind: "none" } })} onDelete={() => void deleteConnection(dialog.id)} /> : null}
      {dialog.kind === "confirmDestructive" ? (
        <ConfirmDestructiveDialog
          sql={dialog.sql}
          statementKind={dialog.statementKind}
          onCancel={() => dispatch({ type: "dialog", dialog: { kind: "none" } })}
          onRun={() => {
            dispatch({ type: "dialog", dialog: { kind: "none" } });
            start(dialog.tabId, dialog.sql);
          }}
        />
      ) : null}
      {dialog.kind === "password" && pwConnection ? (
        <PasswordDialog
          name={pwConnection.name}
          busy={busy}
          onCancel={() => dispatch({ type: "dialog", dialog: { kind: "none" } })}
          onSubmit={(password) => {
            setBusy(true);
            void services.client.connections
              .setSecret({ id: pwConnection.id, password })
              .then(async () => {
                dispatch({ type: "dialog", dialog: { kind: "none" } });
                await refreshConnections(ctx);
                if (dialog.then === "connect") await connect(ctx, pwConnection.id);
                else if (activeTab) start(activeTab.id, activeTab.sql);
              })
              .catch((e: unknown) => {
                const d = note(e);
                toast.add({ title: "Could not keep the password", description: d.title, type: "danger" });
              })
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
      {dialog.kind === "export" && exportTab ? (
        <ExportDialog
          open
          onOpenChange={(open) => !open && dispatch({ type: "dialog", dialog: { kind: "none" } })}
          sessionId={exportTab.sessionId}
          sql={exportTab.sql}
          shell={shell}
          ensureSession={async () => {
            if (!exportTab.connectionId) throw new Error("no connection");
            const opened = await services.client.sessions.open({ connectionId: exportTab.connectionId, purpose: "editor" });
            dispatch({ type: "session", id: exportTab.id, sessionId: opened.sessionId });
            return opened.sessionId;
          }}
        />
      ) : null}
      <SettingsDialog open={dialog.kind === "settings"} onOpenChange={(open) => !open && dispatch({ type: "dialog", dialog: { kind: "none" } })} settings={state.settings} onChange={(settings) => dispatch({ type: "settings", settings })} info={state.info} onOpenDiagnostics={() => dispatch({ type: "dialog", dialog: { kind: "about" } })} />
      <AboutDialog open={dialog.kind === "about"} onOpenChange={(open) => !open && dispatch({ type: "dialog", dialog: { kind: "none" } })} info={state.info} diagnostics={diagnostics} />
      <ShortcutsDialog open={dialog.kind === "shortcuts"} onOpenChange={(open) => !open && dispatch({ type: "dialog", dialog: { kind: "none" } })} shell={shell} />
      {state.connectionsError ? (
        <div role="alert" className="absolute inset-x-0 top-0 flex items-center gap-inline-md bg-status-danger-bg px-inset-md py-inset-xs text-body text-status-danger-fg">
          <span>
            {state.connectionsError.title}
            {state.connectionsError.description ? ` ${state.connectionsError.description}` : ""}
            {isRpcError(state.connectionsError) ? "" : ""}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void refreshConnections(ctx)}>
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "dialog", dialog: { kind: "about" } })}>
            Open diagnostics
          </Button>
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {activeTab?.run?.status === "done" && activeTab.run.summary ? `${formatCount(activeTab.run.rows)} rows in ${formatElapsed(activeTab.run.summary.elapsedMs)}` : ""}
      </span>
    </SidebarProvider>
  );
}
