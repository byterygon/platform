// The sidebar (Mightyconsole spec §3.1): the selected tool's connection list, each profile a Tree
// root with a status glyph (disconnected, connecting, connected, reconnecting, failed) and, under
// a connected profile, the tool's resource tree. A filter box, a context menu (Connect,
// Disconnect, Open, Edit, Duplicate, Export, Delete, Copy id; a resource's own items, as a saved
// query's Rename and Delete, TSK-95) and the "No profile" state.
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ServicesContext } from "@/app/client";
import { pane } from "@/app/sharing";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { Tree, type TreeNode, type TreeSelectDetails } from "@/components/ui/tree";
import { Add, ArrowImport, CheckmarkCircle, Circle, Clock, ErrorCircle, Person, Warning } from "@/lib/icons";
import type { RecordState } from "@/profiles/migrate";
import type { ProfileRecord } from "@/profiles/record";
import { toolIcon } from "@/tools/registry";
import type { ResourceAction, ResourceNode, ToolModule } from "@/tools/types";
import { COLOR_CLASS } from "../dialogs/ProfileDialogs";
import { ariaBindingOf, bindingOf } from "../shortcuts";
import { LoadingRows } from "../states";
import type { ConnState, Reveal, TreeExpanded } from "../store";
import { ResourceActionDialog } from "./ResourceActionDialog";

const GLYPH = {
  connected: { icon: CheckmarkCircle, filled: true, tone: "success" },
  failed: { icon: ErrorCircle, filled: true, tone: "danger" },
  reconnecting: { icon: Clock, filled: true, tone: "warning" },
  disconnected: { icon: Circle, filled: false, tone: "muted" },
} as const;

/** A profile's tool icon with its status glyph; the row also says the status in text. */
export function ProfileIcon({ tool, status, color }: { tool: ToolModule; status: ConnState["status"]; color?: string | undefined }) {
  const glyph = status === "connecting" ? null : GLYPH[status];
  const colorClass = color ? COLOR_CLASS[color] : undefined;
  // A tool's own mark is never recoloured (its owners' guidelines, marks/NOTICE.md): the profile
  // colour becomes a dot on its corner. A Fluent icon still takes the colour itself.
  return (
    <span data-status={status} className="relative me-inline-xs inline-flex">
      <Icon icon={toolIcon(tool)} {...(colorClass && !tool.mark ? { className: colorClass } : {})} />
      {colorClass && tool.mark ? <span aria-hidden="true" data-profile-color={color} className={`absolute inset-s-0 top-0 size-icon-xs -translate-x-1/3 -translate-y-1/3 rounded-full border-2 border-surface bg-current ${colorClass}`} /> : null}
      {glyph ? (
        <span className="absolute inset-e-0 bottom-0 flex translate-x-1/3 translate-y-1/3 rounded-full bg-surface">
          <Icon icon={glyph.icon} filled={glyph.filled} tone={glyph.tone} className="size-icon-xs!" />
        </span>
      ) : null}
    </span>
  );
}

/** Node ids: `p:<profileId>` for a profile, `p:<profileId>/<resource id>` below it. */
export const profileNodeId = (id: string) => `p:${id}`;

export function parseNode(id: string): { profileId: string; resource: string | null } | null {
  if (!id.startsWith("p:")) return null;
  const slash = id.indexOf("/");
  return slash < 0 ? { profileId: id.slice(2), resource: null } : { profileId: id.slice(2, slash), resource: id.slice(slash + 1) };
}

function resourceNodes(profileId: string, nodes: readonly ResourceNode[]): TreeNode[] {
  return nodes.map((n) => {
    const out: TreeNode = { id: `p:${profileId}/${n.id}`, label: n.label };
    if (n.icon !== undefined) out.icon = n.icon;
    if (n.meta !== undefined) out.meta = n.meta;
    if (n.children) out.children = resourceNodes(profileId, n.children);
    return out;
  });
}

