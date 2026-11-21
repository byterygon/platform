// `docker.container { id, view }` (Mightyconsole spec §10.4, TSK-81 mockup frames docker-overview,
// docker-logs): one container. The header names it with its state and health, the host, the short
// id, the project and service, the image and how long it has run; Start or Stop, Restart, and
// Remove behind More. Views: Overview (facts, command, networks, ports, mounts, the environment
// with values hidden until shown in the browser, labels folded; beside it the health check's last
// results and the container's recent events), Logs (LogsPanel), Stats (StatsPanel), Terminal
// (TerminalPanel, an exec), Files (FilesPanel, read only, batch 4c) and Inspect (the JsonViewer of
// `docker inspect`). The header follows the container's events, so a restart or a health change
// shows without a refresh.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { JsonViewer } from "@/components/ui/json-viewer";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton, NoticeContext, Page, PageHeader } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { useTabView } from "@/app/tab-view";
import type { ContainerInspectOutput, ContainerOverview } from "@/gen/api";
import { ArrowClockwise, CheckmarkCircle, ChevronDown, ChevronRight, Delete, ErrorCircle, Eye, EyeOff, MoreHorizontal, Play, Stop, WindowConsole } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { DescribedError, TabProps } from "../types";
import { StateBadge } from "./ContainersTab";
import { type DockerEvent, changesRows, commandLine, imageLabel, shortId, spanWords } from "./format";
import { useDockerEvents } from "./live";
import { FilesPanel } from "./FilesPanel";
import { LogsPanel } from "./LogsPanel";
import { StatsPanel } from "./StatsPanel";
import { TerminalPanel } from "./TerminalPanel";

/** The container's views, the last word of its URL (DOC-21 §3.7). */
export const CONTAINER_VIEWS = ["overview", "logs", "stats", "terminal", "files", "inspect"] as const;
export type ContainerView = (typeof CONTAINER_VIEWS)[number];

/** Events kept for the Overview's "Recent events". */
const RECENT_EVENTS = 8;

/** `07:12:09` in the browser's time zone. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** `18 Nov, 07:12` from an RFC 3339 time. */
function when(rfc3339: string | undefined): string {
  if (!rfc3339) return "—";
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return rfc3339;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** `up 3 hours`, `exited (3) 2 minutes ago` for the subtitle. */
export function runningFor(o: ContainerOverview, now = Date.now()): string {
  if (o.running && o.startedAt) return `up ${spanWords(now - Date.parse(o.startedAt))}`;
  if (o.finishedAt) return `exited (${o.exitCode ?? "?"}) ${spanWords(now - Date.parse(o.finishedAt))} ago`;
  return o.state;
}

/** `2 CPUs · 1 GiB`, or `none`. */
export function limitsText(o: ContainerOverview): string {
  const parts: string[] = [];
  if (o.cpus !== undefined) parts.push(`${Number(o.cpus.toFixed(2))} ${o.cpus === 1 ? "CPU" : "CPUs"}`);
  if (o.memoryLimit !== undefined) {
    const gib = o.memoryLimit / 1024 ** 3;
    parts.push(gib >= 1 ? `${Number(gib.toFixed(1))} GiB` : `${Math.round(o.memoryLimit / 1024 ** 2)} MiB`);
  }
  return parts.length > 0 ? parts.join(" · ") : "none";
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-stack-xs">
      <dt className="text-caption-1 text-fg-muted">{term}</dt>
      <dd className="m-0 text-body-1 text-fg">{children}</dd>
    </div>
  );
}

