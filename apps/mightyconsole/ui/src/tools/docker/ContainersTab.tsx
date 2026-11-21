// `docker.containers {}` (Mightyconsole spec §10.4 "Containers", TSK-81 mockup frames
// docker-containers and docker-remove): the host's containers in a table grouped by Compose
// project (the working dir beside it, containers outside a project last), live through
// `docker.events` with no polling (the footer names the last event); a filter box (name, image,
// label) and chips (All, Running, Stopped, Problems); multi-select Start, Stop, Restart and Remove
// (actions that make no sense for the selection are off); a project's menu stops or restarts all
// its containers and asks once (§10.5), and its name opens the project's tab (batch 4b). Remove names what goes, says named volumes stay, and offers
// the anonymous volumes and Force; failures stay selected with their reason.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useActiveClock } from "@/app/while-active";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { SearchInput } from "@/components/ui/search-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleButton } from "@/components/ui/toggle-button";
import { LinkButton, NoticeContext, Page, PageBar, PageFooter, PageHeader, PageRegion, chipClass, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { linkTo } from "@/app/tab-view";
import type { ContainerActionResult, ContainerRow } from "@/gen/api";
import { ArrowClockwise, ChevronDown, ChevronRight, Delete, MoreHorizontal, Play, Stack, Stop } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { DescribedError, LinkEvent, TabProps } from "../types";
import { type ContainerFilter, type StateFacts, agoText, changesRows, countWords, formatCreated, formatPorts, groupByProject, imageLabel, matchesFilter, matchesSearch, stateLabel, stateTone } from "./format";
import { useDockerEvents } from "./live";
import { setTreeContainers } from "./tree-data";

/** How long after an event the list is loaded again (a project's restart sends a burst). */
const RELOAD_DEBOUNCE_MS = 300;

const FILTERS: readonly { id: ContainerFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "stopped", label: "Stopped" },
  { id: "problems", label: "Problems" },
];

type Verb = "start" | "stop" | "restart";

/** What a pending confirmation will do. */
type Confirm = { kind: "remove"; rows: ContainerRow[] } | { kind: "project"; verb: "stop" | "restart"; project: string; rows: ContainerRow[] };

/** The state as a coloured dot and its word; an unhealthy container's status says it in danger. */
export function StateBadge({ row }: { row: StateFacts }) {
  return (
    <Badge appearance="dot" size="sm" variant={stateTone(row)}>
      {stateLabel(row.state)}
    </Badge>
  );
}

function StatusText({ status }: { status: string }) {
  const at = status.indexOf("(unhealthy)");
  if (at < 0) return <>{status}</>;
  return (
    <>
      {status.slice(0, at)}
      <span className="text-danger-fg">(unhealthy)</span>
      {status.slice(at + "(unhealthy)".length)}
    </>
  );
}

/** Sentences for a toast: `Started 2 containers`, `Could not stop shop-web-1: …`. */
function outcome(verb: string, done: number, failed: readonly { name: string; error: string }[]): { title: string; description?: string } {
  const past = { start: "Started", stop: "Stopped", restart: "Restarted", remove: "Removed" }[verb] ?? verb;
  const what = (n: number) => `${n} ${n === 1 ? "container" : "containers"}`;
  if (failed.length === 0) return { title: `${past} ${what(done)}` };
  const first = failed[0]!;
  return {
    title: done > 0 ? `${past} ${what(done)}; ${failed.length} failed` : `Could not ${verb} ${failed.length === 1 ? first.name : what(failed.length)}`,
    description: failed.length === 1 ? first.error : failed.map((f) => `${f.name}: ${f.error}`).join("\n"),
  };
}

export interface ContainersTabProps extends TabProps {
  /** Only this Compose project's containers, without the page header (a project tab's Containers view). */
  project?: string | undefined;
}

