// `docker.networks {}` (Mightyconsole spec §10.4 "Networks", TSK-81 mockup frame docker-volumes,
// "the same table"): the host's networks with driver, scope, subnets and gateways, and the
// containers attached; chips All and Unused, a filter by name, driver or subnet. `bridge`, `host`
// and `none` cannot be removed, nor a network a running container is attached to (Docker refuses);
// the reason is in Remove's tooltip. Removing asks once (§10.5) and names the stopped containers
// that will not start without it. Live through `docker.events`.
import { useContext, useMemo, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SearchInput } from "@/components/ui/search-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleButton } from "@/components/ui/toggle-button";
import { NoticeContext, Page, PageBar, PageFooter, PageHeader, PageRegion, chipClass, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { linkTo } from "@/app/tab-view";
import type { NetworkRow } from "@/gen/api";
import { ArrowClockwise } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { LinkEvent, TabProps } from "../types";
import { type InspectTarget, InspectSheet, RowActions, UsedBy, namesText, removeOutcome, runningUsers, useDockerList } from "./resources";

type NetworkFilter = "all" | "unused";

export function matchesNetwork(row: NetworkRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q === "") return true;
  return [row.name, row.driver, row.id, ...row.subnets.map((s) => s.subnet)].some((s) => s.toLowerCase().includes(q));
}

/** Why a network cannot be removed, or `null`. */
export function networkRefusal(row: NetworkRow): string | null {
  if (row.builtIn) return `Every engine has ${row.name}; Docker cannot remove it`;
  const running = runningUsers(row.usedBy);
  if (running.length > 0) return `${namesText(running)} ${running.length === 1 ? "is" : "are"} attached and running; stop ${running.length === 1 ? "it" : "them"} first`;
  return null;
}

export function NetworksTab({ profile, connId, client, useTabActions, note, openTab, go: goProp }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });
  const notify = useContext(NoticeContext);
  const list = useDockerList({ client, connId, note, kind: "network", load: (id) => client.docker.networks.list({ connId: id }) });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<NetworkFilter>("all");
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [confirm, setConfirm] = useState<NetworkRow | null>(null);
  const [busy, setBusy] = useState(false);
  useTabActions({ refresh: list.reload });

  // The predefined networks first, then by name.
  const networks = useMemo(() => [...(list.data ?? [])].sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name)), [list.data]);
  const unused = networks.filter((n) => n.usedBy.length === 0 && !n.builtIn);
  const shown = (filter === "unused" ? unused : networks).filter((n) => matchesNetwork(n, search));

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const openContainer = (name: string, event?: LinkEvent) => go({ kind: "docker.container", params: { id: name, view: "overview" }, title: name }, event);

  const remove = async (row: NetworkRow) => {
    setBusy(true);
    try {
      const [result] = await client.docker.networks.remove({ connId, ids: [row.id] });
      notify(result?.error !== undefined ? removeOutcome("network", [], [{ name: row.name, error: result.error }]) : removeOutcome("network", [row.name], []));
      setConfirm(null);
    } catch (e) {
      const d = note(e);
      notify({ title: d.title, ...(d.description ? { description: d.description } : {}), type: "warning" });
    } finally {
      setBusy(false);
      list.reload();
    }
  };

  const stopped = confirm ? confirm.usedBy.filter((u) => u.state !== "running") : [];
  return (
    <Page>
      <PageHeader
        title="Networks"
        adornment={
          list.events.live ? (
            <Badge appearance="tint" variant="success">
              Live
            </Badge>
          ) : null
        }
        subtitle={[profile.name, list.data ? `${networks.length} ${networks.length === 1 ? "network" : "networks"}` : null, list.data ? `${unused.length} unused` : null].filter(Boolean).join(" · ")}
        actions={
          <Button appearance="subtle" onClick={list.reload} loading={list.loading && list.data !== null}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      <PageBar aria-label="Filters">
        <SearchInput aria-label="Filter networks" value={search} onValueChange={setSearch} placeholder="Filter by name, driver or subnet" className="w-panel-sm" />
        <span className="flex items-center gap-inline-xs">
          {(
            [
              ["all", "All", networks.length],
              ["unused", "Unused", unused.length],
            ] as const
          ).map(([id, label, n]) => (
            <ToggleButton key={id} size="small" appearance="outline" pressed={filter === id} onPressedChange={(p) => p && setFilter(id)} className={chipClass}>
              {label} <span className="tabular-nums">{n}</span>
            </ToggleButton>
          ))}
        </span>
      </PageBar>
      <PageRegion>
        {list.error ? (
          <div className="px-inset-lg pt-stack-md">
            <ErrorState error={list.error} onRetry={list.reload} />
          </div>
        ) : null}
        {list.data === null && list.loading ? <LoadingRows label="Loading the networks" /> : null}
        {list.data !== null && shown.length === 0 && !list.error ? <EmptyLine>{networks.length === 0 ? "No networks on this host." : "No network matches the filter."}</EmptyLine> : null}
        {shown.length > 0 ? (
          <Table aria-label="Networks" size="small" className={cn("min-h-0 flex-1", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Driver and scope</TableHead>
                <TableHead>Subnet and gateway</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead align="end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-panel-xs" title={row.id}>
                    <span className="flex min-w-0 items-center gap-inline-sm">
                      <span className="truncate font-mono text-code">{row.name}</span>
                      {row.builtIn ? (
                        <Badge size="sm" variant="neutral">
                          Predefined
                        </Badge>
                      ) : null}
                      {row.internal ? (
                        <Badge size="sm" variant="info">
                          Internal
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-fg-muted">
                    {row.driver} · {row.scope}
                  </TableCell>
                  <TableCell className="font-mono text-code text-fg-muted">
                    {row.subnets.length === 0
                      ? "—"
                      : row.subnets.map((s) => (
                          <span key={s.subnet} className="block whitespace-nowrap">
                            {s.subnet}
                            {s.gateway ? ` · ${s.gateway}` : ""}
                          </span>
                        ))}
                  </TableCell>
                  <TableCell className="max-w-panel-sm overflow-hidden">
                    <UsedBy list={row.usedBy} onOpen={openContainer} />
                  </TableCell>
                  <TableCell align="end">
                    <RowActions name={row.name} refusal={networkRefusal(row)} onInspect={() => setInspect({ what: "network", name: row.name, load: () => client.docker.networks.inspect({ connId, id: row.id }) })} onRemove={() => setConfirm(row)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        <PageFooter>
          <span>bridge, host and none cannot be removed, nor a network a running container is attached to</span>
        </PageFooter>
      </PageRegion>
      <InspectSheet target={inspect} host={profile.name} note={note} onClose={() => setInspect(null)} />
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          {confirm ? (
            <AlertDialogHeader>
              <AlertDialogTitle>
                Remove network <span className="font-mono">{confirm.name}</span>?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm.driver} network on {profile.name}
                {confirm.subnets[0] ? ` (${confirm.subnets.map((s) => s.subnet).join(", ")})` : ""}.{" "}
                {stopped.length > 0 ? `The stopped ${stopped.length === 1 ? "container" : "containers"} ${namesText(stopped)} ${stopped.length === 1 ? "is" : "are"} attached to it and will not start until it is made again.` : "No container is attached to it."}
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            {confirm ? (
              <AlertDialogAction appearance="danger" loading={busy} onClick={() => void remove(confirm)}>
                Remove network
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
