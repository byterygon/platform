// The connections and schema tree (DBee spec §3.2, §3.5, §8): one Tree with connection nodes at
// the top, schemas, Tables and Views groups, tables and columns underneath, children loaded on
// expand and cached per session, system schemas under a collapsed "System" node, a filter box, a
// context menu with every connection action, an EmptyState on first run.
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateTitle } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tree, type TreeNode } from "@/components/ui/tree";
import { TypeBadge } from "@/components/ui/type-badge";
import type { ColumnInfo, ConnectionStatus, ConnectionSummary, TableInfo } from "@/gen/api";
import { type Ctx, connect, loadColumns, loadSchemas, loadTables, openTab, quoteIdent } from "../actions";
import { useServices } from "../client";
import { ExpiryBadge } from "./ExpiryBadge";
import { ErrorAlert } from "../ErrorAlert";
import { ColumnIcon, DatabaseIcon, SchemaIcon, TableIcon, ViewIcon } from "../icons";
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

const statusVariant = (status: ConnectionStatus | undefined): "neutral" | "success" | "warning" | "danger" | "info" => {
  switch (status) {
    case "connected":
      return "success";
    case "connecting":
      return "info";
    case "error":
      return "danger";
    case "expired":
      return "warning";
    default:
      return "neutral";
  }
};

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
      icon: <DatabaseIcon style={c.colour ? { color: c.colour } : undefined} />,
      meta: (
        <span className="flex items-center gap-inline-xs">
          <Badge variant={c.tls === "plaintext" ? "warning" : "neutral"} appearance="outline" title={tlsName(c.tls)}>
            {c.tls === "plaintext" ? "plaintext" : "TLS"}
          </Badge>
          <ExpiryBadge expiresAt={c.grant.expiresAt} hideExpired={status === "expired"} />
          {status === "connecting" ? <Spinner size="sm" label="Connecting" /> : <Badge variant={statusVariant(status)} appearance="dot">{status}</Badge>}
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
  /** The remedy of a failed connect (spec §8): Edit connection, Renew access, Retry, Enter the password, ... */
  onRemedy?: (remedy: string, connectionId: string) => void;
}

export function ConnectionsTree({ shell, onAddConnection, onEdit, onRenew, onDelete, onDisconnect, onRemedy }: ConnectionsTreeProps) {
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
      <EmptyState variant="inline" className="m-inset-sm">
        <EmptyStateTitle render={<p />}>No connections yet</EmptyStateTitle>
        <EmptyStateDescription>DBee stores passwords in the OS keychain and never sends anything over the network except to the database you approve.</EmptyStateDescription>
        <EmptyStateActions>
          <Button size="small" onClick={onAddConnection}>
            Add connection
          </Button>
        </EmptyStateActions>
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
      {/* A failed connect (spec §8, "Connect / sessions.open"): the message, the remedy and the correlation id. */}
      {(state.connections ?? []).flatMap((c) => {
        const error = state.connectError[c.id];
        if (!error) return [];
        return [<ErrorAlert key={c.id} error={{ ...error, title: `${c.name}: ${error.title}` }} onRemedy={onRemedy ? (r) => onRemedy(r, c.id) : undefined} className="mx-inset-sm mb-inset-sm" />];
      })}
    </div>
  );
}