function Pair({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails>{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

const mono = "font-mono text-code";

export function ContainerTab({ tab, profile, connId, client, note, onLive, useTabActions, navigate, active }: TabProps) {
  const notify = useContext(NoticeContext);
  const id = typeof tab.params["id"] === "string" ? tab.params["id"] : "";
  const [view, setView] = useTabView({ tab, navigate }, CONTAINER_VIEWS, "overview");
  const [data, setData] = useState<ContainerInspectOutput | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeVolumes, setRemoveVolumes] = useState(true);
  const [force, setForce] = useState(false);
  const [recent, setRecent] = useState<DockerEvent[]>([]);
  const generation = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (connId === null || id === "") return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const out = await client.docker.containers.inspect({ connId, id });
      if (mine !== generation.current) return;
      setData(out);
      setError(null);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, id, note]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => void (reloadTimer.current && clearTimeout(reloadTimer.current)), []);
  useTabActions(view === "logs" || view === "stats" || view === "files" ? {} : { refresh: () => void load() });
  // The terminal stays mounted once shown: its exec lives while the tab does.
  const [terminalSeen, setTerminalSeen] = useState(view === "terminal");
  useEffect(() => {
    if (view === "terminal") setTerminalSeen(true);
  }, [view]);

  useDockerEvents({
    client,
    connId,
    container: id,
    active,
    types: ["container"],
    onEvent: (event) => {
      setRecent((r) => [event, ...r].slice(0, RECENT_EVENTS));
      if (!changesRows(event)) return;
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => void load(), 300);
    },
  });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const o = data?.overview;

  const act = async (verb: "start" | "stop" | "restart" | "remove") => {
    if (!o) return;
    setBusy(verb);
    try {
      const [result] = verb === "remove" ? await client.docker.containers.remove({ connId, ids: [o.id], force, volumes: removeVolumes }) : await client.docker.containers[verb]({ connId, ids: [o.id], timeoutSec: null });
      if (result?.error) notify({ title: `Could not ${verb} ${o.name}`, description: result.error, type: "warning" });
      else notify({ title: `${{ start: "Started", stop: "Stopped", restart: "Restarted", remove: "Removed" }[verb]} ${o.name}`, type: "success" });
      if (verb === "remove" && !result?.error) setRemoving(false);
    } catch (e) {
      const d = note(e);
      notify({ title: d.title, ...(d.description ? { description: d.description } : {}), type: "warning" });
    } finally {
      setBusy(null);
      void load();
    }
  };

  const stoppable = o !== undefined && (o.running || o.restarting || o.paused);
  const health = o?.health?.status;
  return (
    <Page>
      <PageHeader
        title={o?.name ?? id}
        adornment={
          o ? (
            <>
              <CopyButton value={o.id} what="container ID" />
              <StateBadge row={{ state: o.state, exitCode: o.exitCode, health }} />
              {health && health !== "none" ? (
                <Badge appearance="tint" size="sm" variant={health === "healthy" ? "success" : health === "unhealthy" ? "danger" : "warning"}>
                  {health}
                </Badge>
              ) : null}
            </>
          ) : null
        }
        subtitle={
          o ? (
            <>
              {profile.name} · <span className={mono}>{shortId(o.id)}</span>
              {o.project ? (
                <>
                  {" · project "}
                  <span className="text-body-1-strong text-fg">{o.project}</span>
                  {o.service ? (
                    <>
                      {", service "}
                      <span className="text-body-1-strong text-fg">{o.service}</span>
                    </>
                  ) : null}
                </>
              ) : null}
              {" · "}
              <span className={mono} title={o.image}>
                {imageLabel(o.image)}
              </span>{" "}
              · {runningFor(o)}
            </>
          ) : (
            profile.name
          )
        }
        actions={
          o ? (
            <>
              {stoppable ? (
                <Button appearance="secondary" loading={busy === "stop"} disabled={busy !== null} onClick={() => void act("stop")}>
                  <Icon icon={Stop} /> Stop
                </Button>
              ) : (
                <Button appearance="secondary" loading={busy === "start"} disabled={busy !== null} onClick={() => void act("start")}>
                  <Icon icon={Play} /> Start
                </Button>
              )}
              <Button appearance="secondary" loading={busy === "restart"} disabled={busy !== null} onClick={() => void act("restart")}>
                <Icon icon={ArrowClockwise} /> Restart
              </Button>
              <Button appearance="subtle" disabled={!o.running} onClick={() => setView("terminal")}>
                <Icon icon={WindowConsole} /> Terminal
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<IconButton appearance="subtle" aria-label="More actions" />}>
                  <Icon icon={MoreHorizontal} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void load()}>
                    <Icon icon={ArrowClockwise} /> Refresh
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      setForce(false);
                      setRemoveVolumes(true);
                      setRemoving(true);
                    }}
                  >
                    <Icon icon={Delete} /> Remove…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null
        }
      />
      {error ? (
        <div className="px-inset-lg pt-stack-md">
          <ErrorState error={error} onRetry={() => void load()} onRefresh={() => void load()} />
        </div>
      ) : null}
      {loading && data === null ? <LoadingRows label="Loading the container" /> : null}
      {data && o ? (
        <Tabs value={view} onValueChange={(v) => setView(v as ContainerView)} className="mt-stack-md flex min-h-0 flex-1 flex-col gap-0">
          <TabsList aria-label="Container views" className="gap-inline-xs px-inset-lg [&_[data-slot=tabs-trigger]]:h-control-lg [&_[data-slot=tabs-trigger]]:px-inline-md [&_[data-slot=tabs-item]:first-child]:-ms-inline-md">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="stats">Stats</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="inspect">Inspect</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="flex min-h-0 flex-1 flex-col border-t border-border-subtle">
            <Overview o={o} recent={recent} />
          </TabsContent>
          <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col">
            {view === "logs" ? <LogsPanel active={active} client={client} connId={connId} note={note} onLive={onLive} useTabActions={useTabActions} container={o.name || o.id} running={o.running || o.restarting} /> : null}
          </TabsContent>
          <TabsContent value="stats" className="flex min-h-0 flex-1 flex-col">
            {view === "stats" ? <StatsPanel active={active} client={client} connId={connId} note={note} onLive={onLive} useTabActions={useTabActions} container={o.name || o.id} overview={o} /> : null}
          </TabsContent>
          {/* Kept mounted once opened, so switching views does not end the exec. */}
          <TabsContent value="terminal" keepMounted={terminalSeen} className="flex min-h-0 flex-1 flex-col">
            {terminalSeen ? <TerminalPanel active={active && view === "terminal"} client={client} connId={connId} note={note} container={o.name || o.id} running={o.running} defaultUser={o.user} defaultWorkdir={o.workingDir} /> : null}
          </TabsContent>
          <TabsContent value="files" className="flex min-h-0 flex-1 flex-col">
            {view === "files" ? <FilesPanel client={client} connId={connId} note={note} useTabActions={useTabActions} container={o.name || o.id} /> : null}
          </TabsContent>
          <TabsContent value="inspect" className="flex min-h-0 flex-1 flex-col border-t border-border-subtle">
            <div className="flex items-center gap-inline-sm px-inset-lg py-stack-sm text-body-1 text-fg-muted">
              <span className="flex-1">
                <span className={mono}>docker inspect {o.name}</span> · environment values included
              </span>
              <CopyButton value={JSON.stringify(data.inspect, null, 2)} what="inspect JSON" />
            </div>
            <JsonViewer value={data.inspect} aria-label={`docker inspect ${o.name}`} defaultExpandDepth={1} className="min-h-0 flex-1" />
          </TabsContent>
        </Tabs>
      ) : null}
      <AlertDialog open={removing} onOpenChange={(open) => !open && busy === null && setRemoving(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {o?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className={mono}>{o?.name}</span> on {profile.name}. Its logs and writable layer go with it; named volumes stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="flex flex-col gap-stack-sm">
            <label className="flex items-center gap-inline-sm text-body-1 text-fg">
              <Checkbox checked={removeVolumes} onCheckedChange={(c) => setRemoveVolumes(c === true)} /> Remove its anonymous volumes
            </label>
            <label className={cn("flex items-center gap-inline-sm text-body-1", stoppable ? "text-fg" : "text-fg-disabled")}>
              <Checkbox checked={force} disabled={!stoppable} onCheckedChange={(c) => setForce(c === true)} /> Force: stop it first
              <span className="text-fg-muted">· {stoppable ? "it is running" : "it is not running"}</span>
            </label>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction appearance="danger" loading={busy === "remove"} disabled={stoppable && !force} onClick={() => void act("remove")}>
              Remove container
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function Overview({ o, recent }: { o: ContainerOverview; recent: readonly DockerEvent[] }) {
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [labelsOpen, setLabelsOpen] = useState(false);
  const allShown = o.env.length > 0 && o.env.every((e) => shown.has(e.name));
  const labels = Object.entries(o.labels).sort(([a], [b]) => a.localeCompare(b));
  const health = o.health;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-stack-lg overflow-auto px-inset-lg py-inset-md">
        <dl aria-label="Facts" className="m-0 flex flex-wrap gap-x-inline-xl gap-y-stack-sm">
          <Fact term="Created">{when(o.created)}</Fact>
          <Fact term="Started">
            {o.startedAt ? when(o.startedAt) : "never"} · {o.restartCount} {o.restartCount === 1 ? "restart" : "restarts"}
          </Fact>
          <Fact term="Restart policy">{o.restartPolicy}</Fact>
          <Fact term="Health">{health ? `${health.status}${health.intervalSec ? ` · every ${health.intervalSec} s` : ""}` : "no check"}</Fact>
          <Fact term="Limits">{limitsText(o)}</Fact>
          <Fact term="User">{o.user ? <span className={mono}>{o.user}</span> : "image default"}</Fact>
        </dl>
        {o.error || o.oomKilled ? (
          <p className="text-body-1 text-danger-fg">
            {o.oomKilled ? "Killed for running out of memory. " : ""}
            {o.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-inline-xl">
          <DescriptionList aria-label="Process" className="min-w-0 flex-1">
            <Pair term="Command">{o.command.length > 0 ? <span className={cn(mono, "break-words")}>{commandLine(o.command)}</span> : "image default"}</Pair>
            <Pair term="Entrypoint">{o.entrypoint.length > 0 ? <span className={cn(mono, "break-words")}>{commandLine(o.entrypoint)}</span> : "none"}</Pair>
            <Pair term="Working dir">{o.workingDir ? <span className={mono}>{o.workingDir}</span> : "/"}</Pair>
            <Pair term="TTY">{o.tty ? "yes" : "no"}</Pair>
          </DescriptionList>
          <DescriptionList aria-label="Connections" className="min-w-0 flex-1">
            <Pair term="Networks">
              {o.networks.length === 0
                ? "none"
                : o.networks.map((n) => (
                    <span key={n.name} className="flex items-center gap-inline-xs">
                      <span className={mono}>{n.name}</span>
                      {n.ipAddress ? (
                        <>
                          {" · "}
                          {n.ipAddress}
                          <CopyButton value={n.ipAddress} what="IP address" />
                        </>
                      ) : null}
                    </span>
                  ))}
            </Pair>
            <Pair term="Ports">
              {o.ports.length === 0
                ? "none"
                : o.ports.map((p) => (
                    <span key={p.port} className={cn(mono, "block")}>
                      {p.published.length > 0 ? `${p.published.join(", ")} → ${p.port}` : `${p.port} (not published)`}
                    </span>
                  ))}
            </Pair>
            <Pair term="Mounts">
              {o.mounts.length === 0
                ? "none"
                : o.mounts.map((m) => (
                    <span key={m.destination} className="block">
                      <span className={mono}>{m.name ?? m.source}</span> → <span className={mono}>{m.destination}</span>{" "}
                      <span className="text-fg-muted">
                        {m.kind}, {m.readWrite ? "rw" : "ro"}
                      </span>
                    </span>
                  ))}
            </Pair>
          </DescriptionList>
        </div>
        <section aria-label="Environment" className="flex flex-col gap-stack-sm">
          <h3 className="flex items-center gap-inline-sm text-body-1-strong text-fg">
            Environment
            <span className="text-body-1 text-fg-muted">
              {o.env.length} {o.env.length === 1 ? "variable" : "variables"} · values hidden until shown
            </span>
            <span className="flex-1" />
            {o.env.length > 0 ? (
              <Button appearance="subtle" size="small" onClick={() => setShown(allShown ? new Set() : new Set(o.env.map((e) => e.name)))}>
                <Icon icon={allShown ? EyeOff : Eye} /> {allShown ? "Hide all" : "Show all"}
              </Button>
            ) : null}
          </h3>
          {o.env.length === 0 ? (
            <EmptyLine>No environment variables.</EmptyLine>
          ) : (
            <Table aria-label="Environment variables" size="small">
              <TableBody>
                {o.env.map((e) => {
                  const visible = shown.has(e.name);
                  return (
                    <TableRow key={e.name}>
                      <TableCell className={cn(mono, "w-panel-xs")}>{e.name}</TableCell>
                      <TableCell className={cn(mono, "break-all", visible ? "text-fg" : "text-fg-muted")} wrap>
                        {visible ? e.value || <span className="text-fg-muted">(empty)</span> : "••••••••••••"}
                      </TableCell>
                      <TableCell align="end" className="w-control-lg">
                        <span className="flex items-center justify-end gap-inline-xs">
                          <IconButton
                            size="small"
                            appearance="subtle"
                            aria-label={visible ? `Hide ${e.name}` : `Show ${e.name}`}
                            aria-pressed={visible}
                            onClick={() =>
                              setShown((s) => {
                                const next = new Set(s);
                                if (visible) next.delete(e.name);
                                else next.add(e.name);
                                return next;
                              })
                            }
                          >
                            <Icon icon={visible ? EyeOff : Eye} />
                          </IconButton>
                          <CopyButton value={e.value} what={`the value of ${e.name}`} />
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </section>
        <section aria-label="Labels" className="flex flex-col gap-stack-sm">
          <button type="button" className="flex items-center gap-inline-sm text-start text-body-1-strong text-fg" aria-expanded={labelsOpen} onClick={() => setLabelsOpen((v) => !v)}>
            <Icon icon={labelsOpen ? ChevronDown : ChevronRight} /> Labels <span className="text-body-1 text-fg-muted">{labels.length}</span>
          </button>
          {labelsOpen ? (
            <Table aria-label="Labels" size="small">
              <TableBody>
                {labels.map(([k, v]) => (
                  <TableRow key={k}>
                    <TableCell className={cn(mono, "w-panel-sm")} wrap>
                      {k}
                    </TableCell>
                    <TableCell className={cn(mono, "break-all")} wrap>
                      {v}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </section>
      </div>
      <aside aria-label="Health and events" className="flex w-panel-sm shrink-0 flex-col gap-stack-md overflow-auto border-s border-border-subtle px-inset-md py-inset-md">
        <section className="flex flex-col gap-stack-sm">
          <h3 className="text-body-1-strong text-fg">Health check</h3>
          {health ? (
            <>
              <p className={cn(mono, "break-all text-fg-muted")}>{health.test.filter((t) => t !== "CMD" && t !== "CMD-SHELL").join(" ") || "(the image's)"}</p>
              {health.log.length === 0 ? (
                <p className="text-body-1 text-fg-muted">No result yet.</p>
              ) : (
                <ol className="flex flex-col gap-stack-xs">
                  {[...health.log].reverse().map((r) => (
                    <li key={r.start} className="flex items-start gap-inline-sm text-body-1">
                      <Icon icon={r.exitCode === 0 ? CheckmarkCircle : ErrorCircle} className={r.exitCode === 0 ? "text-success-fg" : "text-danger-fg"} />
                      <span className={mono}>{clock(Date.parse(r.start))}</span>
                      <span className="min-w-0 truncate text-fg-muted" title={r.output}>
                        exit {r.exitCode}
                        {r.output.trim() ? ` · ${r.output.trim()}` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          ) : (
            <p className="text-body-1 text-fg-muted">The container has no health check.</p>
          )}
        </section>
        <section className="flex flex-col gap-stack-sm">
          <h3 className="text-body-1-strong text-fg">Recent events</h3>
          <p className="text-caption-1 text-fg-muted">
            from <span className={mono}>docker.events</span> since this tab opened
          </p>
          {recent.length === 0 ? (
            <p className="text-body-1 text-fg-muted">None yet.</p>
          ) : (
            <ol className="flex flex-col gap-stack-xs">
              {recent.map((e) => (
                <li key={`${e.timeMs}-${e.action}`} className="flex items-baseline gap-inline-sm text-body-1">
                  <span className={mono}>{clock(e.timeMs)}</span>
                  <span className="min-w-0 truncate">{e.action}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </aside>
    </div>
  );
}
