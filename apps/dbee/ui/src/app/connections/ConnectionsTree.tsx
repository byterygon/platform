// The connections and schema tree (DBee spec §3.2, §3.5, §8): one Tree with connection nodes at
// the top, schemas, Tables and Views groups, tables and columns underneath, children loaded on
// expand and cached per session, system schemas under a collapsed "System" node, a filter box, a
// context menu with every connection action, an EmptyState on first run.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Kbd } from "@/components/ui/kbd";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tree, type TreeNode } from "@/components/ui/tree";
import { TypeBadge } from "@/components/ui/type-badge";
import type { ColumnInfo, ConnectionStatus, ConnectionSummary, TableInfo } from "@/gen/api";
import { Add, CheckmarkCircle, Circle, Clock, Database, DatabaseMultiple, ErrorCircle, LockClosed, Warning } from "@/lib/icons";
import { type Ctx, connect, loadColumns, loadSchemas, loadTables, openTab, quoteIdent } from "../actions";
import { useServices } from "../client";
import { ExpiryBadge } from "./ExpiryBadge";
import { ColumnIcon, SchemaIcon, TableIcon, ViewIcon } from "../icons";
import { tlsName } from "../messages";
import { type SchemaCache, emptyCache, useStore } from "../store";
import { type Shell, bindingsOf, ACTIONS, displayBinding } from "../shortcuts";

const SYSTEM = /^(pg_catalog|information_schema|pg_toast)/;

/** A TreeNode without its undefined keys (the registry's TreeNode has exact optional properties). */
function node(n: { [K in keyof TreeNode]: TreeNode[K] | undefined } & Pick<TreeNode, "id" | "label">): TreeNode {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n)) if (v !== undefined) out[k] = v;
  return out as unknown as TreeNode;
}

export interface TreeTarget {
  connectionId: string;
  schema?: string;
  table?: string;
  group?: "tables" | "views" | "system";
  column?: string;
}

/** Node ids carry their path: `c:<id>`, `c:<id>/s:<schema>`, `.../g:tables`, `.../t:<table>`, `.../col:<name>`. */
export function parseNodeId(id: string): TreeTarget | null {
  const [c, ...rest] = id.split("/");
  if (!c?.startsWith("c:")) return null;
  const target: TreeTarget = { connectionId: c.slice(2) };
  for (const part of rest) {
    if (part.startsWith("s:")) target.schema = part.slice(2);
    else if (part.startsWith("g:")) target.group = part.slice(2) as "tables" | "views" | "system";
    else if (part.startsWith("t:")) target.table = part.slice(2);
    else if (part.startsWith("col:")) target.column = part.slice(4);
  }
  return target;
}

/**
 * A connection's state as a status glyph on its database icon (TSK-64, Fluent's presence badge):
 * the shape carries the state (check, error, clock, hollow circle), not only the colour, and the
 * row also says it in text for screen readers. Connecting shows a spinner in the row's meta.
 */
const STATUS_GLYPH = {
  connected: { icon: CheckmarkCircle, filled: true, tone: "success" },
  error: { icon: ErrorCircle, filled: true, tone: "danger" },
  expired: { icon: Clock, filled: true, tone: "warning" },
  disconnected: { icon: Circle, filled: false, tone: "muted" },
} as const;

export function ConnectionIcon({ status, colour }: { status: ConnectionStatus; colour?: string | null }) {
  const glyph = status === "connecting" ? null : STATUS_GLYPH[status];
  return (
    <span data-status={status} className="relative me-inline-xs inline-flex">
      <Icon icon={Database} style={colour ? { color: colour } : undefined} />
      {glyph ? (
        <span className="absolute inset-e-0 bottom-0 flex translate-x-1/3 translate-y-1/3 rounded-full bg-surface">
          <Icon icon={glyph.icon} filled={glyph.filled} tone={glyph.tone} className="size-icon-xs!" />
        </span>
      ) : null}
    </span>
  );
}

