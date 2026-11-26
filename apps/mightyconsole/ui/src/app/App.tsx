// The shell (Mightyconsole spec §3.1, on DBee's Fluent 2 shell of TSK-64): the window paints the
// backdrop; a title area with the sidebar toggle, the app mark, the tabs as a Fluent TabList, the
// command search, Settings and Help; below it the tool rail, the sidebar layer (the selected
// tool's connection list) and the tab layer (a command bar, then the screen); a status bar. The
// command palette is the menu. Every action of spec §3.4 is here with its binding. The whole shell
// is the root route of the router (DOC-21 §3.7); `useRouteSync` keeps the URL on the active tab.
import { type AnyRouter, type HistoryLocation, type RouterHistory, RouterProvider, createMemoryHistory, useBlocker, useRouter } from "@tanstack/react-router";
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
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Toast, useToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AppEvent, HostKeyDetails, HostKeyFingerprint } from "@/gen/api";
import { cn } from "@/lib/cn";
import { layerSurface } from "@/lib/control";
import { Add, ArrowImport, Eye, Info, Options, Person, Pin, QuestionCircle, Search, Server, Settings as SettingsIcon, Window } from "@/lib/icons";
import { loadProfiles, recordStatesOf } from "@/profiles/migrate";
import { deleteProfile as deleteServerProfile, importRecord, listProfiles as listServerProfiles, saveProfile as saveServerProfile, updateRecord as updateServerRecord } from "@/profiles/server";
import type { ProfileRecord } from "@/profiles/record";
import { applyImport, exportFile, exportFileName, type ImportPlan, planImport } from "@/profiles/transfer";
import { TOOLS, toolById, toolCategory, toolIcon } from "@/tools/registry";
import type { DescribedError, LiveState, ResourceNode, TabActionHandlers, TabPlace, TabProps, TabRecord, ToolModule } from "@/tools/types";
import { AccessPage, AccessProvider, type AccessValue, DeniedTab } from "./access-ui";
import { type Refusal, holdsAnywhere, refusalBefore, toolOpen, toolPerm } from "./access";
import { AccountMenu, SessionsDialog } from "./account-menu";
import { AdminDialog } from "./admin/AdminDialog";
import { AuditDialog } from "./audit/AuditDialog";
import { useAudience } from "./sharing";
import { MyAccessDialog } from "./my-access";
import { useServices } from "./client";
import { AboutDialog, ShortcutsDialog } from "./dialogs/InfoDialogs";
import { HostKeyDialog } from "./dialogs/HostKeyDialog";
import { CloseTabDialog, DeleteProfileDialog, DiscardChangesDialog, ExportDialog, ImportDialog, MoveProfilesDialog, ProfileSheet } from "./dialogs/ProfileDialogs";
import { moveToServer } from "@/profiles/move";
import { reloadSshHosts, sshHosts } from "@/profiles/ssh-hosts";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { describeError, diagnosticLine } from "./messages";
import { applyAppearance, followSystemScheme } from "./presets";
import { ExpiryBar, SessionEndedDialog, useExpiry, useSession, useSignInAgain } from "./session-ui";
import { IDP_META } from "./sign-in";
import { mainRole, nameOf, signOut } from "./session";
import { ACTIONS, type ActionId, actionFor, bindingOf, inTextControl } from "./shortcuts";
import { ToolNav, type ToolState, navOrder } from "./nav/ToolNav";
import { type Notice, NoticeContext } from "./page";
import { ConnectionList, parseNode, profileNodeId } from "./sidebar/ConnectionList";
import { KeepTabContext, LeaveGuardContext, type LeaveGuardSetter } from "./leave-guard";
import { MissingProfilePage } from "./missing-profile";
import { type NavCrumb, NavRow, type NavRowProps, type SiblingMenu, wantsNewTab } from "./nav-row";
import { type EntryState, type RouteCrumb, type RouterConfig, createAppRouter, crumbsOf, placeHref, segment, targetOf, targetOfHref, withParams } from "./router";
import { DisconnectedState, ErrorState, liveText } from "./states";
import { type ConnState, type MissingLink, type State, tabIdOf, useStore } from "./store";
import { Supervisor } from "./supervisor";
import { canGo, initialHistory } from "./tab-history";
import { TabStrip, groupOfValue } from "./tab-strip";

/** A resize handle in the gap between two layers (TSK-64). */
const gapHandle =
  "bg-transparent hover:bg-transparent focus-visible:bg-transparent data-dragging:bg-transparent data-[orientation=horizontal]:w-gap-sm data-[orientation=vertical]:h-gap-sm hover:[&>span]:bg-border-focus data-dragging:[&>span]:bg-border-focus";

const PANES = ["rail", "sidebar", "tab"] as const;

/** After this long, "Connecting…" says what it is still waiting for and offers Cancel (spec §3.5). */
export const SLOW_CONNECT_MS = 10_000;

/** The tool drawer is open by default from this window width (DOC-21 §3.1)… */
export const NAV_DRAWER_FROM = 1280;
/** …and floats over the panes, when opened, below this one. */
export const NAV_OVERLAY_BELOW = 1024;
const FIND_TOOL_ID = "mc-find-tool";
/** The tab strip's value of a link to a missing profile (DOC-21 §3.7). */
const LINK_TAB = "mc-link";
/** The guard of the shell's own sheets (a profile being added or edited). */
const SHELL_GUARD = "mc-shell";

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export interface AppProps {
  tools?: readonly ToolModule[];
  /** The router's history (DOC-21 §3.7); a memory history at `/` when none is given (tests). */
  history?: RouterHistory;
  /** The mode and base path the server gave the page; memory at `/` by default. */
  routerConfig?: RouterConfig;
}

const MEMORY: RouterConfig = { mode: "memory", basePath: "" };

export function App({ tools = TOOLS, history, routerConfig = MEMORY }: AppProps) {
  const [router] = useState(() =>
    createAppRouter(tools, () => <Shell tools={tools} routerConfig={routerConfig} />, history ?? createMemoryHistory({ initialEntries: ["/"] }), routerConfig),
  );
  return (
    <Toast placement="bottom-end">
      <RouterProvider router={router} />
    </Toast>
  );
}

/** The browser entry a tab shows: its place's URL and its id and step in the history state. */
interface Entry {
  href: string;
  tab: string | null;
  step: number | null;
}

/**
 * Keeps the URL on the active tab and opens what a URL names (DOC-21 §3.7). The tab model is the
 * source of truth: activating, opening or closing a tab replaces the browser's entry, a step pushed
 * with `navigate` pushes one. A URL that arrives (first load, a paste, an entry without a tab id)
 * opens or focuses its tab; the browser's Back and Forward move the active tab when it has a step
 * that way, else show the landed entry's own step (reopening its tab when it was closed).
 */