export function ContainersTab({ profile, connId, client, useTabActions, note, openTab, go: goProp, project, active }: ContainersTabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });
  const notify = useContext(NoticeContext);
  const [rows, setRows] = useState<ContainerRow[] | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ContainerFilter>("all");
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<Verb | "remove" | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [removeVolumes, setRemoveVolumes] = useState(true);
  const [force, setForce] = useState(false);
  const generation = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const list = await client.docker.containers.list({ connId, all: true });
      if (mine !== generation.current) return;
      setRows(list);
      setError(null);
      setTreeContainers(connId, list);
      // A removed container leaves the selection.
      setPicked((p) => new Set([...p].filter((id) => list.some((r) => r.id === id))));
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, note]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => void (reloadTimer.current && clearTimeout(reloadTimer.current)), []);
  useTabActions({ refresh: () => void load() });

  const events = useDockerEvents({
    client,
    connId,
    active,
    types: ["container"],
    onEvent: (event) => {
      if (!changesRows(event)) return;
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void load(), RELOAD_DEBOUNCE_MS);
    },
  });

  // The footer's "4 s ago" moves on by itself.
  const now = useActiveClock(active, true, 5000);

  const all = useMemo(() => (rows ?? []).filter((r) => project === undefined || r.project === project), [rows, project]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, all.filter((r) => matchesFilter(r, f.id)).length])) as Record<ContainerFilter, number>, [all]);
  const shown = useMemo(() => all.filter((r) => matchesFilter(r, filter) && matchesSearch(r, search)), [all, filter, search]);
  const groups = useMemo(() => (grouped ? groupByProject(shown) : [{ project: null, rows: groupByProject(shown).flatMap((g) => g.rows) }]), [grouped, shown]);
  const selection = all.filter((r) => picked.has(r.id));

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const open = (row: ContainerRow, event?: LinkEvent) => go({ kind: "docker.container", params: { id: row.name, view: "overview" }, title: row.name }, event);
  const toggle = (ids: readonly string[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  /** Runs a verb on rows, reports, keeps the failures selected. */
  const act = async (verb: Verb | "remove", targets: readonly ContainerRow[]) => {
    if (targets.length === 0) return;
    setBusy(verb);
    try {
      const ids = targets.map((r) => r.id);
      let results: ContainerActionResult[];
      if (verb === "remove") results = await client.docker.containers.remove({ connId, ids, force, volumes: removeVolumes });
      else results = await client.docker.containers[verb]({ connId, ids, timeoutSec: null });
      const failed = results.filter((r) => r.error !== undefined).map((r) => ({ id: r.id, name: targets.find((t) => t.id === r.id)?.name ?? r.id, error: r.error! }));
      const said = outcome(verb, results.length - failed.length, failed);
      notify({ ...said, type: failed.length > 0 ? "warning" : "success" });
      setPicked(new Set(failed.map((f) => f.id)));
      setConfirm(null);
    } catch (e) {
      const d = note(e);
      notify({ title: d.title, ...(d.description ? { description: d.description } : {}), type: "warning" });
    } finally {
      setBusy(null);
      void load();
    }
  };

  const canStart = selection.some((r) => r.state !== "running" && r.state !== "restarting");
  const canStop = selection.some((r) => r.state === "running" || r.state === "restarting" || r.state === "paused");
  const visibleIds = groups.flatMap((g) => g.rows.map((r) => r.id));
  const allPicked = visibleIds.length > 0 && visibleIds.every((id) => picked.has(id));
  const somePicked = visibleIds.some((id) => picked.has(id));
  const running = all.filter((r) => r.state === "running").length;
  const restarting = all.filter((r) => r.state === "restarting").length;
  const last = events.last;

  return (
    <Page>
      {project === undefined ? (
        <PageHeader
          title="Containers"
          adornment={
            events.live ? (
              <Badge appearance="tint" variant="success">
                Live
              </Badge>
            ) : null
          }
          subtitle={[profile.name, rows ? `${all.length} ${all.length === 1 ? "container" : "containers"}` : null, rows ? `${running} running` : null, restarting > 0 ? `${restarting} restarting` : null].filter(Boolean).join(" · ")}
          actions={
            <Button appearance="subtle" onClick={() => void load()} loading={loading && rows !== null}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
          }
        />
      ) : null}
      <PageBar aria-label="Filters and actions">
        <SearchInput aria-label="Filter containers" value={search} onValueChange={setSearch} placeholder="Filter by name, image or label" className="w-panel-xs" />
        <span className="flex items-center gap-inline-xs">
          {FILTERS.map((f) => (
            <ToggleButton key={f.id} size="small" appearance="outline" pressed={filter === f.id} onPressedChange={(p) => p && setFilter(f.id)} className={chipClass}>
              {f.label} <span className="tabular-nums">{counts[f.id]}</span>
            </ToggleButton>
          ))}
        </span>
        {project === undefined ? (
          <label className="flex items-center gap-inline-sm whitespace-nowrap text-body-1 text-fg">
            <Checkbox checked={grouped} onCheckedChange={(c) => setGrouped(c === true)} /> Group by project
          </label>
        ) : null}
        <span className="flex-1" />
        {selection.length > 0 ? (
          <>
            <span className="whitespace-nowrap text-body-1 text-fg-muted">{selection.length} selected</span>
            <Button appearance="secondary" disabled={!canStart || busy !== null} loading={busy === "start"} onClick={() => void act("start", selection.filter((r) => r.state !== "running" && r.state !== "restarting"))}>
              <Icon icon={Play} /> Start
            </Button>
            <Button appearance="secondary" disabled={!canStop || busy !== null} loading={busy === "stop"} onClick={() => void act("stop", selection.filter((r) => r.state === "running" || r.state === "restarting" || r.state === "paused"))}>
              <Icon icon={Stop} /> Stop
            </Button>
            <Button appearance="secondary" disabled={busy !== null} loading={busy === "restart"} onClick={() => void act("restart", selection)}>
              <Icon icon={ArrowClockwise} /> Restart
            </Button>
            <Button
              appearance="secondary"
              disabled={busy !== null}
              onClick={() => {
                setForce(false);
                setRemoveVolumes(true);
                setConfirm({ kind: "remove", rows: selection });
              }}
            >
              <Icon icon={Delete} /> Remove…
            </Button>
          </>
        ) : null}
      </PageBar>
      <PageRegion>
        {error ? (
          <div className="px-inset-lg pt-stack-md">
            <ErrorState error={error} onRetry={() => void load()} />
          </div>
        ) : null}
        {rows === null && loading ? <LoadingRows label="Loading the containers" /> : null}
        {rows !== null && shown.length === 0 && !error ? <EmptyLine>{all.length === 0 ? "No containers on this host." : "No container matches the filter."}</EmptyLine> : null}
        {shown.length > 0 ? (
          <Table aria-label="Containers" size="small" className={cn("min-h-0 flex-1", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-control-md">
                  <Checkbox aria-label="Select every container shown" checked={allPicked} indeterminate={somePicked && !allPicked} onCheckedChange={(c) => toggle(visibleIds, c === true)} />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Image</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Ports</TableHead>
                <TableHead>Service</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => {
                const key = group.project ?? "";
                const closed = grouped && collapsed.has(key);
                const groupIds = group.rows.map((r) => r.id);
                return [
                  grouped ? (
                    <TableRow key={`group:${key}`} className="bg-neutral-subtle">
                      <TableCell>
                        <IconButton
                          size="small"
                          appearance="subtle"
                          aria-label={closed ? `Show ${group.project ?? "containers without a project"}` : `Hide ${group.project ?? "containers without a project"}`}
                          aria-expanded={!closed}
                          onClick={() =>
                            setCollapsed((c) => {
                              const next = new Set(c);
                              if (closed) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        >
                          <Icon icon={closed ? ChevronRight : ChevronDown} />
                        </IconButton>
                      </TableCell>
                      <TableCell colSpan={7}>
                        <span className="flex min-w-0 items-center gap-inline-md">
                          {group.project !== null ? <Icon icon={Stack} /> : null}
                          {group.project !== null && project === undefined ? (
                            <LinkButton className="text-body-1-strong" title={`Open ${group.project}'s merged logs`} onOpen={(event) => go({ kind: "docker.project", params: { project: group.project!, view: "logs" }, title: group.project! }, event)}>
                              {group.project}
                            </LinkButton>
                          ) : (
                            <span className="text-body-1-strong text-fg">{group.project ?? "No project"}</span>
                          )}
                          <span className="truncate text-body-1 text-fg-muted">
                            {countWords(group.rows)}
                            {group.workingDir ? (
                              <>
                                {" · "}
                                <span className="font-mono text-code">{group.workingDir}</span>
                              </>
                            ) : null}
                          </span>
                          <span className="flex-1" />
                          <Checkbox aria-label={`Select the containers of ${group.project ?? "no project"}`} checked={groupIds.every((id) => picked.has(id))} indeterminate={groupIds.some((id) => picked.has(id)) && !groupIds.every((id) => picked.has(id))} onCheckedChange={(c) => toggle(groupIds, c === true)} />
                          {group.project !== null ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger render={<IconButton size="small" appearance="subtle" aria-label={`Actions for project ${group.project}`} />}>
                                <Icon icon={MoreHorizontal} />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem disabled={!group.rows.some((r) => r.state !== "running")} onClick={() => void act("start", group.rows.filter((r) => r.state !== "running" && r.state !== "restarting"))}>
                                  <Icon icon={Play} /> Start all
                                </DropdownMenuItem>
                                <DropdownMenuItem disabled={!group.rows.some((r) => r.state === "running" || r.state === "restarting")} onClick={() => setConfirm({ kind: "project", verb: "stop", project: group.project!, rows: group.rows.filter((r) => r.state === "running" || r.state === "restarting" || r.state === "paused") })}>
                                  <Icon icon={Stop} /> Stop all…
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setConfirm({ kind: "project", verb: "restart", project: group.project!, rows: group.rows })}>
                                  <Icon icon={ArrowClockwise} /> Restart all…
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </span>
                      </TableCell>
                    </TableRow>
                  ) : null,
                  ...(closed
                    ? []
                    : group.rows.map((row) => (
                        <TableRow key={row.id} selected={picked.has(row.id)}>
                          <TableCell>
                            <Checkbox aria-label={`Select ${row.name}`} checked={picked.has(row.id)} onCheckedChange={(c) => toggle([row.id], c === true)} />
                          </TableCell>
                          <TableCell>
                            <LinkButton onOpen={(e) => open(row, e)}>{row.name}</LinkButton>
                          </TableCell>
                          <TableCell className="max-w-panel-xs truncate font-mono text-code text-fg-muted" title={row.image}>
                            {imageLabel(row.image)}
                          </TableCell>
                          <TableCell>
                            <StateBadge row={row} />
                          </TableCell>
                          <TableCell className="text-fg-muted">
                            <StatusText status={row.status} />
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-fg-muted">{formatCreated(row.created)}</TableCell>
                          <TableCell className="font-mono text-code text-fg-muted">{formatPorts(row.ports) || "—"}</TableCell>
                          <TableCell className="text-fg-muted">{row.service ?? ""}</TableCell>
                        </TableRow>
                      ))),
                ];
              })}
            </TableBody>
          </Table>
        ) : null}
        <PageFooter>
          <span>
            {events.live
              ? last
                ? `Updated from docker.events · last event ${agoText(last.timeMs, now)} (${last.name ?? last.id.slice(0, 12)} ${last.action.split(":")[0]})`
                : "Updated from docker.events · no event yet"
              : events.error
                ? `Live updates stopped: ${events.error}. Trying again…`
                : "Not live"}
          </span>
          <span className="flex-1" />
          <span>Start, Stop and Restart act on the selection; a project's menu acts on all its containers</span>
        </PageFooter>
      </PageRegion>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && busy === null && setConfirm(null)}>
        <AlertDialogContent>
          {confirm?.kind === "remove" ? (
            <RemoveBody rows={confirm.rows} host={profile.name} volumes={removeVolumes} onVolumes={setRemoveVolumes} force={force} onForce={setForce} />
          ) : confirm?.kind === "project" ? (
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm.verb === "stop" ? "Stop" : "Restart"} the project {confirm.project}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm.rows.length} {confirm.rows.length === 1 ? "container" : "containers"} on {profile.name}: {confirm.rows.map((r) => r.name).join(", ")}. Each gets 10 seconds to stop before Docker kills it.
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            {confirm?.kind === "remove" ? (
              <AlertDialogAction appearance="danger" loading={busy === "remove"} onClick={() => void act("remove", confirm.rows)}>
                Remove {confirm.rows.length} {confirm.rows.length === 1 ? "container" : "containers"}
              </AlertDialogAction>
            ) : confirm?.kind === "project" ? (
              <AlertDialogAction appearance="primary" loading={busy === confirm.verb} onClick={() => void act(confirm.verb, confirm.rows)}>
                {confirm.verb === "stop" ? "Stop" : "Restart"} {confirm.rows.length} {confirm.rows.length === 1 ? "container" : "containers"}
              </AlertDialogAction>
            ) : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function RemoveBody({ rows, host, volumes, onVolumes, force, onForce }: { rows: readonly ContainerRow[]; host: string; volumes: boolean; onVolumes(v: boolean): void; force: boolean; onForce(v: boolean): void }) {
  const running = rows.filter((r) => r.state === "running" || r.state === "restarting" || r.state === "paused").length;
  const n = rows.length;
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          Remove {n === 1 ? rows[0]!.name : `${n} containers`}?
        </AlertDialogTitle>
        <AlertDialogDescription>
          {rows.map((r, i) => (
            <span key={r.id}>
              {i > 0 ? ", " : null}
              <span className="font-mono text-code">{r.name}</span>
            </span>
          ))}{" "}
          on {host}. {n === 1 ? "Its" : "Their"} logs and writable {n === 1 ? "layer go" : "layers go"} with {n === 1 ? "it" : "them"}; named volumes stay.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogBody className="flex flex-col gap-stack-sm">
        <label className="flex items-center gap-inline-sm text-body-1 text-fg">
          <Checkbox checked={volumes} onCheckedChange={(c) => onVolumes(c === true)} /> Remove {n === 1 ? "its" : "their"} anonymous volumes
        </label>
        <label className={cn("flex items-center gap-inline-sm text-body-1", running === 0 ? "text-fg-disabled" : "text-fg")}>
          <Checkbox checked={force} disabled={running === 0} onCheckedChange={(c) => onForce(c === true)} /> Force: stop running containers first
          <span className="text-fg-muted">· {running === 0 ? "none are running" : `${running} running`}</span>
        </label>
        {running > 0 && !force ? <p className="text-caption-1 text-fg-muted">Without Force, Docker refuses to remove a running container; the others are removed.</p> : null}
      </AlertDialogBody>
    </>
  );
}