function columnFamily(c: ColumnInfo): "integer" | "decimal" | "text" | "boolean" | "datetime" | "json" | "binary" | "uuid" {
  const t = c.typeName.toLowerCase();
  if (/int|serial|oid/.test(t)) return "integer";
  if (/numeric|decimal|real|double|float|money/.test(t)) return "decimal";
  if (/bool/.test(t)) return "boolean";
  if (/time|date|interval/.test(t)) return "datetime";
  if (/json/.test(t)) return "json";
  if (/bytea/.test(t)) return "binary";
  if (/uuid/.test(t)) return "uuid";
  return "text";
}

function tableNodes(connectionId: string, schema: string, tables: readonly TableInfo[], kind: "tables" | "views", cache: SchemaCache): TreeNode[] {
  return tables
    .filter((t) => (kind === "tables" ? t.kind === "table" : t.kind !== "table"))
    .map((t) => {
      const key = `${schema}.${t.name}`;
      const cols = cache.columns[key];
      return node({
        id: `c:${connectionId}/s:${schema}/g:${kind}/t:${t.name}`,
        label: t.name,
        icon: kind === "tables" ? <TableIcon /> : <ViewIcon />,
        meta: t.kind !== "table" && t.kind !== "view" ? <span className="text-caption text-fg-subtle">{t.kind}</span> : undefined,
        hasChildren: true,
        loading: cols?.loading ?? false,
        error: cols?.error,
        children: cols?.items?.map((c) => ({
          id: `c:${connectionId}/s:${schema}/g:${kind}/t:${t.name}/col:${c.name}`,
          label: c.name,
          icon: <ColumnIcon />,
          meta: (
            <span className="flex items-center gap-inline-xs">
              <TypeBadge type={columnFamily(c)} label={c.typeName} />
              {c.nullable ? <span className="text-caption text-fg-subtle" title="nullable">?</span> : null}
            </span>
          ),
        })),
      });
    });
}

function schemaNode(connectionId: string, schema: string, cache: SchemaCache): TreeNode {
  const tables = cache.tables[schema];
  const groups = (items: readonly TableInfo[]): TreeNode[] => {
    const t = tableNodes(connectionId, schema, items, "tables", cache);
    const v = tableNodes(connectionId, schema, items, "views", cache);
    return [
      { id: `c:${connectionId}/s:${schema}/g:tables`, label: "Tables", meta: <span className="text-caption text-fg-subtle">{t.length}</span>, children: t.length ? t : [], hasChildren: t.length > 0 },
      { id: `c:${connectionId}/s:${schema}/g:views`, label: "Views", meta: <span className="text-caption text-fg-subtle">{v.length}</span>, children: v.length ? v : [], hasChildren: v.length > 0 },
    ];
  };
  return node({
    id: `c:${connectionId}/s:${schema}`,
    label: schema,
    icon: <SchemaIcon />,
    hasChildren: true,
    loading: tables?.loading ?? false,
    error: tables?.error,
    children: tables?.items ? (tables.items.length === 0 ? [{ id: `c:${connectionId}/s:${schema}/empty`, label: "No tables", disabled: true }] : groups(tables.items)) : undefined,
  });
}

