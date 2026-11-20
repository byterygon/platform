// `docker.volumes {}` (Mightyconsole spec §10.4 "Volumes", TSK-81 mockup frame docker-volumes):
// the host's volumes with driver, mountpoint, size (from `/system/df`; when Docker cannot say, the
// footer says why) and the containers that mount them; chips All and Unused, a filter by name or
// label. Remove is off while any container, running or stopped, uses the volume, with which ones
// in its tooltip; removing asks for the volume's name typed (§10.5) because the data cannot come
// back. Live through `docker.events`.
import { useContext, useMemo, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleButton } from "@/components/ui/toggle-button";
import { NoticeContext, Page, PageBar, PageFooter, PageHeader, PageRegion, chipClass, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { linkTo } from "@/app/tab-view";
import type { VolumeRow } from "@/gen/api";
import { ArrowClockwise } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { LinkEvent, TabProps } from "../types";
import { formatBytes } from "./format";
import { type InspectTarget, InspectSheet, RowActions, UsedBy, namesText, removeOutcome, useDockerList } from "./resources";

type VolumeFilter = "all" | "unused";

export function matchesVolume(row: VolumeRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q === "") return true;
  return row.name.toLowerCase().includes(q) || Object.entries(row.labels).some(([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q));
}

/** Why a volume cannot be removed, or `null`. */
export function volumeRefusal(row: VolumeRow): string | null {
  return row.usedBy.length > 0 ? `In use by ${namesText(row.usedBy)}` : null;
}

export function VolumesTab({ profile, connId, client, useTabActions, note, openTab, go: goProp }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });
  const notify = useContext(NoticeContext);
  const list = useDockerList({ client, connId, note, kind: "volume", load: (id) => client.docker.volumes.list({ connId: id }) });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<VolumeFilter>("all");
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [confirm, setConfirm] = useState<VolumeRow | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useTabActions({ refresh: list.reload });

  const volumes = useMemo(() => [...(list.data?.volumes ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [list.data]);
  const unused = volumes.filter((v) => v.usedBy.length === 0);
  const shown = (filter === "unused" ? unused : volumes).filter((v) => matchesVolume(v, search));
  const sized = volumes.filter((v) => v.size !== undefined);
  const total = sized.reduce((n, v) => n + (v.size ?? 0), 0);

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const openContainer = (name: string, event?: LinkEvent) => go({ kind: "docker.container", params: { id: name, view: "overview" }, title: name }, event);

  const remove = async (row: VolumeRow) => {
    setBusy(true);
    try {
      const [result] = await client.docker.volumes.remove({ connId, names: [row.name] });
      notify(result?.error !== undefined ? removeOutcome("volume", [], [{ name: row.name, error: result.error }]) : removeOutcome("volume", [row.name], []));
      setConfirm(null);
    } catch (e) {
      const d = note(e);
      notify({ title: d.title, ...(d.description ? { description: d.description } : {}), type: "warning" });
    } finally {
      setBusy(false);
      list.reload();
    }
  };

  return (
    <Page>
      <PageHeader
        title="Volumes"
        adornment={
          list.events.live ? (
            <Badge appearance="tint" variant="success">
              Live
            </Badge>
          ) : null
        }
        subtitle={[profile.name, list.data ? `${volumes.length} ${volumes.length === 1 ? "volume" : "volumes"}` : null, sized.length > 0 ? formatBytes(total) : null, list.data ? `${unused.length} unused` : null].filter(Boolean).join(" · ")}
        actions={
          <Button appearance="subtle" onClick={list.reload} loading={list.loading && list.data !== null}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      <PageBar aria-label="Filters">
        <SearchInput aria-label="Filter volumes" value={search} onValueChange={setSearch} placeholder="Filter by name or label" className="w-panel-sm" />
        <span className="flex items-center gap-inline-xs">
          {(
            [
              ["all", "All", volumes.length],
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
        {list.data === null && list.loading ? <LoadingRows label="Loading the volumes" /> : null}
        {list.data !== null && shown.length === 0 && !list.error ? <EmptyLine>{volumes.length === 0 ? "No volumes on this host." : "No volume matches the filter."}</EmptyLine> : null}
        {shown.length > 0 ? (
          <Table aria-label="Volumes" size="small" className={cn("min-h-0 flex-1", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Mountpoint</TableHead>
                <TableHead align="end">Size</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead align="end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="max-w-panel-xs truncate font-mono text-code" title={row.name}>
                    {row.name}
                  </TableCell>
                  <TableCell className="text-fg-muted">{row.driver}</TableCell>
                  <TableCell className="max-w-panel-xs truncate font-mono text-code text-fg-muted" title={row.mountpoint}>
                    {row.mountpoint}
                  </TableCell>
                  <TableCell align="end" className="whitespace-nowrap tabular-nums">
                    {row.size === undefined ? <span className="text-fg-muted">—</span> : formatBytes(row.size)}
                  </TableCell>
                  <TableCell className="max-w-panel-sm overflow-hidden">
                    <UsedBy list={row.usedBy} onOpen={openContainer} />
                  </TableCell>
                  <TableCell align="end">
                    <RowActions
                      name={row.name}
                      refusal={volumeRefusal(row)}
                      onInspect={() => setInspect({ what: "volume", name: row.name, load: () => client.docker.volumes.inspect({ connId, name: row.name }) })}
                      onRemove={() => {
                        setTyped("");
                        setConfirm(row);
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        <PageFooter>
          <span>Remove is off while a container, running or stopped, uses the volume; hover it for which one</span>
          <span className="flex-1" />
          <span>{list.data?.sizeError ? `No sizes: /system/df failed (${list.data.sizeError})` : "Size from /system/df"}</span>
        </PageFooter>
      </PageRegion>
      <InspectSheet target={inspect} host={profile.name} note={note} onClose={() => setInspect(null)} />
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && !busy && setConfirm(null)}>
        <AlertDialogContent>
          {confirm ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Remove volume <span className="font-mono">{confirm.name}</span>?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {confirm.size ? `Its ${formatBytes(confirm.size)} of data on ${profile.name} are` : `Its data on ${profile.name} is`} deleted and cannot be brought back. No container uses it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogBody>
                <Field>
                  <FieldLabel>
                    Type <span className="font-mono">{confirm.name}</span> to remove it
                  </FieldLabel>
                  <Input
                    value={typed}
                    onValueChange={setTyped}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && typed === confirm.name && !busy) void remove(confirm);
                    }}
                  />
                </Field>
              </AlertDialogBody>
            </>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            {confirm ? (
              <AlertDialogAction appearance="danger" disabled={typed !== confirm.name} loading={busy} onClick={() => void remove(confirm)}>
                Remove volume
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