function useRouteSync(options: {
  router: AnyRouter;
  config: RouterConfig;
  tools: readonly ToolModule[];
  state: State;
  stateRef: { readonly current: State };
  dispatch: ReturnType<typeof useStore>["dispatch"];
  missingProfile: (tool: ToolModule, name: string, place: Omit<TabPlace, "title"> | null) => void;
  /** Set when the router's blocker held a browser move: its notification is not a move. */
  heldPop: { current: boolean };
}): { pushNext: (tabId: string) => void } {
  const { router, config, tools, state, stateRef, dispatch, missingProfile, heldPop } = options;
  const history: RouterHistory = router.history;
  const ready = state.profiles !== null;
  const arrived = useRef(false);
  const pendingPush = useRef<string | null>(null);
  const seeded = useRef(false);
  const publicHref = (href: string) => (config.mode === "browser" ? config.basePath + href : href);

  const entryOf = (s: State, tabId: string | null, step?: number): Entry => {
    const tab = s.tabs.find((t) => t.id === tabId) ?? s.closedTabs.find((t) => t.id === tabId);
    const tool = toolById(tools, tab?.tool ?? s.layout.tool) ?? tools[0]!;
    if (!tab) return { href: `/${tool.id}`, tab: null, step: null };
    const at = step ?? tab.history.index;
    const place = tab.history.entries[at] ?? tab;
    return { href: placeHref(tool, s.profiles?.find((p) => p.id === tab.profileId), place), tab: tab.id, step: at };
  };

  const write = (entry: Entry, push: boolean) => {
    const target = publicHref(entry.href);
    const state = entry.tab !== null ? { mcTab: entry.tab, mcStep: entry.step ?? 0 } : {};
    if (push) history.push(target, state);
    else history.replace(target, state);
  };

  /** A URL arrived: open or focus what it names. */
  const arrive = (location: HistoryLocation) => {
    const s = stateRef.current;
    const target = targetOf(router, router.parseLocation(location), tools);
    if (target.type === "start") return;
    const tool = toolById(tools, target.tool)!;
    dispatch({ type: "layout", layout: { tool: tool.id } });
    if (!target.profileName) return;
    const profile = s.profiles?.find((p) => p.tool === tool.id && p.name === target.profileName);
    if (!profile) return missingProfile(tool, target.profileName, target.type === "place" ? target.place : null);
    if (target.type === "tool") return;
    const kind = tool.tabKinds[target.place.kind]!;
    const place: TabPlace = { ...target.place, title: kind.title(target.place.params) };
    dispatch({ type: "openTab", tab: { id: tabIdOf(tool.id, profile.id, place.kind, place.params), tool: tool.id, profileId: profile.id, ...place, pinned: false, history: initialHistory(place) } });
  };

  /** The browser moved through its entries (Back, Forward, a step several away). */
  const pop = (location: HistoryLocation, delta: number) => {
    const s = stateRef.current;
    const { mcTab, mcStep } = location.state as EntryState;
    // Leaving a link's missing-profile page through the browser drops it.
    if (s.missingLink) dispatch({ type: "missingLink", link: null });
    if (mcTab === undefined) return arrive(location);
    const active = s.tabs.find((t) => t.id === s.activeTab);
    if (active && canGo(active, delta)) return dispatch({ type: "tabGo", id: active.id, delta });
    // The active tab has no step that way: show the entry's own, if it still holds that place.
    const href = router.parseLocation(location).href;
    const matches = (step: number) => entryOf(s, mcTab, step).href === href;
    const step = mcStep ?? 0;
    if (s.tabs.some((t) => t.id === mcTab) && matches(step)) return dispatch({ type: "tabStep", id: mcTab, step });
    if (s.closedTabs.some((t) => t.id === mcTab) && matches(step)) return dispatch({ type: "reopenTab", id: mcTab, step });
    arrive(location);
  };

  // URL → tabs: the first URL once profiles are known, then every move through the entries.
  useEffect(() => {
    if (!ready) return;
    if (!arrived.current) {
      arrived.current = true;
      arrive(history.location);
    }
    return history.subscribe(({ location, action }) => {
      // The blocker reverted a held move and still notifies it.
      if (heldPop.current && (action.type === "BACK" || action.type === "FORWARD" || action.type === "GO")) {
        heldPop.current = false;
        return;
      }
      if (action.type === "BACK") pop(location, -1);
      else if (action.type === "FORWARD") pop(location, 1);
      else if (action.type === "GO") pop(location, action.index);
      // PUSH and REPLACE are the shell's own writes.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, history]);

  // Tabs → URL: the active tab's place, or `/<tool>` with no tab.
  const active = state.tabs.find((t) => t.id === state.activeTab) ?? null;
  const activeName = active ? state.profiles?.find((p) => p.id === active.profileId)?.name : undefined;
  useEffect(() => {
    if (!ready || !arrived.current) return;
    const s = stateRef.current;
    // A link to a missing profile keeps its URL while its page shows.
    if (s.missingLink) {
      if (history.location.href !== publicHref(s.missingLink.href)) history.replace(publicHref(s.missingLink.href), {});
      return;
    }
    const entry = entryOf(s, s.activeTab);
    const current = history.location;
    const push = pendingPush.current !== null && pendingPush.current === entry.tab;
    pendingPush.current = null;
    // On load, the browser gets the active tab's step behind as its entry behind, so its Back works.
    if (!seeded.current) {
      seeded.current = true;
      const tab = s.tabs.find((t) => t.id === entry.tab);
      if (config.mode !== "memory" && tab && tab.history.index > 0 && (current.state as EntryState).__TSR_index === 0) {
        write(entryOf(s, tab.id, tab.history.index - 1), false);
        // The browser history queues one change per microtask: the replace must land first.
        history.flush();
        write(entry, true);
        return;
      }
    }
    const at = current.state as EntryState;
    if (current.href === publicHref(entry.href) && (at.mcTab ?? null) === entry.tab && (at.mcStep ?? null) === entry.step) return;
    write(entry, push);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, state.activeTab, active?.kind, active?.params, active?.history.index, activeName, state.layout.tool, state.missingLink]);

  const api = useRef({
    pushNext: (tabId: string) => {
      // Only the active tab's steps reach the URL; a tab in the background moves silently.
      pendingPush.current = tabId === stateRef.current.activeTab ? tabId : null;
    },
  });
  return api.current;
}

const DISCONNECTED: ConnState = { status: "disconnected", connId: null };

function Shell({ tools, routerConfig }: { tools: readonly ToolModule[]; routerConfig: RouterConfig }) {
  const router = useRouter();
  const services = useServices();
  const { client, storage } = services;
  const { state, dispatch } = useStore();
  const toast = useToast();
  const stateRef = useRef(state);
  stateRef.current = state;
  const heldPop = useRef(false);
  const tool = toolById(tools, state.layout.tool) ?? tools[0]!;
  // The tool navigation (DOC-21 §3.1): its order sets Alt+Shift+1…9; the drawer is the default from
  // 1280 px of window width, the rail below; an expanded drawer floats over the panes below 1024 px.
  const nav = useMemo(() => navOrder(tools, state.layout.pinnedTools), [tools, state.layout.pinnedTools]);
  const width = useWindowWidth();
  const navCollapsed = state.layout.navCollapsed ?? width < NAV_DRAWER_FROM;
  const navOverlay = !navCollapsed && width < NAV_OVERLAY_BELOW;
  const profiles = state.profiles ?? [];
  const profileById = (id: string) => stateRef.current.profiles?.find((p) => p.id === id);
  const connOf = (id: string): ConnState => stateRef.current.conns[id] ?? DISCONNECTED;
  const activeTab = state.tabs.find((t) => t.id === state.activeTab) ?? null;
  const activeProfile = activeTab ? profiles.find((p) => p.id === activeTab.profileId) : state.selectedNode ? profiles.find((p) => p.id === parseNode(state.selectedNode!)?.profileId) : undefined;
  const tabActions = useRef(new Map<string, () => TabActionHandlers>());
  const supervisor = useRef<Supervisor | null>(null);
  const [focusPane, setFocusPane] = useState(0);
  // The person's session (DOC-25 §3.2.4): who they are, the warning before a limit, and the dialog
  // for a session that ended while the app is open (the shell stays under it with its work).
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [myAccessOpen, setMyAccessOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const session = useSession(client, state.server);
  const { expiry, later: laterExpiry } = useExpiry(session.me, session.now);
  const signInAgain = useSignInAgain(routerConfig.basePath, state.server === "signedOut", () => supervisor.current?.retryNow());
  const idpName = typeof document === "undefined" ? null : document.querySelector<HTMLMetaElement>(`meta[name="${IDP_META}"]`)?.content || null;

  const note = useCallback(
    (error: unknown): DescribedError => {
      const d = describeError(error);
      const line = diagnosticLine(d, new Date());
      if (line) dispatch({ type: "diagnostic", line });
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
  // Profiles live on the server (DOC-25 §3.4.2, TSK-139); the browser's own records wait in
  // IndexedDB until the person moves them ("Move my profiles to the server", §3.4.9).
  const reloadProfiles = useCallback(async () => {
    try {
      const records = await listServerProfiles(client);
      dispatch({ type: "profiles", profiles: records, recordStates: recordStatesOf(records, schemaOf) });
      return records;
    } catch (e) {
      const d = note(e);
      toast.add({ title: "Could not read the profiles", description: d.title, type: "danger", timeout: 0 });
      dispatch({ type: "profiles", profiles: [] });
      return null;
    }
  }, [storage, schemaOf, dispatch, note, toast]);

  // SSH hosts (DOC-23 §4.3): the Docker form, its trust dialog and Settings read the same list.
  const reloadHosts = useCallback(() => {
    reloadSshHosts(client).catch(() => {});
  }, [client]);

  useEffect(() => {
    void reloadProfiles();
    void reloadBrowserProfiles();
    reloadHosts();
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

  /** Saves a change to a stored profile's fields or extras (a saved filter, a trusted key). */
  const saveProfile = async (record: ProfileRecord) => {
    await updateServerRecord(client, record);
    await reloadProfiles();
  };

  // --- The browser's own profiles, to move to the server (DOC-25 §3.4.9) -------------------------

  const [browserProfiles, setBrowserProfiles] = useState<ProfileRecord[]>([]);
  const movePrompted = useRef(false);
  useEffect(() => {
    if (browserProfiles.length === 0 || movePrompted.current) return;
    movePrompted.current = true;
    toast.add({
      title: `${browserProfiles.length} profile${browserProfiles.length === 1 ? " is" : "s are"} kept in this browser`,
      description: "Move them to the server, where their secrets are stored encrypted. Until then they are not listed.",
      type: "info",
      timeout: 0,
      actionProps: { children: "Move to the server", onClick: () => dispatch({ type: "dialog", dialog: { kind: "moveProfiles" } }) },
    });
  }, [browserProfiles, toast, dispatch]);
  const reloadBrowserProfiles = useCallback(async () => {
    try {
      const loaded = await loadProfiles(storage, schemaOf);
      setBrowserProfiles(loaded.records.filter((r) => r.importedAs === undefined && loaded.states[r.id]?.kind === "current"));
    } catch (e) {
      note(e);
    }
  }, [storage, schemaOf, note]);

  // --- Connections ------------------------------------------------------------------------------

  // A connect that failed with `HostKey` (spec §10.2) asks the person to trust the key.
  const [hostKeyPrompt, setHostKeyPrompt] = useState<{ profileId: string; details: HostKeyDetails } | null>(null);

  /**
   * Sets a connection's state and writes it to `stateRef` at once, so a connect that answers
   * before React renders again (a fast server, a call made outside an event) still sees its own
   * `connecting` and is not taken for a cancelled one.
   */
  const setConn = (profileId: string, conn: ConnState) => {
    stateRef.current = { ...stateRef.current, conns: { ...stateRef.current.conns, [profileId]: conn } };
    dispatch({ type: "conn", profileId, conn });
  };

  const connectProfile = useCallback(
    async (profileId: string, record?: ProfileRecord): Promise<boolean> => {
      const profile = record ?? profileById(profileId);
      const t = profile ? toolById(tools, profile.tool) : undefined;
      if (!profile || !t) return false;
      const current = connOf(profileId);
      if (current.status === "connected") return true;
      if (current.status === "connecting") return false;
      setConn(profileId, { status: "connecting", connId: null, since: Date.now() });
      try {
        const { connId } = await t.connect(client, profile);
        // Cancelled while it was connecting: release what arrived.
        if (connOf(profileId).status !== "connecting") {
          void t.disconnect(client, connId).catch(() => {});
          return false;
        }
        setConn(profileId, { status: "connected", connId });
        return true;
      } catch (e) {
        const error = note(e);
        if (connOf(profileId).status === "connecting") {
          setConn(profileId, { status: "failed", connId: null, error });
          if (error.hostKey && t.trustHostKey) setHostKeyPrompt({ profileId, details: error.hostKey });
        }
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, tools, dispatch, note],
  );

  /** Stores the key the person trusted and connects again with it. */
  const trustHostKey = async (profileId: string, key: HostKeyFingerprint) => {
    setHostKeyPrompt(null);
    const record = profileById(profileId);
    const t = record ? toolById(tools, record.tool) : undefined;
    if (!record || !t?.trustHostKey) return;
    try {
      await t.trustHostKey(client, record, key);
    } catch (e) {
      note(e);
      return;
    }
    setConn(profileId, DISCONNECTED);
    void connectProfile(profileId, record);
  };

  const disconnectProfile = (profileId: string) => {
    const conn = connOf(profileId);
    const profile = profileById(profileId);
    const t = profile ? toolById(tools, profile.tool) : undefined;
    dispatch({ type: "conn", profileId, conn: DISCONNECTED });
    if (conn.connId && t) void t.disconnect(client, conn.connId).catch(note);
  };

  const handleEvent = (event: AppEvent) => {
    if (event.kind === "StreamProgress") return services.progress.publish(event);
    if (event.kind === "SshHostChanged") return reloadHosts();
    if (event.kind === "ProfileChanged") {
      // A host lists the profiles that use it.
      reloadHosts();
      return void reloadProfiles();
    }
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
        if (status === "lost" || status === "signedOut") dispatch({ type: "connsReset", status: "reconnecting", message: status === "lost" ? "the server connection was lost" : "you were signed out" });
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

  /** Opens (or focuses) a resource's tab; `preview` puts it in the tool's preview tab (DOC-21 §3.2.1). */
  const openResource = (profileId: string, node: ResourceNode, options: { preview?: boolean } = {}) => {
    const profile = profileById(profileId);
    if (!profile || !node.open) return;
    const id = tabIdOf(profile.tool, profileId, node.open.kind, node.open.params);
    const place: TabPlace = { kind: node.open.kind, params: node.open.params, title: node.open.title };
    dispatch({ type: "openTab", tab: { id, tool: profile.tool, profileId, ...place, pinned: false, history: initialHistory(place) }, ...(options.preview ? { preview: true } : {}) });
  };

  // --- Routing (DOC-21 §3.7) --------------------------------------------------------------------

  // --- The tree follows the focused tab (DOC-21 §3.2.1) ----------------------------------------
  // Activating a tab (a click, the keyboard, the URL, Back and Forward, a link, the palette) shows
  // its node: its tool in the navigation, its tree, its ancestors open, the node selected and
  // scrolled to. Keyboard focus stays where it is. A tool picked by hand holds until the next one.
  const [revealAgain, setRevealAgain] = useState(0);
  const focusedTab = state.missingLink ? undefined : state.tabs.find((t) => t.id === state.activeTab);
  const focusedPlace = focusedTab ? `${focusedTab.id}\n${focusedTab.kind}\n${JSON.stringify(focusedTab.params)}` : "";
  const profilesLoaded = state.profiles !== null;
  // The focus a reveal answers, and the tool shown when it came: when only the profiles arrive
  // (after a reload) and a tool was picked by hand meanwhile, that pick holds until the next focus.
  const revealFor = useRef<{ key: string; tool: string } | null>(null);
  useEffect(() => {
    const key = `${focusedPlace}\n${revealAgain}`;
    if (revealFor.current?.key !== key) revealFor.current = { key, tool: stateRef.current.layout.tool };
    else if (stateRef.current.layout.tool !== revealFor.current.tool) return;
    const tab = stateRef.current.tabs.find((t) => t.id === stateRef.current.activeTab);
    if (!tab || stateRef.current.missingLink || !profilesLoaded) return;
    const tabTool = toolById(tools, tab.tool);
    const profile = profileById(tab.profileId);
    if (!tabTool || !profile) return;
    const root = profileNodeId(profile.id);
    dispatch({ type: "reveal", tool: tabTool.id, profileId: profile.id, path: [root, ...tabTool.nodeOfTab(tab, profile).map((id) => `${root}/${id}`)] });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new focused tab or place, or the focused tab clicked again
  }, [focusedPlace, revealAgain, profilesLoaded]);

  const routes = useRouteSync({
    router,
    config: routerConfig,
    tools,
    state,
    stateRef,
    dispatch,
    heldPop,
    missingProfile: (t, name, place) => {
      const kind = place ? t.tabKinds[place.kind] : undefined;
      const href = place ? placeHref(t, { name }, place) : `/${t.id}/${segment(name)}`;
      dispatch({ type: "missingLink", link: { tool: t.id, profileName: name, href, place, title: kind && place ? kind.title(place.params) : name } });
    },
  });

  /** The link's place opened with a profile (created, imported or picked): the page goes. */
  const openLinkWith = (profileId: string) => {
    const link = stateRef.current.missingLink;
    const profile = profileById(profileId);
    if (!link || !profile) return;
    if (!link.place) {
      dispatch({ type: "missingLink", link: null });
      dispatch({ type: "select", nodeId: profileNodeId(profileId) });
      return;
    }
    const place: TabPlace = { ...link.place, title: link.title };
    dispatch({ type: "openTab", tab: { id: tabIdOf(profile.tool, profileId, place.kind, place.params), tool: profile.tool, profileId, ...place, pinned: false, history: initialHistory(place) } });
  };

  // Once a profile with the link's name exists (created or imported), the link opens where it points.
  useEffect(() => {
    const link = state.missingLink;
    const found = link ? state.profiles?.find((p) => p.tool === link.tool && p.name === link.profileName) : undefined;
    if (found) openLinkWith(found.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.missingLink, state.profiles]);

  /** A router href as the page's address bar shows it: what Copy link copies. */
  const absoluteLink = (href: string) =>
    routerConfig.mode === "browser" ? `${location.origin}${routerConfig.basePath}${href}` : routerConfig.mode === "hash" ? `${location.origin}${routerConfig.basePath}/#${href}` : href;

  /** A tab's step as the Back list names it: "History · order-48213". */
  const stepLabel = (t: ToolModule, profile: ProfileRecord, place: TabPlace) => {
    const href = placeHref(t, profile, place);
    const leaf = href === `/${t.id}` ? undefined : crumbsOf(router, href).at(-1)?.label;
    return leaf && leaf !== place.title && !place.title.includes(leaf) ? `${leaf} · ${place.title}` : place.title;
  };

  /** The navigation row's segments for a router href (DOC-21 §3.7), bound to a tab or a link. */
  const navCrumbs = (
    href: string | null,
    profile: ProfileRecord | undefined,
    profileName: string,
    title: string,
    go: ((place: Omit<TabPlace, "title">, newTab: boolean) => void) | null,
  ): NavCrumb[] => {
    const routed = href ? crumbsOf(router, href) : [];
    if (routed.length === 0) return [{ key: "profile", label: profileName, icon: Server }, ...(title ? [{ key: "title", label: title }] : [])];
    return routed.map((c: RouteCrumb, i): NavCrumb => {
      const crumb: NavCrumb = { key: c.routeId, label: c.label, ...(c.profile ? { icon: Server } : {}) };
      if (go && c.place && i < routed.length - 1) crumb.open = (newTab) => go(c.place!, newTab);
      if (go && c.siblings && profile && href) {
        const list = c.siblings;
        crumb.siblings = async (): Promise<SiblingMenu> => {
          const conn = connOf(profile.id);
          const out = await list({ params: c.params, profile, client, connId: conn.status === "connected" ? conn.connId : null });
          return {
            heading: out.heading,
            items: out.items.map((item) => ({
              key: JSON.stringify(item.params),
              label: item.label,
              ...(item.description ? { description: item.description } : {}),
              current: Object.entries(item.params).every(([k, v]) => c.params[k] === v),
              select: () => {
                const next = withParams(router, href, item.params, item.search);
                const target = next ? targetOfHref(router, next, tools) : null;
                if (target?.type === "place") go(target.place, false);
              },
            })),
            ...(out.all ? { all: { label: out.all.label, select: () => go(out.all!.place, false) } } : {}),
          };
        };
      }
      return crumb;
    });
  };

  /** The navigation row of a tab. */
  const navOf = (t: TabRecord, profile: ProfileRecord | undefined): NavRowProps | null => {
    const tabTool = toolById(tools, t.tool);
    if (!tabTool || !profile) return null;
    const href = placeHref(tabTool, profile, t);
    const routed = href !== `/${tabTool.id}`;
    const go = (place: Omit<TabPlace, "title">, newTab: boolean) => {
      const kind = tabTool.tabKinds[place.kind];
      if (!kind) return;
      const full: TabPlace = { ...place, title: kind.title(place.params) };
      if (newTab) openResource(t.profileId, { id: "", label: full.title, open: full });
      else navigateTab(t.id, full);
    };
    return {
      crumbs: navCrumbs(routed ? href : null, profile, profile.name, t.title, go),
      link: routed ? href : null,
      onCopyLink: () => copyLink(href),
      canBack: canGo(t, -1),
      canForward: canGo(t, 1),
      onBack: () => guarded(t.id, () => dispatch({ type: "tabGo", id: t.id, delta: -1 })),
      onForward: () => guarded(t.id, () => dispatch({ type: "tabGo", id: t.id, delta: 1 })),
      stepCount: t.history.entries.length,
      steps: () => t.history.entries.map((e, i) => ({ label: stepLabel(tabTool, profile, e), current: i === t.history.index })),
      onStep: (index) => guarded(t.id, () => dispatch({ type: "tabStep", id: t.id, step: index })),
    };
  };

  /** "Go to parent": the nearest segment above the current one that is a place, as a step. */
  const goParent = () => {
    const tab = stateRef.current.tabs.find((t) => t.id === stateRef.current.activeTab);
    const nav = tab ? navOf(tab, profileById(tab.profileId)) : null;
    const parent = nav?.crumbs.slice(0, -1).findLast((c) => c.open);
    parent?.open?.(false);
  };

  // --- Unsaved changes (DOC-21 §3.7) ------------------------------------------------------------
  // A sheet with a changed draft guards its tab (useSheetGuard): the tab's own moves ask first, the
  // browser's Back and Forward are held by the router's blocker, leaving the page asks the browser.

  const guards = useRef(new Map<string, Set<object>>());
  const guardSetters = useRef(new Map<string, LeaveGuardSetter>());
  const guardFor = (tabId: string): LeaveGuardSetter => {
    let set = guardSetters.current.get(tabId);
    if (!set) {
      set = (key, dirty) => {
        const keys = guards.current.get(tabId) ?? new Set<object>();
        if (dirty) keys.add(key);
        else keys.delete(key);
        // Unsaved changes are state to lose: the preview tab is kept (DOC-21 §3.2.1).
        if (dirty && tabId !== SHELL_GUARD) dispatch({ type: "keepTab", id: tabId });
        if (keys.size > 0) guards.current.set(tabId, keys);
        else guards.current.delete(tabId);
      };
      guardSetters.current.set(tabId, set);
    }
    return set;
  };
  const isGuarded = (tabId: string | null) => tabId !== null && (guards.current.get(tabId)?.size ?? 0) > 0;
  const [leaving, setLeaving] = useState<{ tabId: string; run: () => void } | null>(null);
  /** Runs a move of the tab, after "Discard changes?" when a sheet in it has changes. */
  const guarded = (tabId: string, run: () => void) => {
    if (isGuarded(tabId)) setLeaving({ tabId, run });
    else run();
  };
  const blocker = useBlocker({
    shouldBlockFn: ({ action }) => (action === "BACK" || action === "FORWARD" || action === "GO") && (isGuarded(stateRef.current.activeTab) || isGuarded(SHELL_GUARD)),
    enableBeforeUnload: () => guards.current.size > 0,
    withResolver: true,
  });
  const keepEditing = () => {
    if (blocker.status === "blocked") {
      heldPop.current = true;
      blocker.reset();
    }
    setLeaving(null);
  };
  const discardChanges = () => {
    if (blocker.status === "blocked") {
      const active = stateRef.current.activeTab;
      if (active) guards.current.delete(active);
      guards.current.delete(SHELL_GUARD);
      blocker.proceed();
      return;
    }
    if (!leaving) return;
    guards.current.delete(leaving.tabId);
    setLeaving(null);
    leaving.run();
  };

  const navigateTab = useCallback(
    (tabId: string, place: TabPlace, options?: { replace?: boolean }) => {
      const run = () => {
        if (!options?.replace) routes.pushNext(tabId);
        dispatch({ type: "navigateTab", id: tabId, place, ...(options?.replace ? { replace: true } : {}) });
      };
      // A section shown (replace) stays on the place; a step leaves it.
      if (options?.replace) run();
      else guarded(tabId, run);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes, dispatch],
  );

  /** Back (`-1`) or forward (`1`) in the active tab's own history. */
  const goActive = (delta: number) => {
    const tab = stateRef.current.tabs.find((t) => t.id === stateRef.current.activeTab);
    if (tab && canGo(tab, delta)) guarded(tab.id, () => dispatch({ type: "tabGo", id: tab.id, delta }));
  };

  // In memory mode no browser history turns the mouse's back and forward buttons into steps.
  useEffect(() => {
    if (routerConfig.mode !== "memory") return;
    const listener = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      goActive(event.button === 3 ? -1 : 1);
    };
    window.addEventListener("mouseup", listener);
    return () => window.removeEventListener("mouseup", listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerConfig.mode]);

  const closeTab = (id: string, force = false) => {
    if (!force && isGuarded(id)) {
      setLeaving({ tabId: id, run: () => closeTab(id) });
      return;
    }
    const live = stateRef.current.live[id];
    if (!force && live && live.status !== "ended") {
      dispatch({ type: "dialog", dialog: { kind: "closeTab", id } });
      return;
    }
    tabActions.current.get(id)?.().stop?.();
    autoConnected.current.delete(id);
    dispatch({ type: "closeTab", id });
  };
  /** Closes several tabs (a group's menu): those holding state stay, and the first of them asks (§3.2). */
  const closeMany = (ids: readonly string[]) => {
    const holds = (id: string) => {
      const live = stateRef.current.live[id];
      return isGuarded(id) || (live !== undefined && live !== null && live.status !== "ended");
    };
    for (const id of ids) if (!holds(id)) closeTab(id, true);
    const asking = ids.find(holds);
    if (asking) closeTab(asking);
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
  const keepSetters = useRef(new Map<string, () => void>());
  const keepFor = (tabId: string) => {
    let keep = keepSetters.current.get(tabId);
    if (!keep) {
      keep = () => dispatch({ type: "keepTab", id: tabId });
      keepSetters.current.set(tabId, keep);
    }
    return keep;
  };
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
    const t = nav[index];
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
      case "tool7":
      case "tool8":
      case "tool9":
        switchTool(Number(id.slice(4)) - 1);
        break;
      case "toggleToolNav":
        // From the rail the drawer opens (over the panes when the window is narrow); from the drawer, the rail.
        dispatch({ type: "layout", layout: { navCollapsed: navCollapsed ? false : width < NAV_DRAWER_FROM ? null : true } });
        break;
      case "findTool":
        if (navCollapsed) dispatch({ type: "layout", layout: { navCollapsed: false } });
        requestAnimationFrame(() => (document.getElementById(FIND_TOOL_ID) ?? document.querySelector<HTMLElement>("[data-pane='rail'] [data-nav-item][tabindex='0']"))?.focus());
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
      case "moveProfiles":
        dispatch({ type: "dialog", dialog: { kind: "moveProfiles" } });
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
      case "back":
        goActive(-1);
        break;
      case "forward":
        goActive(1);
        break;
      case "parent":
        goParent();
        break;
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
      // Alt+Left and Alt+Right move by words in a text control (macOS).
      if ((action.id === "back" || action.id === "forward") && inText) return;
      if (action.id === "stop" && !(state.activeTab && state.live[state.activeTab]?.status !== "ended" && state.live[state.activeTab])) return;
      event.preventDefault();
      perform(action.id);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  });

  // A drawer floating over the panes closes on Escape, as the scrim does on a click.
  useEffect(() => {
    if (!navOverlay) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && state.dialog.kind === "none" && !state.paletteOpen) dispatch({ type: "layout", layout: { navCollapsed: null } });
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [navOverlay, state.dialog.kind, state.paletteOpen, dispatch]);

  // --- Palette ----------------------------------------------------------------------------------

  const signedIn = session.me !== null;
  const paletteGroups: CommandGroup[] = useMemo(() => {
    type Item = CommandGroup["items"][number];
    const goTo: Item[] = [];
    const actions: Item[] = [];
    const connections: Item[] = [];
    const app: Item[] = [];
    for (const [i, t] of nav.entries()) {
      goTo.push({ id: `tool:${t.id}`, label: `Tool: ${t.label}`, shortcut: i < 9 ? bindingOf(`tool${i + 1}` as ActionId) : "", keywords: [t.id, toolCategory(t)], onSelect: () => switchTool(i) });
    }
    for (const p of profiles) {
      const t = toolById(tools, p.tool);
      const conn = state.conns[p.id];
      if (!t || conn?.status !== "connected" || !conn.connId) continue;
      const walk = (nodes: readonly ResourceNode[]) => {
        for (const n of nodes) {
          if (n.open) goTo.push({ id: `res:${p.id}/${n.id}`, label: n.open.title, keywords: [p.name, t.label], onSelect: () => openResource(p.id, n, { preview: true }) });
          if (n.children) walk(n.children);
        }
      };
      walk(t.sidebarTree({ profile: p, connId: conn.connId }));
    }
    for (const tab of state.tabs) goTo.push({ id: `tab:${tab.id}`, label: `Tab: ${tab.title}`, onSelect: () => dispatch({ type: "activateTab", id: tab.id }) });
    for (const a of ACTIONS) {
      if (a.id === "palette") continue;
      const toolIndex = a.id.startsWith("tool") ? Number(a.id.slice(4)) - 1 : -1;
      const label = toolIndex >= 0 ? (nav[toolIndex] ? `Switch to ${nav[toolIndex]!.label}` : `${a.label} (no tool)`) : a.label;
      const item: Item = {
        id: a.id,
        label,
        shortcut: bindingOf(a.id),
        ...(a.keywords ? { keywords: a.keywords } : {}),
        disabled:
          (toolIndex >= 0 && !nav[toolIndex]) ||
          ((a.group === "Live views" || a.id === "primary" || a.id === "closeTab") && !state.activeTab) ||
          ((a.id === "back" || a.id === "forward") && !(activeTab && canGo(activeTab, a.id === "back" ? -1 : 1))) ||
          (a.id === "parent" && !(activeTab && navOf(activeTab, profileById(activeTab.profileId))?.crumbs.slice(0, -1).some((c) => c.open))),
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
        for (const ta of t.actions) actions.push({ id: `action:${p.id}:${ta.id}`, label: `${ta.label} (${p.name})`, ...(ta.keywords ? { keywords: ta.keywords } : {}), onSelect: () => void ta.run({ client, profile: p, connId: conn.connId!, openTab: (open) => openResource(p.id, { id: "", label: open.title, open }) }) });
      }
    }
    for (const t of tools) connections.push({ id: `add:${t.id}`, label: `Add ${t.label} connection`, onSelect: () => dispatch({ type: "dialog", dialog: { kind: "profile", tool: t.id } }) });
    if (signedIn) {
      if (session.me && holdsAnywhere(session.me, "admin.users.read")) app.push({ id: "account:admin", label: "Users and roles", keywords: ["administration", "people", "roles", "groups"], onSelect: () => setAdminOpen(true) });
      if (session.me && holdsAnywhere(session.me, "audit.read")) app.push({ id: "account:audit", label: "Audit log", keywords: ["audit", "who did what", "history", "security"], onSelect: () => setAuditOpen(true) });
      app.push({ id: "account:sessions", label: "Sessions", keywords: ["account", "sign out"], onSelect: () => setSessionsOpen(true) });
      app.push({ id: "account:signout", label: "Sign out", keywords: ["account", "log out"], onSelect: () => void signOut(routerConfig.basePath) });
    }
    return [
      { label: "Go to", items: goTo },
      { label: "Actions", items: actions },
      { label: "Connections", items: connections },
      { label: "App", items: app },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools, nav, profiles, state.conns, state.tabs, state.activeTab, client, navCollapsed, width, signedIn]);

  // --- Dialog helpers ---------------------------------------------------------------------------

  const dialog = state.dialog;
  const closeDialog = () => dispatch({ type: "dialog", dialog: { kind: "none" } });
  const profileDialog = dialog.kind === "profile" ? dialog : null;
  const sheetTool = profileDialog ? (toolById(tools, profileDialog.tool) ?? tool) : tool;
  const sheetBase = profileDialog?.editId ? profiles.find((p) => p.id === profileDialog.editId) : profileDialog?.duplicateOf ? profiles.find((p) => p.id === profileDialog.duplicateOf) : undefined;
  const sheetMode = profileDialog?.editId ? "edit" : profileDialog?.duplicateOf ? "duplicate" : "add";
  // How many people a new shared profile of this tool reaches: asked of administrators while the add sheet is open.
  const canShareProfiles = session.me ? holdsAnywhere(session.me, "profiles.manage") && holdsAnywhere(session.me, "admin.users.read") : false;
  const audience = useAudience(client, canShareProfiles && profileDialog !== null && sheetMode === "add", sheetTool.id);
  const takenNames = new Set(profiles.filter((p) => p.tool === sheetTool.id && !(sheetMode === "edit" && p.id === sheetBase?.id)).map((p) => p.name));
  const exportCount = dialog.kind === "export" ? (dialog.ids ?? profiles.map((p) => p.id)).length : 0;
  const deleting = dialog.kind === "deleteProfile" ? profiles.find((p) => p.id === dialog.id) : undefined;
  const closing = dialog.kind === "closeTab" ? state.tabs.find((t) => t.id === dialog.id) : undefined;

  const doExport = (includeSecrets: boolean) => {
    if (dialog.kind !== "export") return;
    const ids = new Set(dialog.ids ?? profiles.map((p) => p.id));
    const file = exportFile(
      profiles.filter((p) => ids.has(p.id)),
      { includeSecrets, app: state.info?.version ?? "0.1.0", hosts: sshHosts() },
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
    const stored = stateRef.current.profiles ?? [];
    // Replace keeps the stored profile (an edit of it); anything else is a new profile, imported
    // once per record id (a second import of the same file makes nothing new).
    const { writes } = applyImport(plan, stored);
    // The SSH hosts the profiles name come first, once per host of the file (DOC-23 §8.1).
    const hostIds = new Map<string, string>();
    for (const host of plan.hosts) {
      if (!writes.some((w) => w.fields["sshHostId"] === host.id)) continue;
      const out = await client.sshHosts.import({ sourceId: host.id, name: host.name, owner: { kind: "personal" }, fields: host.fields });
      hostIds.set(host.id, out.host.id);
    }
    for (const write of writes) {
      const id = write.fields["sshHostId"];
      const record = typeof id === "string" && hostIds.has(id) ? { ...write, fields: { ...write.fields, sshHostId: hostIds.get(id) } } : write;
      const existing = stored.find((p) => p.id === record.id);
      if (existing) await saveServerProfile(client, record, { mode: "edit", base: existing });
      else await importRecord(client, record);
    }
    await reloadProfiles();
    closeDialog();
    toast.add({ title: `Imported ${writes.length} profile${writes.length === 1 ? "" : "s"}`, type: "success" });
  };

  /** The backup before a move: the browser's records with their secrets, in plain text. */
  const doBackup = () => {
    const file = exportFile(browserProfiles, { includeSecrets: true, app: state.info?.version ?? "0.1.0" });
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const doMove = async (shared: ReadonlySet<string>) => {
    const result = await moveToServer(client, storage, browserProfiles, shared, (m) => dispatch({ type: "remapProfile", from: m.from, to: m.to }));
    await reloadProfiles();
    await reloadBrowserProfiles();
    if (result.failed) throw result.failed.error;
    closeDialog();
    toast.add({ title: `Moved ${result.moved.length} profile${result.moved.length === 1 ? "" : "s"} to the server`, description: "This browser keeps no secret now.", type: "success" });
  };

  const doDelete = async (id: string) => {
    disconnectProfile(id);
    for (const t of stateRef.current.tabs) if (t.profileId === id) closeTab(t.id, true);
    const record = profileById(id);
    if (record) await deleteServerProfile(client, record);
    await reloadProfiles();
    closeDialog();
  };

  // --- Render -----------------------------------------------------------------------------------

  const activeConn = activeProfile ? (state.conns[activeProfile.id] ?? DISCONNECTED) : null;
  const activeLive = state.activeTab ? state.live[state.activeTab] : null;
  const notify = useCallback(
    (n: Notice) =>
      toast.add({
        title: n.title,
        ...(n.description ? { description: n.description } : {}),
        type: n.type,
        timeout: n.action ? 10_000 : 3000,
        ...(n.action ? { actionProps: { children: n.action.label, onClick: n.action.onClick } } : {}),
      }),
    [toast],
  );
  const copyLink = async (href: string) => {
    const link = absoluteLink(href);
    try {
      await navigator.clipboard.writeText(link);
      notify({ title: "Copied link", description: link.length > 64 ? `${link.slice(0, 61)}…` : link, type: "success" });
    } catch {
      notify({ title: "Could not copy the link", description: "The browser refused the clipboard. Select the link text instead.", type: "warning" });
    }
  };
  const missingLink = state.missingLink;
  const linkTool = missingLink ? toolById(tools, missingLink.tool) : undefined;
  const linkPage = (link: MissingLink) => {
    const crumbs = navCrumbs(link.href, undefined, link.profileName, link.title, null);
    return (
      <MissingProfilePage
        toolLabel={linkTool?.label ?? link.tool}
        profileName={link.profileName}
        where={crumbs.length > 1 ? crumbs.slice(1).map((c) => c.label).join(" › ") : ""}
        others={profiles.filter((p) => p.tool === link.tool)}
        onCreate={() => dispatch({ type: "dialog", dialog: { kind: "profile", tool: link.tool, name: link.profileName } })}
        onImport={() => perform("importProfiles")}
        onOpenWith={openLinkWith}
        nav={
          <NavRow
            crumbs={crumbs}
            link={link.href}
            onCopyLink={() => void copyLink(link.href)}
            canBack={false}
            canForward={false}
            onBack={() => {}}
            onForward={() => {}}
            stepCount={0}
            steps={() => []}
            onStep={() => {}}
          />
        }
      />
    );
  };
  const toolState =(t: ToolModule): ToolState => {
    const mine = profiles.filter((p) => p.tool === t.id);
    return { connected: mine.filter((p) => state.conns[p.id]?.status === "connected").length, failed: mine.some((p) => state.conns[p.id]?.status === "failed") };
  };

  // Why the person cannot use a tool: none of their roles holds its read permission anywhere (and they keep no personal profiles).
  const lockedBy = (t: ToolModule): Refusal | null =>
    session.me && !toolOpen(session.me, t.id) ? refusalBefore(session.me, toolPerm(t.id), `Using ${t.label}`, { profile: `a ${t.label} profile` }) : null;
  const toolRefusal = lockedBy(tool);
  const access: AccessValue = {
    me: session.me,
    admins: null,
    openMyAccess: () => setMyAccessOpen(true),
    profileName: (id) => stateRef.current.profiles?.find((p) => p.id === id)?.name,
  };

  return (
    <AccessProvider value={access}>
    <NoticeContext value={notify}>
    <SidebarProvider open={state.layout.sidebarOpen} onOpenChange={(open) => dispatch({ type: "layout", layout: { sidebarOpen: open } })} className="h-full">
      <Tabs value={missingLink ? LINK_TAB : (state.activeTab ?? "")} onValueChange={(v) => {
          const value = String(v);
          const group = groupOfValue(value);
          // A folded group's chip opens the group on its last focused tab (DOC-21 §3.2.1).
          if (group !== null) dispatch({ type: "openGroup", tool: group });
          else if (value !== LINK_TAB) dispatch({ type: "activateTab", id: value });
        }} size="medium" className="mc-root flex h-full min-h-0 w-full flex-col gap-0 text-fg">
        {expiry ? (
          <ExpiryBar
            expiry={expiry}
            onStay={() => void session.refresh()}
            onSignInAgain={() => {
              // The time limit cannot be extended: end this session, keep the page and its work, and sign in again at the other tab.
              void signOut(routerConfig.basePath, fetch, () => {}).then(signInAgain.open);
            }}
            onLater={laterExpiry}
          />
        ) : null}
        <header className="flex shrink-0 items-center gap-inline-md py-inset-xs ps-inset-xs pe-inset-sm" aria-label="Title area">
          <SidebarTrigger />
          <span className="flex shrink-0 items-center gap-inline-md pe-inline-lg text-body-1-strong">
            <Icon icon={Server} filled size="lg" tone="accent" />
            Mightyconsole
          </span>
          {state.tabs.length > 0 || missingLink ? (
            <TabStrip
              tools={tools}
              tabs={state.tabs}
              groups={state.groups}
              activeTab={state.activeTab}
              live={state.live}
              conns={state.conns}
              profileName={(id) => profileById(id)?.name ?? id}
              missingLink={missingLink}
              linkTab={LINK_TAB}
              onCloseLink={() => dispatch({ type: "missingLink", link: null })}
              onClose={(id) => closeTab(id)}
              onCloseMany={closeMany}
              onMoveTab={(id, index) => dispatch({ type: "moveTab", id, index })}
              onMoveGroup={(tool, index) => dispatch({ type: "moveGroup", tool, index })}
              onOpenGroup={(tool) => dispatch({ type: "openGroup", tool })}
              onKeep={(id) => dispatch({ type: "keepTab", id })}
              onRevealAgain={() => setRevealAgain((n) => n + 1)}
              onCopyLink={(id) => {
                const t = state.tabs.find((x) => x.id === id);
                const tabTool = t ? toolById(tools, t.tool) : undefined;
                const profile = t ? profileById(t.profileId) : undefined;
                if (t && tabTool && profile) void copyLink(placeHref(tabTool, profile, t));
              }}
            />
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
          {session.me ? (
            <AccountMenu me={session.me} idpName={idpName} startedMs={session.startedMs} settingsBinding={bindingOf("settings")} onSessions={() => setSessionsOpen(true)} onMyAccess={() => setMyAccessOpen(true)} {...(holdsAnywhere(session.me, "admin.users.read") ? { onAdmin: () => setAdminOpen(true) } : {})} {...(holdsAnywhere(session.me, "audit.read") ? { onAudit: () => setAuditOpen(true) } : {})} onSettings={() => perform("settings")} onSignOut={() => void signOut(routerConfig.basePath)} />
          ) : null}
        </header>
        <div className="relative flex min-h-0 flex-1">
          <ToolNav
            tools={tools}
            selected={tool.id}
            onSelect={(id) => {
              dispatch({ type: "layout", layout: { tool: id, ...(navOverlay ? { navCollapsed: null } : {}) } });
            }}
            stateOf={toolState}
            collapsed={navCollapsed}
            overlay={navOverlay}
            onToggleCollapsed={() => perform("toggleToolNav")}
            pinned={state.layout.pinnedTools}
            onTogglePin={(id) => dispatch({ type: "layout", layout: { pinnedTools: state.layout.pinnedTools.includes(id) ? state.layout.pinnedTools.filter((p) => p !== id) : [...state.layout.pinnedTools, id] } })}
            closedCategories={state.layout.closedCategories}
            onToggleCategory={(c) => dispatch({ type: "layout", layout: { closedCategories: state.layout.closedCategories.includes(c) ? state.layout.closedCategories.filter((x) => x !== c) : [...state.layout.closedCategories, c] } })}
            bindingAt={(i) => (i >= 0 && i < 9 ? bindingOf(`tool${i + 1}` as ActionId) : "")}
            onAbout={() => perform("about")}
            findId={FIND_TOOL_ID}
            lockedBy={lockedBy}
          />
          {navOverlay ? <div aria-hidden="true" className="absolute inset-0 z-[var(--by-z-sticky)] bg-scrim" onClick={() => dispatch({ type: "layout", layout: { navCollapsed: null } })} /> : null}
          <Resizable orientation="horizontal" sizes={state.layout.sidebarOpen ? state.layout.shellSizes : [0, 100]} onSizesChange={(sizes) => state.layout.sidebarOpen && dispatch({ type: "layout", layout: { shellSizes: sizes } })} className="min-h-0 flex-1 ps-gap-sm pe-gap-sm" aria-label="Sidebar and workspace">
            <ResizablePanel minSize={state.layout.sidebarOpen ? 12 : 0} maxSize={state.layout.sidebarOpen ? 50 : 0}>
              <Sidebar aria-label={`${tool.label} connections`} collapsible="offcanvas" className="h-full w-full rounded-lg border shadow-layer" data-pane="sidebar">
                <SidebarHeader className="flex-row items-start justify-between gap-inline-md pt-inset-md pb-stack-sm ps-inset-md pe-inset-sm">
                  <span className="flex min-w-0 flex-col gap-stack-xs">
                    <span className="text-subtitle-2">{tool.label}</span>
                    <span className="text-caption-1 text-fg-muted" data-testid="connections-summary">
                      {(() => {
                        const n = profiles.filter((p) => p.tool === tool.id).length;
                        return n === 0 ? "No connections" : `${n} connection${n === 1 ? "" : "s"} · ${toolState(tool).connected} connected`;
                      })()}
                    </span>
                    {focusedTab && focusedTab.tool !== tool.id ? (
                      // A tool picked by hand (DOC-21 §3.2.1): the tree goes back to the tab's tool on the next tab focus.
                      <span className="text-caption-1 text-fg-muted" data-testid="tree-by-hand">
                        The tree returns to {toolById(tools, focusedTab.tool)?.label ?? focusedTab.tool} when you focus a tab.
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-inline-md">
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
                  {toolRefusal ? (
                    <AccessPage refusal={toolRefusal} title={`You can't use ${tool.label}`} />
                  ) : (
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
                    expanded={state.treeExpanded}
                    onExpandedChange={(profileId, ids) => dispatch({ type: "treeExpanded", profileId, ids })}
                    reveal={state.reveal}
                    onRevealed={(seq, nodeId, done) => dispatch({ type: "revealed", seq, nodeId, done })}
                    onUpdateProfile={async (id, change) => {
                      const record = profileById(id);
                      if (record) await saveProfile({ ...change(record), updatedAt: new Date().toISOString() });
                    }}
                  />
                  )}
                </SidebarContent>
              </Sidebar>
            </ResizablePanel>
            <ResizableHandle aria-label="Resize sidebar" disabled={!state.layout.sidebarOpen} withGrip className={gapHandle} />
            <ResizablePanel minSize={40}>
              <SidebarInset className="flex h-full min-h-0 flex-col" data-pane="tab">
                {missingLink ? (
                  <TabsContent value={LINK_TAB} className="min-h-0 flex-1 p-0">
                    <section aria-label={missingLink.title} className={cn(layerSurface, "flex h-full min-h-0 flex-col")}>
                      {linkPage(missingLink)}
                    </section>
                  </TabsContent>
                ) : null}
                {state.tabs.length === 0 && !missingLink ? (
                  <section aria-label="Start" className={cn(layerSurface, "flex h-full min-h-0 flex-col")}>
                    <EmptyState className="m-auto">
                      <EmptyStateIcon className="size-auto bg-accent-subtle p-inset-md text-accent-subtle-fg [&_svg]:size-inset-xl!">
                        <Icon icon={toolIcon(tool)} />
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
                          nav={navOf(t, profiles.find((p) => p.id === t.profileId))}
                          guard={guardFor(t.id)}
                          keep={keepFor(t.id)}
                          trust={() => {
                            const details = state.conns[t.profileId]?.error?.hostKey;
                            if (details) setHostKeyPrompt({ profileId: t.profileId, details });
                          }}
                          tabProps={{
                            client,
                            useTabActions: hookFor(t.id),
                            onLive: liveFor(t.id),
                            note,
                            openTab: (open) => openResource(t.profileId, { id: "", label: open.title, open }),
                            navigate: (place, options) => navigateTab(t.id, place, options),
                            go: (place, event) =>
                              event && wantsNewTab({ ctrlKey: event.ctrlKey ?? false, metaKey: event.metaKey ?? false, button: event.button ?? 0 })
                                ? openResource(t.profileId, { id: "", label: place.title, open: place })
                                : navigateTab(t.id, place),
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
        <StatusBar aria-label="Status" className="h-auto gap-inline-md border-t-0 bg-transparent py-inline-xs ps-inset-sm pe-inset-xs">
          <StatusBarItem className="text-fg">
            <Icon icon={toolIcon(tool)} />
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
          {session.me ? (
            <StatusBarItem>
              <Icon icon={Person} />
              <span data-testid="status-person">{[nameOf(session.me), mainRole(session.me.roles)].filter(Boolean).join(" · ")}</span>
            </StatusBarItem>
          ) : null}
          <StatusBarItem>
            <Icon icon={Server} />
            <span>{state.server === "online" ? (state.info?.publicOrigin ?? location.host) : state.server === "connecting" ? "Connecting…" : state.server === "signedOut" ? "Signed out" : "Server lost"}</span>
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

      <LeaveGuardContext value={guardFor(SHELL_GUARD)}>
      <ProfileSheet
        open={profileDialog !== null}
        onOpenChange={(open) => !open && closeDialog()}
        tool={sheetTool}
        {...(sheetBase ? { base: sheetBase } : {})}
        mode={sheetMode}
        {...(profileDialog?.name && sheetMode === "add" ? { name: profileDialog.name } : {})}
        {...(session.me ? { self: session.me.user } : {})}
        takenNames={takenNames}
        {...(sheetBase && state.recordStates[sheetBase.id] ? { recordState: state.recordStates[sheetBase.id]! } : {})}
        onSave={async (record, { remove, shared }) => {
          const saved = await saveServerProfile(client, record, { mode: sheetMode, base: sheetBase, remove, shared });
          await reloadProfiles();
          closeDialog();
          if (saved.removedSecrets.length > 0) {
            toast.add({ title: `${record.name}: ${saved.removedSecrets.join(", ")} removed`, description: "The target changed: a stored secret is only sent to the target it was set for. Enter it again to keep it.", type: "warning" });
          }
          dispatch({ type: "select", nodeId: profileNodeId(saved.record.id) });
          toast.add({ title: `${record.name} saved`, description: "Connect when you are ready.", type: "success" });
        }}
      />
      </LeaveGuardContext>
      {(() => {
        const record = hostKeyPrompt ? profiles.find((p) => p.id === hostKeyPrompt.profileId) : undefined;
        const t = record ? toolById(tools, record.tool) : undefined;
        return (
          <HostKeyDialog
            open={hostKeyPrompt !== null && record !== undefined}
            name={record?.name ?? ""}
            target={(record && t?.targetOf?.(record)) ?? record?.name ?? ""}
            details={hostKeyPrompt?.details ?? null}
            onCancel={() => setHostKeyPrompt(null)}
            onTrust={(key) => hostKeyPrompt && void trustHostKey(hostKeyPrompt.profileId, key)}
          />
        );
      })()}
      <DeleteProfileDialog open={deleting !== undefined} name={deleting?.name ?? ""} onCancel={closeDialog} onDelete={() => deleting && void doDelete(deleting.id)} />
      <DiscardChangesDialog open={leaving !== null || blocker.status === "blocked"} onKeep={keepEditing} onDiscard={discardChanges} />
      <CloseTabDialog open={closing !== undefined} title={closing?.title ?? ""} onCancel={closeDialog} onClose={() => closing && closeTab(closing.id, true)} />
      <ExportDialog open={dialog.kind === "export"} onOpenChange={(open) => !open && closeDialog()} count={exportCount} onExport={doExport} />
      <MoveProfilesDialog open={dialog.kind === "moveProfiles"} onOpenChange={(open) => !open && closeDialog()} records={browserProfiles} toolLabel={(id) => toolById(tools, id)?.label ?? id} onBackup={doBackup} onMove={doMove} />
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
        client={client}
        onOpenProfile={(id, tool) => dispatch({ type: "dialog", dialog: { kind: "profile", tool, editId: id } })}
        onForgetEverything={async () => {
          for (const [id, conn] of Object.entries(stateRef.current.conns)) if (conn.connId) disconnectProfile(id);
          await storage.forgetEverything();
          location.reload();
        }}
      />
      <AboutDialog open={dialog.kind === "about"} onOpenChange={(open) => !open && closeDialog()} info={state.info} diagnostics={state.diagnostics} />
      <ShortcutsDialog open={dialog.kind === "shortcuts"} onOpenChange={(open) => !open && closeDialog()} />
      {session.me && holdsAnywhere(session.me, "admin.users.read") ? <AdminDialog open={adminOpen} onOpenChange={setAdminOpen} client={client} selfId={session.me.user} /> : null}
      {session.me && holdsAnywhere(session.me, "audit.read") ? <AuditDialog open={auditOpen} onOpenChange={setAuditOpen} client={client} /> : null}
      {session.me ? <MyAccessDialog open={myAccessOpen} onOpenChange={setMyAccessOpen} me={session.me} /> : null}
      {session.me ? <SessionsDialog open={sessionsOpen} onOpenChange={setSessionsOpen} client={client} currentId={session.me.session} /> : null}
      <SessionEndedDialog open={state.server === "signedOut"} me={session.me} replacedBy={session.replacedBy} waiting={signInAgain.waiting} onSignInAgain={signInAgain.open} />
      {state.server === "lost" || state.server === "versionMismatch" ? <ServerOverlay status={state.server} onRetry={() => supervisor.current?.retryNow()} /> : null}
      <span className="sr-only" aria-live="polite" data-focus-pane={focusPane} />
    </SidebarProvider>
    </NoticeContext>
    </AccessProvider>
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
  /** Opens the host key dialog again for a `HostKey` failure. */
  trust: () => void;
  tabProps: Pick<TabProps, "client" | "useTabActions" | "onLive" | "note" | "openTab" | "navigate" | "go" | "updateProfile">;
  /** The navigation row (DOC-21 §3.7); none when the tab's profile or tool is gone. */
  nav: NavRowProps | null;
  /** Where the tab's sheets report unsaved changes. */
  guard: LeaveGuardSetter;
  /** Keeps a preview tab (DOC-21 §3.2.1): its screen calls it through useKeepTab. */
  keep: () => void;
}

/** A tab's states around the tool's screen: profile gone, Disconnected, Loading, Error (spec §3.5). */
/** What the dot of a live tab in the background says. */

function TabBody({ tab, tools, profile, conn, active, connect, cancelConnect, editProfile, trust, tabProps, nav, guard, keep }: TabBodyProps) {
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
    const failed = <ErrorState error={conn.error} onRetry={connect} onEditProfile={editProfile} onRefresh={connect} onTrust={trust} />;
    overlay = conn.error.denied ? <DeniedTab error={conn.error} tool={t.label} profile={profile.name} onRefresh={connect} fallback={failed} /> : failed;
  } else if (conn.status === "disconnected") {
    overlay = <DisconnectedState name={profile.name} onConnect={connect} />;
  }
  if (!profile || !t || !kind) return overlay;
  const Component = kind.Component;
  // The tool's screen stays mounted (its stream state survives a reconnect); while the profile is
  // not connected it is dimmed and inert, and the state is shown above it.
  return (
    <>
    {nav ? <NavRow {...nav} /> : null}
    {tab.preview ? (
      <div role="note" data-testid="preview-note" className="mx-inset-lg mt-stack-sm flex items-center gap-inline-md rounded-md border border-border-subtle bg-inset px-inset-sm py-inset-xs text-caption-1 text-fg-muted">
        <Icon icon={Eye} />
        <span className="min-w-0 flex-1">
          <span className="text-fg">Preview tab.</span> The next resource you open from the {t.label} tree replaces it. Double-click the tab, or the node, to keep it.
        </span>
        <Button size="small" onClick={keep}>
          <Icon icon={Pin} /> Keep open
        </Button>
      </div>
    ) : null}
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className={cn("flex min-h-0 flex-1 flex-col", overlay ? "pointer-events-none opacity-40" : "")} inert={overlay ? true : undefined} aria-hidden={overlay ? true : undefined}>
        <LeaveGuardContext value={guard}>
          <KeepTabContext value={keep}>
            <Component tab={tab} profile={profile} connId={conn.status === "connected" ? conn.connId : null} active={active} {...tabProps} />
          </KeepTabContext>
        </LeaveGuardContext>
      </div>
      {overlay ? <div className="absolute inset-0 flex flex-col overflow-auto">{overlay}</div> : null}
    </div>
    </>
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