export function connectionNodes(connections: readonly ConnectionSummary[], statuses: Record<string, ConnectionStatus>, schema: Record<string, SchemaCache>): TreeNode[] {
  return connections.map((c) => {
    const status = statuses[c.id] ?? c.status;
    const cache = schema[c.id] ?? emptyCache();
    const children =
      status === "connected" && cache.schemas.items
        ? (() => {
            const user = cache.schemas.items.filter((s) => !SYSTEM.test(s)).map((s) => schemaNode(c.id, s, cache));
            const system = cache.schemas.items.filter((s) => SYSTEM.test(s)).map((s) => schemaNode(c.id, s, cache));
            return system.length ? [...user, { id: `c:${c.id}/g:system`, label: "System", children: system, hasChildren: true }] : user;
          })()
        : undefined;
    return node({
      id: `c:${c.id}`,
      label: c.name,
      icon: <ConnectionIcon status={status} colour={c.colour} />,
      meta: (
        <span className="flex items-center gap-inline-sm">
          <span className="sr-only">{status}, </span>
          <ExpiryBadge expiresAt={c.grant.expiresAt} hideExpired={status === "expired"} />
          {status === "connecting" ? <Spinner size="sm" label="Connecting" /> : null}
          {c.tls === "plaintext" ? (
            <span className="flex items-center gap-inline-xs text-warning-fg">
              <Icon icon={Warning} filled tone="warning" />
              Plaintext
            </span>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span className="flex" />}>
                <Icon icon={LockClosed} />
                <span className="sr-only">TLS</span>
              </TooltipTrigger>
              <TooltipContent>{tlsName(c.tls)}</TooltipContent>
            </Tooltip>
          )}
        </span>
      ),
      hasChildren: status === "connected",
      loading: status === "connected" && cache.schemas.loading,
      error: cache.schemas.error,
      children,
    });
  });
}

export interface ConnectionsTreeProps {
  shell: Shell;
  onAddConnection: () => void;
  onEdit: (id: string) => void;
  onRenew: (id: string) => void;
  onDelete: (id: string) => void;
  onDisconnect: (id: string) => void;
}