/** The tree ids of the resource nodes that open the first time they show. */
function openedIds(profileId: string, nodes: readonly ResourceNode[]): string[] {
  return nodes.flatMap((n) => [...(n.expanded ? [`p:${profileId}/${n.id}`] : []), ...(n.children ? openedIds(profileId, n.children) : [])]);
}

const NO_SUBSCRIBE = () => () => undefined;
const NO_VERSION = () => 0;

/** Finds the resource node a tree id names. */
export function findResource(nodes: readonly ResourceNode[], id: string): ResourceNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = n.children ? findResource(n.children, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

export interface ConnectionListProps {
  tool: ToolModule;
  profiles: readonly ProfileRecord[] | null;
  recordStates: Record<string, RecordState>;
  conns: Record<string, ConnState>;
  selected: string | null;
  onSelect: (nodeId: string) => void;
  onConnect: (profileId: string) => Promise<boolean>;
  onDisconnect: (profileId: string) => void;
  /** Opens a resource's tab: a click or Space as a preview (DOC-21 §3.2.1), Enter, a double click or Ctrl/Cmd + click for good. */
  onOpenResource: (profileId: string, node: ResourceNode, options?: { preview?: boolean }) => void;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (profileId: string) => void;
  onDuplicate: (profileId: string) => void;
  onExport: (profileId: string) => void;
  onDelete: (profileId: string) => void;
  /** Changes a profile (a resource's menu item, as a saved query's Rename). */
  onUpdateProfile: (profileId: string, change: (record: ProfileRecord) => ProfileRecord) => Promise<void>;
  /** The expanded nodes per profile: the store's (DOC-21 §3.2.1). */
  expanded?: TreeExpanded;
  onExpandedChange?: (profileId: string, ids: string[]) => void;
  /** The focused tab's node to show (DOC-21 §3.2.1), and where the tree reports what it selected. */
  reveal?: Reveal | null;
  onRevealed?: (seq: number, nodeId: string, done: boolean) => void;
}

/** The ids from a top node down to `id`, or null when the tree does not draw it. */
function pathTo(nodes: readonly TreeNode[], id: string): string[] | null {
  for (const n of nodes) {
    if (n.id === id) return [n.id];
    const inner = n.children ? pathTo(n.children, id) : null;
    if (inner) return [n.id, ...inner];
  }
  return null;
}

export function ConnectionList(props: ConnectionListProps) {
  const { tool, profiles, conns, selected } = props;
  const [filter, setFilter] = useState("");
  // The expanded nodes of this tool's profiles live in the store, per profile (DOC-21 §3.2.1).
  // Without a store (a test of the list alone) the list keeps them itself.
  const [own, setOwn] = useState<TreeExpanded>({});
  const store = props.expanded ?? own;
  const onExpandedChange = props.onExpandedChange ?? ((id: string, ids: string[]) => setOwn((o) => ({ ...o, [id]: ids })));
  const expanded = useMemo(() => (profiles ?? []).flatMap((p) => store[p.id] ?? []), [profiles, store]);
  const latest = useRef({ expanded, profiles, onExpandedChange });
  latest.current = { expanded, profiles, onExpandedChange };
  const setExpanded = (next: string[] | ((current: string[]) => string[])) => {
    const now = latest.current;
    const ids = typeof next === "function" ? next(now.expanded) : next;
    // Two changes in one commit (a node's first showing and the profile a double click opened) build
    // on each other, as a state updater's would: the next one starts from this one, not the render's.
    now.expanded = ids;
    for (const p of now.profiles ?? []) now.onExpandedChange(p.id, ids.filter((id) => parseNode(id)?.profileId === p.id));
  };
  // The tool's tree data (counts, namespaces), loaded for each connected profile; a change redraws the tree.
  const services = useContext(ServicesContext);
  const dataVersion = useSyncExternalStore(tool.sidebarData?.subscribe ?? NO_SUBSCRIBE, tool.sidebarData?.version ?? NO_VERSION);
  useEffect(() => {
    if (!tool.sidebarData || !services) return;
    for (const p of profiles ?? []) {
      const c = conns[p.id];
      if (c?.status === "connected" && c.connId) tool.sidebarData.load({ profile: p, connId: c.connId, client: services.client });
    }
  }, [tool, profiles, conns, services]);
  const nodes = useMemo<TreeNode[]>(
    () =>
      pane(profiles ?? []).map((p) => {
        const conn = conns[p.id] ?? { status: "disconnected" as const, connId: null };
        const state = props.recordStates[p.id];
        const node: TreeNode = {
          id: profileNodeId(p.id),
          label: p.name,
          icon: <ProfileIcon tool={tool} status={conn.status} color={p.color} />,
          meta: (
            // The stored profile's id (the Temporal codec endpoint's path names it).
            <span className="flex items-center gap-inline-sm" data-profile-id={p.id}>
              <span className="sr-only">{conn.status}</span>
              {p.owner?.kind === "shared" ? (
                <Badge appearance="tint" variant="neutral" size="sm" title="Shared: everyone whose role covers it connects with it">
                  Shared
                </Badge>
              ) : p.access === "owner" || p.access === undefined ? (
                <span title="Your personal profile" data-owner="personal">
                  <Icon icon={Person} label="Personal" className="text-fg-muted" />
                </span>
              ) : (
                <Badge appearance="tint" variant="neutral" size="sm" title="Another person's personal profile: you see its name and where it connects">
                  Personal
                </Badge>
              )}
              {conn.status === "connecting" ? <Spinner size="sm" label="Connecting" /> : null}
              {(tool.profileBadges?.(p) ?? []).map((badge) => (
                <Badge key={badge.label} appearance="tint" variant={badge.tone} size="sm" {...(badge.hint ? { title: badge.hint } : {})}>
                  {badge.label}
                </Badge>
              ))}
              {state?.kind === "newer" ? (
                <span className="flex items-center gap-inline-xs text-caption-1 text-fg-muted">
                  <Icon icon={Warning} tone="warning" /> newer version
                </span>
              ) : null}
            </span>
          ),
          hasChildren: true,
        };
        if (conn.status === "connected" && conn.connId) node.children = resourceNodes(p.id, tool.sidebarTree({ profile: p, connId: conn.connId }));
        if (conn.status === "failed" && conn.error) node.error = conn.error.title;
        return node;
      }),
    // dataVersion: the tool's tree data changed.
    [profiles, conns, tool, props.recordStates, dataVersion],
  );
  // Nodes that open the first time they show (a Temporal profile's own namespace).
  const opened = useRef(new Set<string>());
  useEffect(() => {
    const fresh: string[] = [];
    for (const p of profiles ?? []) {
      const c = conns[p.id];
      if (c?.status !== "connected" || !c.connId) continue;
      for (const id of openedIds(p.id, tool.sidebarTree({ profile: p, connId: c.connId }))) if (!opened.current.has(id)) fresh.push(id);
    }
    if (fresh.length === 0) return;
    for (const id of fresh) opened.current.add(id);
    setExpanded((e) => [...new Set([...e, ...fresh])]);
  }, [nodes, profiles, conns, tool]);
  const selectedProfile = selected ? parseNode(selected) : null;
  const profile = selectedProfile ? profiles?.find((p) => p.id === selectedProfile.profileId) : undefined;
  const status = profile ? (conns[profile.id]?.status ?? "disconnected") : undefined;
  // The selected resource's own menu items, and the one asking its question.
  const selectedConn = profile ? conns[profile.id] : undefined;
  const resourceActions =
    profile && selectedProfile?.resource && selectedConn?.status === "connected" && selectedConn.connId ? (findResource(tool.sidebarTree({ profile, connId: selectedConn.connId }), selectedProfile.resource)?.actions ?? []) : [];
  const [asking, setAsking] = useState<{ profileId: string; action: ResourceAction } | null>(null);
  const runAction = (profileId: string, item: ResourceAction, value: string) => Promise.resolve(item.run({ value, updateProfile: (change) => props.onUpdateProfile(profileId, change) }));
  const pick = (item: ResourceAction) => {
    if (!profile) return;
    if (item.prompt || item.confirm) setAsking({ profileId: profile.id, action: item });
    else void runAction(profile.id, item, "");
  };

  const expandProfile = (id: string) => setExpanded((e) => (e.includes(id) ? e : [...e, id]));
  // Profiles the person opened while they were not connected: they open once connected, also when
  // the connect that did it came later (after trusting a host key, a Retry).
  const wanted = useRef(new Set<string>());
  useEffect(() => {
    for (const id of wanted.current) {
      const parsed = parseNode(id);
      const status = parsed ? conns[parsed.profileId]?.status : undefined;
      if (status === "connected") {
        wanted.current.delete(id);
        expandProfile(id);
      } else if (status === undefined || status === "disconnected") wanted.current.delete(id);
    }
  }, [conns]);
  const expand = (next: string[], node: TreeNode, isExpanded: boolean) => {
    setExpanded(next);
    const parsed = parseNode(node.id);
    if (!isExpanded || !parsed || parsed.resource !== null) return;
    if ((conns[parsed.profileId]?.status ?? "disconnected") === "disconnected") void props.onConnect(parsed.profileId);
  };
  const action = (node: TreeNode) => {
    const parsed = parseNode(node.id);
    if (!parsed) return;
    const p = profiles?.find((x) => x.id === parsed.profileId);
    if (!p) return;
    if (parsed.resource === null) {
      if ((conns[p.id]?.status ?? "disconnected") === "connected") expandProfile(node.id);
      else {
        wanted.current.add(node.id);
        void props.onConnect(p.id).then((ok) => ok && expandProfile(node.id));
      }
      return;
    }
    const conn = conns[p.id];
    if (!conn?.connId) return;
    const resource = findResource(tool.sidebarTree({ profile: p, connId: conn.connId }), parsed.resource);
    if (resource?.open) props.onOpenResource(p.id, resource);
  };

  // The focused tab's node (DOC-21 §3.2.1): its deepest node the tree draws is selected and scrolled
  // to, without focus; the tab's own node once it shows (a list still loading).
  const [scrollTo, setScrollTo] = useState<{ id: string; seq: number } | null>(null);
  const reveal = props.reveal ?? null;
  useEffect(() => {
    if (!reveal || !profiles?.some((p) => p.id === reveal.profileId)) return;
    const target = reveal.path[reveal.path.length - 1]!;
    const found = pathTo(nodes, target);
    if (found) {
      const missing = found.slice(0, -1).filter((id) => !expanded.includes(id));
      if (missing.length > 0) setExpanded((e) => [...e, ...missing]);
      setScrollTo({ id: target, seq: reveal.seq * 2 + 1 });
      props.onRevealed?.(reveal.seq, target, true);
      return;
    }
    const nearest = [...reveal.path].reverse().find((id) => pathTo(nodes, id) !== null);
    if (!nearest || nearest === selected) return;
    setScrollTo({ id: nearest, seq: reveal.seq * 2 });
    props.onRevealed?.(reveal.seq, nearest, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs for a new reveal and when the tree's nodes change
  }, [reveal, nodes]);

  // A click or Space on a resource opens it in the tool's preview tab; Ctrl or Cmd + click opens it for good.
  const preview = (id: string, details: TreeSelectDetails) => {
    if (details.reason !== "click" && details.reason !== "space") return;
    const parsed = parseNode(id);
    if (!parsed || parsed.resource === null) return;
    const p = profiles?.find((x) => x.id === parsed.profileId);
    const conn = p ? conns[p.id] : undefined;
    if (!p || !conn?.connId) return;
    const resource = findResource(tool.sidebarTree({ profile: p, connId: conn.connId }), parsed.resource);
    if (!resource?.open) return;
    const forGood = details.modifiers?.ctrlKey === true || details.modifiers?.metaKey === true;
    props.onOpenResource(p.id, resource, forGood ? {} : { preview: true });
  };

  if (profiles === null) return <LoadingRows label="Loading profiles" />;
  if (profiles.length === 0) {
    return (
      <EmptyState className="px-inset-md py-inset-xl">
        <EmptyStateIcon>
          <Icon icon={toolIcon(tool)} />
        </EmptyStateIcon>
        <EmptyStateTitle render={<p />} className="text-body-1-strong">
          No {tool.label} connections yet
        </EmptyStateTitle>
        <EmptyStateDescription className="text-caption-1">Connections are kept on the server; your own are only yours. {tool.description}</EmptyStateDescription>
        <EmptyStateActions>
          {/* No key hint drawn by the button (DOC-21 §3.4): the binding is in its tooltip and the palette. */}
          <Tooltip>
            <TooltipTrigger render={<Button appearance="primary" onClick={props.onAdd} aria-keyshortcuts={ariaBindingOf("addConnection")} />}>
              <Icon icon={Add} /> Add connection
            </TooltipTrigger>
            <TooltipContent>
              Add a {tool.label} connection <TooltipShortcut>{bindingOf("addConnection")}</TooltipShortcut>
            </TooltipContent>
          </Tooltip>
          <Button onClick={props.onImport}>
            <Icon icon={ArrowImport} /> Import profiles
          </Button>
        </EmptyStateActions>
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-inset-md pb-stack-sm">
        <SearchInput aria-label="Filter connections" placeholder="Filter" value={filter} onValueChange={setFilter} />
      </div>
      <ContextMenu>
        <ContextMenuTrigger className="min-h-0 flex-1" data-pane="sidebar">
          <Tree
            aria-label={`${tool.label} connections`}
            size="medium"
            className="h-full"
            nodes={nodes}
            expanded={expanded}
            onExpandedChange={expand}
            selected={selected}
            onSelectedChange={(id, _node, details) => {
              props.onSelect(id);
              preview(id, details);
            }}
            onAction={action}
            onRetry={(node) => {
              const parsed = parseNode(node.id);
              if (parsed) void props.onConnect(parsed.profileId);
            }}
            filter={filter}
            scrollTo={scrollTo}
            emptyText="No matches"
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!profile || status === "connected" || status === "connecting"} onClick={() => profile && void props.onConnect(profile.id)}>
            Connect
          </ContextMenuItem>
          <ContextMenuItem disabled={!profile || status === "disconnected"} onClick={() => profile && props.onDisconnect(profile.id)}>
            Disconnect
          </ContextMenuItem>
          <ContextMenuItem disabled={!selected} onClick={() => selected && action({ id: selected, label: "" })}>
            Open
          </ContextMenuItem>
          {resourceActions.length > 0 ? (
            <>
              <ContextMenuSeparator />
              {resourceActions.map((item) => (
                <ContextMenuItem key={item.label} danger={item.danger === true} onClick={() => pick(item)}>
                  {item.label}
                </ContextMenuItem>
              ))}
            </>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!profile} onClick={() => profile && props.onEdit(profile.id)}>
            Edit
          </ContextMenuItem>
          <ContextMenuItem disabled={!profile} onClick={() => profile && props.onDuplicate(profile.id)}>
            Duplicate
          </ContextMenuItem>
          <ContextMenuItem disabled={!profile} onClick={() => profile && props.onExport(profile.id)}>
            Export…
          </ContextMenuItem>
          <ContextMenuItem disabled={!profile} onClick={() => profile && void navigator.clipboard?.writeText(profile.id)}>
            Copy id
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem danger disabled={!profile} onClick={() => profile && props.onDelete(profile.id)}>
            Delete <ContextMenuShortcut />
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ResourceActionDialog action={asking?.action ?? null} onClose={() => setAsking(null)} onRun={(item, value) => (asking ? runAction(asking.profileId, item, value) : Promise.resolve())} />
    </div>
  );
}
