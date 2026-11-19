// The sidebar (Mightyconsole spec §3.1): the selected tool's connection list, each profile a Tree
// root with a status glyph (disconnected, connecting, connected, reconnecting, failed) and, under
// a connected profile, the tool's resource tree. A filter box, a context menu (Connect,
// Disconnect, Open, Edit, Duplicate, Export, Delete, Copy id) and the "No profile" state.
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ServicesContext } from "@/app/client";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Kbd } from "@/components/ui/kbd";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { Tree, type TreeNode } from "@/components/ui/tree";
import { Add, ArrowImport, CheckmarkCircle, Circle, Clock, ErrorCircle, Warning } from "@/lib/icons";
import type { RecordState } from "@/profiles/migrate";
import type { ProfileRecord } from "@/profiles/record";
import { toolIcon } from "@/tools/registry";
import type { ResourceNode, ToolModule } from "@/tools/types";
import { COLOR_CLASS } from "../dialogs/ProfileDialogs";
import { bindingOf } from "../shortcuts";
import { LoadingRows } from "../states";
import type { ConnState } from "../store";

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
  onOpenResource: (profileId: string, node: ResourceNode) => void;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (profileId: string) => void;
  onDuplicate: (profileId: string) => void;
  onExport: (profileId: string) => void;
  onDelete: (profileId: string) => void;
}

export function ConnectionList(props: ConnectionListProps) {
  const { tool, profiles, conns, selected } = props;
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
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
      (profiles ?? []).map((p) => {
        const conn = conns[p.id] ?? { status: "disconnected" as const, connId: null };
        const state = props.recordStates[p.id];
        const node: TreeNode = {
          id: profileNodeId(p.id),
          label: p.name,
          icon: <ProfileIcon tool={tool} status={conn.status} color={p.color} />,
          meta: (
            <span className="flex items-center gap-inline-sm">
              <span className="sr-only">{conn.status}</span>
              {conn.status === "connecting" ? <Spinner size="sm" label="Connecting" /> : null}
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

  const expandProfile = (id: string) => setExpanded((e) => (e.includes(id) ? e : [...e, id]));
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
      else void props.onConnect(p.id).then((ok) => ok && expandProfile(node.id));
      return;
    }
    const conn = conns[p.id];
    if (!conn?.connId) return;
    const resource = findResource(tool.sidebarTree({ profile: p, connId: conn.connId }), parsed.resource);
    if (resource?.open) props.onOpenResource(p.id, resource);
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
        <EmptyStateDescription className="text-caption-1">Profiles stay in this browser; the server keeps nothing. {tool.description}</EmptyStateDescription>
        <EmptyStateActions>
          <Button appearance="primary" onClick={props.onAdd}>
            <Icon icon={Add} /> Add connection
          </Button>
          <Button onClick={props.onImport}>
            <Icon icon={ArrowImport} /> Import profiles
          </Button>
        </EmptyStateActions>
        <Kbd>{bindingOf("addConnection")}</Kbd>
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-stack-xs">
      <div className="px-inset-sm pt-inset-xs">
        <SearchInput size="small" aria-label="Filter connections" placeholder="Filter" value={filter} onValueChange={setFilter} />
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
            onSelectedChange={(id) => props.onSelect(id)}
            onAction={action}
            onRetry={(node) => {
              const parsed = parseNode(node.id);
              if (parsed) void props.onConnect(parsed.profileId);
            }}
            filter={filter}
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
    </div>
  );
}