export function ConnectionsTree({ shell, onAddConnection, onEdit, onRenew, onDelete, onDisconnect }: ConnectionsTreeProps) {
  const services = useServices();
  const { state, dispatch } = useStore();
  const ctx: Ctx = { services, state, dispatch };
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const nodes = useMemo(() => connectionNodes(state.connections ?? [], state.statuses, state.schema), [state.connections, state.statuses, state.schema]);
  const selected = state.selectedNode === null ? null : parseNodeId(state.selectedNode);
  const selectedConnection = selected ? (state.connections ?? []).find((c) => c.id === selected.connectionId) : undefined;
  const selectedStatus = selectedConnection ? (state.statuses[selectedConnection.id] ?? selectedConnection.status) : undefined;
  const binding = (id: (typeof ACTIONS)[number]["id"]) => displayBinding(bindingsOf(ACTIONS.find((a) => a.id === id)!, shell)[0] ?? "");

  const expand = (next: string[], node: TreeNode, isExpanded: boolean) => {
    setExpanded(next);
    if (!isExpanded) return;
    const t = parseNodeId(node.id);
    if (!t) return;
    const cache = state.schema[t.connectionId] ?? emptyCache();
    if (t.table && t.schema) {
      if (!cache.columns[`${t.schema}.${t.table}`]) void loadColumns(ctx, t.connectionId, t.schema, t.table);
    } else if (t.schema && !t.group) {
      if (!cache.tables[t.schema]) void loadTables(ctx, t.connectionId, t.schema);
    } else if (!t.schema && !t.group) {
      const status = state.statuses[t.connectionId];
      if (status !== "connected") void connect(ctx, t.connectionId);
      else if (!cache.schemas.items && !cache.schemas.loading) void loadSchemas(ctx, t.connectionId);
    }
  };

  const action = (node: TreeNode) => {
    const t = parseNodeId(node.id);
    if (!t) return;
    if (t.table && t.schema) {
      // Enter on a table: a query tab with a select (a new tab when the active one has text).
      const active = state.tabs.find((tab) => tab.id === state.activeTab);
      const sql = `select * from ${quoteIdent(t.schema)}.${quoteIdent(t.table)} limit 1000;`;
      if (active && active.sql.trim() === "" ) dispatch({ type: "editTab", id: active.id, sql, connectionId: t.connectionId });
      else openTab(ctx, t.connectionId, sql);
      dispatch({ type: "pane", pane: "editor" });
    } else if (!t.schema && !t.group) {
      const open = () => setExpanded((e) => (e.includes(node.id) ? e : [...e, node.id]));
      if ((state.statuses[t.connectionId] ?? "disconnected") !== "connected") void connect(ctx, t.connectionId).then((ok) => ok && open());
      else open();
    }
  };

  const retry = (node: TreeNode) => {
    const t = parseNodeId(node.id);
    if (!t) return;
    if (t.table && t.schema) void loadColumns(ctx, t.connectionId, t.schema, t.table);
    else if (t.schema) void loadTables(ctx, t.connectionId, t.schema);
    else void loadSchemas(ctx, t.connectionId);
  };

  const refresh = () => {
    if (!selected) return;
    dispatch({ type: "schemaForget", connectionId: selected.connectionId });
    if ((state.statuses[selected.connectionId] ?? "disconnected") === "connected") void loadSchemas(ctx, selected.connectionId);
  };

  if (state.connections === null && state.connectionsError === null) {
    return (
      <div aria-busy="true" aria-label="Loading connections" className="flex flex-col gap-stack-sm p-inset-sm">
        <Skeleton variant="text" />
        <Skeleton variant="text" />
        <Skeleton variant="text" />
      </div>
    );
  }
  if ((state.connections ?? []).length === 0) {
    return (
      <EmptyState className="px-inset-md py-inset-xl">
        <EmptyStateIcon>
          <Icon icon={DatabaseMultiple} />
        </EmptyStateIcon>
        <EmptyStateTitle render={<p />} className="text-body-1-strong">
          No connections yet
        </EmptyStateTitle>
        <EmptyStateDescription className="text-caption-1">DBee stores passwords in the OS keychain and never sends anything over the network except to the database you approve.</EmptyStateDescription>
        <EmptyStateActions>
          <Button onClick={onAddConnection}>
            <Icon icon={Add} /> Add connection
          </Button>
        </EmptyStateActions>
        <Kbd>{binding("addConnection")}</Kbd>
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-stack-xs">
      <div className="px-inset-sm pt-inset-xs">
        <SearchInput size="small" aria-label="Filter the tree" placeholder="Filter" value={filter} onValueChange={setFilter} />
      </div>
      <ContextMenu>
        <ContextMenuTrigger className="min-h-0 flex-1" data-pane="tree">
          <Tree
            aria-label="Connections and schema"
            size="medium"
            className="h-full"
            nodes={nodes}
            expanded={expanded}
            onExpandedChange={expand}
            selected={state.selectedNode}
            onSelectedChange={(id) => dispatch({ type: "select", nodeId: id })}
            onAction={action}
            onRetry={retry}
            filter={filter}
            emptyText="No matches"
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!selectedConnection || selectedStatus === "connected"} onClick={() => selectedConnection && void connect(ctx, selectedConnection.id)}>
            Connect <ContextMenuShortcut>{binding("connectToggle")}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!selectedConnection || selectedStatus !== "connected"} onClick={() => selectedConnection && onDisconnect(selectedConnection.id)}>
            Disconnect
          </ContextMenuItem>
          <ContextMenuItem disabled={!selectedConnection} onClick={() => selectedConnection && openTab(ctx, selectedConnection.id)}>
            Open query tab <ContextMenuShortcut>{binding("newTab")}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!selectedConnection} onClick={() => selectedConnection && onEdit(selectedConnection.id)}>
            Edit
          </ContextMenuItem>
          <ContextMenuItem disabled={!selectedConnection} onClick={() => selectedConnection && onRenew(selectedConnection.id)}>
            Renew access
          </ContextMenuItem>
          <ContextMenuItem disabled={!selectedConnection} onClick={() => selectedConnection && void navigator.clipboard?.writeText(selectedConnection.id)}>
            Copy connection id
          </ContextMenuItem>
          <ContextMenuItem disabled={!selected} onClick={refresh}>
            Refresh <ContextMenuShortcut>{binding("refreshNode")}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem danger disabled={!selectedConnection} onClick={() => selectedConnection && onDelete(selectedConnection.id)}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
