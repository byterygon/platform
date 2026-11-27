// Settings → Routes (DOC-23 §10, (o), (v), (w); mockup frames routes-list and routes-delete): one
// row per route with its hops as chips in order, the profiles that use it, and Edit, Duplicate,
// Delete. New route offers a route of hops or a System proxy route. A route whose command nobody
// confirmed says so. Deleting asks first and lists the profiles: they show "Route missing" and
// never connect Direct on their own.
import { useMemo, useState } from "react";
import { AlertDialog, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { RouteKind, RouteView } from "@/gen/api";
import { Add, ChevronDown, Copy, Delete, Edit } from "@/lib/icons";
import { deleteRoute, duplicateRoute, hopChip, routeUsedByText, useRoutes } from "@/profiles/routes";
import type { MightyClient } from "../client";
import { describeError } from "../messages";
import { ErrorState } from "../states";
import type { DescribedError } from "@/tools/types";
import { RouteEditor } from "./RouteEditor";

export interface RoutesSectionProps {
  client: MightyClient;
  /** Opens a profile that uses a route (its editor). */
  onOpenProfile?: (profileId: string, tool: string) => void;
}

/** A free "<name> copy", "<name> copy 2", … among `taken`. */
export function copyName(name: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  const base = `${name} copy`;
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

export function RoutesSection({ client, onOpenProfile }: RoutesSectionProps) {
  const routes = useRoutes();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<{ route?: RouteView; kind?: RouteKind } | null>(null);
  const [deleting, setDeleting] = useState<RouteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (f === "") return routes;
    return routes.filter((r) => [r.name, ...r.hops.map(hopChip)].some((s) => s.toLowerCase().includes(f)));
  }, [routes, filter]);
  const depending = routes.reduce((n, r) => n + r.usedBy.length + r.usedByHidden, 0);

  const duplicate = async (route: RouteView) => {
    setError(null);
    try {
      await duplicateRoute(
        client,
        route,
        copyName(
          route.name,
          routes.map((r) => r.name),
        ),
      );
    } catch (e) {
      setError(describeError(e));
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await deleteRoute(client, deleting);
      setDeleting(null);
    } catch (e) {
      setError(describeError(e));
      setDeleting(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-stack-sm">
      <div className="flex items-start gap-inline-md">
        <div className="flex min-w-0 flex-1 flex-col gap-stack-xs">
          <h3 className="text-subtitle-2">Routes</h3>
          <p className="text-body-1 text-fg-muted">
            {routes.length} route{routes.length === 1 ? "" : "s"} · {depending} profile{depending === 1 ? "" : "s"} connect through one; every other profile connects Direct, the default.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button appearance="primary" />}>
            <Icon icon={Add} /> New route <Icon icon={ChevronDown} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label="New route">
            <DropdownMenuItem onClick={() => setEditing({ kind: "path" })}>A route of hops</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setEditing({ kind: "system" })}>System proxy (the server's HTTPS_PROXY, ALL_PROXY, NO_PROXY)</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Input aria-label="Filter routes" value={filter} onValueChange={setFilter} placeholder="Filter by name or hop" className="w-panel-xs" />
      {error ? <ErrorState error={error} /> : null}
      <Table aria-label="Routes" size="small">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Hops</TableHead>
            <TableHead>Used by</TableHead>
            <TableHead align="end">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="text-fg-muted">
                {routes.length === 0 ? "No route yet. A profile connects Direct until it names one: New route." : "No route matches the filter."}
              </TableCell>
            </TableRow>
          ) : (
            shown.map((r) => {
              const editable = r.access === "owner" || r.access === "edit";
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <b>{r.name}</b>
                    {r.owner.kind === "shared" ? <span className="ms-inline-xs text-caption-1 text-fg-muted">shared</span> : null}
                    {!r.confirmed ? (
                      <Badge variant="warning" className="ms-inline-xs">
                        Not confirmed
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {r.kind === "system" ? (
                      <Badge>System proxy</Badge>
                    ) : (
                      <span className="flex flex-wrap items-center gap-inline-xs" aria-label={`Hops of ${r.name}`}>
                        {r.hops.map((h, i) => (
                          <span key={h.linkId} className="inline-flex items-center gap-inline-xs">
                            {i > 0 ? <span className="text-fg-muted">→</span> : null}
                            <Badge appearance="outline">{hopChip(h)}</Badge>
                          </span>
                        ))}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-fg-muted">{r.usedBy.length > 0 ? r.usedBy.map((u) => `${u.name} (${u.tool})`).join(", ") + (r.usedByHidden > 0 ? ` and ${r.usedByHidden} you do not see` : "") : routeUsedByText(r)}</TableCell>
                  <TableCell align="end">
                    <span className="inline-flex gap-inline-xs">
                      <IconButton aria-label={`Edit ${r.name}`} title="Edit" size="small" appearance="subtle" onClick={() => setEditing({ route: r })}>
                        <Icon icon={Edit} />
                      </IconButton>
                      <IconButton aria-label={`Duplicate ${r.name}`} title="Duplicate (the same hops, with their secrets)" size="small" appearance="subtle" disabled={!editable} onClick={() => void duplicate(r)}>
                        <Icon icon={Copy} />
                      </IconButton>
                      <IconButton aria-label={`Delete ${r.name}`} title="Delete" size="small" appearance="subtle" disabled={!editable} onClick={() => setDeleting(r)}>
                        <Icon icon={Delete} />
                      </IconButton>
                    </span>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      <p className="text-caption-1 text-fg-muted">Proxy passwords and command secrets are write-only. Export carries routes but never a secret; an imported route with a command arrives not confirmed.</p>
      {editing ? (
        <RouteEditor
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          client={client}
          route={editing.route}
          kind={editing.kind ?? "path"}
        />
      ) : null}
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete route {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && deleting.usedBy.length + deleting.usedByHidden > 0
                ? "These profiles connect through it. Afterwards they show Route missing and wait for a choice; none is turned into Direct, which would send its connection around the route."
                : "No profile uses it. Its proxies and SSH hosts stay; only the route and the secrets of its commands go."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleting && deleting.usedBy.length + deleting.usedByHidden > 0 ? (
            <AlertDialogBody>
              <ul className="flex flex-col gap-stack-xs" aria-label="Used by">
                {deleting.usedBy.map((u) => (
                  <li key={u.id} className="flex items-center gap-inline-sm text-body-1">
                    <span>
                      <b>{u.name}</b> <span className="text-fg-muted">({u.tool})</span>
                    </span>
                    {onOpenProfile ? (
                      <Button
                        size="small"
                        appearance="subtle"
                        className="ms-auto"
                        onClick={() => {
                          setDeleting(null);
                          onOpenProfile(u.id, u.tool);
                        }}
                      >
                        Open
                      </Button>
                    ) : null}
                  </li>
                ))}
                {deleting.usedByHidden > 0 ? <li className="text-caption-1 text-fg-muted">and {deleting.usedByHidden} you do not see</li> : null}
              </ul>
            </AlertDialogBody>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button appearance="danger" loading={busy} onClick={() => void remove()}>
              Delete route
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
