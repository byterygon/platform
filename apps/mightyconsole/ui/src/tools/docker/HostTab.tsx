// `docker.host {}` (Mightyconsole spec §10.4 "Host", TSK-81 mockup frame docker-host): the
// engine's `/info` and `/version` with the connection's SSH facts. The title is the host's name;
// the subtitle says who is logged in where, with which trusted key, on which socket, and the
// round trip; the facts row counts containers and images; two lists give the system and the
// engine. Batch 4 (DOC-21 Open question 45 q): disk usage per kind from `docker.host.df`, with what
// a prune could free (prune stays "Later"), and beside it the host's events from `docker.events`,
// newest first, kept while the tab is open. Container events that change the counts load the facts
// again; the disk usage only on Refresh, because Docker sizes every volume for it.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton, Page, PageHeader, PageRegion } from "@/app/page";
import { DisconnectedState, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import { keyTypeLabel } from "@/app/dialogs/HostKeyDialog";
import type { DiskUsage, DiskUsageKind, HostInfo } from "@/gen/api";
import { ArrowClockwise } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { type DockerEvent, changesRows, eventText, formatBytes } from "./format";
import { useDockerEvents } from "./live";
import { RELOAD_DEBOUNCE_MS } from "./resources";
import { clockText } from "./StatsPanel";

/** Events the page keeps, newest first. */
export const HOST_EVENTS_KEPT = 200;

/** The rows of the disk usage table, as `docker system df` orders them. */
export const DISK_KINDS = [
  ["images", "Images", "in use"],
  ["containers", "Containers", "running"],
  ["volumes", "Volumes", "in use"],
  ["buildCache", "Build cache", "in use"],
] as const satisfies readonly (readonly [keyof DiskUsage, string, string])[];

/** `1.2 GB (38 %)`; a size of 0 has no share. */
export function reclaimableText(kind: DiskUsageKind): string {
  if (kind.size === 0) return formatBytes(kind.reclaimable);
  return `${formatBytes(kind.reclaimable)} (${Math.round((kind.reclaimable / kind.size) * 100)} %)`;
}

/** "31.3 GiB" (binary units, as `docker info` prints memory). */
export function formatMemory(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** "11 · 7 running · 3 stopped" (paused only when there are some). */
export function containerCounts(host: HostInfo): string {
  const parts = [formatCount(host.containers), `${formatCount(host.containersRunning)} running`];
  if (host.containersPaused > 0) parts.push(`${formatCount(host.containersPaused)} paused`);
  parts.push(`${formatCount(host.containersStopped)} stopped`);
  return parts.join(" · ");
}

/** The subtitle: `deploy@build-host.lan:22 · ED25519 key · socket /var/run/docker.sock · 3 ms`. */
export function hostSubtitle(host: HostInfo): string {
  const how = host.ssh.auth === "password" ? "password" : host.ssh.auth === "agent" ? "ssh-agent" : "private key";
  return `${host.ssh.target} · ${how} · ${keyTypeLabel(host.ssh.hostKey.algorithm)} host key trusted · socket ${host.ssh.socketPath} · ping ${host.pingMs} ms`;
}

/** A fact of the header row, as the Workflow tab's. */
function HeaderFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-stack-xs">
      <dt className="text-caption-1 text-fg-muted">{label}</dt>
      <dd className="m-0 text-body-1 text-fg">{children}</dd>
    </div>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails>{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

/** The disk usage table: a row per kind with its items, size (a bar against the largest) and reclaimable. */
function DiskUsageTable({ usage }: { usage: DiskUsage }) {
  const largest = Math.max(1, ...DISK_KINDS.map(([key]) => usage[key].size));
  return (
    <Table aria-label="Disk usage" size="small">
      <TableHeader>
        <TableRow>
          <TableHead>Kind</TableHead>
          <TableHead>Items</TableHead>
          <TableHead align="end">Size</TableHead>
          <TableHead>
            <span className="sr-only">Share of the largest</span>
          </TableHead>
          <TableHead align="end">Reclaimable</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {DISK_KINDS.map(([key, label, active]) => {
          const kind = usage[key];
          return (
            <TableRow key={key}>
              <TableCell>{label}</TableCell>
              <TableCell className="whitespace-nowrap text-fg-muted tabular-nums">
                {formatCount(kind.count)} · {formatCount(kind.active)} {active}
              </TableCell>
              <TableCell align="end" className="whitespace-nowrap tabular-nums">
                {formatBytes(kind.size)}
              </TableCell>
              <TableCell className="w-full">
                {/* Decorative: the size is in the cell before. */}
                <span aria-hidden="true" className="block h-track overflow-hidden rounded-full bg-inset">
                  <span className="block h-full rounded-full bg-accent-compound" style={{ width: `${(kind.size / largest) * 100}%` }} />
                </span>
              </TableCell>
              <TableCell align="end" className="whitespace-nowrap text-fg-muted tabular-nums">
                {reclaimableText(kind)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function HostTab({ profile, connId, client, useTabActions, note }: TabProps) {
  const [host, setHost] = useState<HostInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<DescribedError | null>(null);
  const [events, setEvents] = useState<DockerEvent[]>([]);
  const generation = useRef(0);
  const usageGeneration = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadInfo = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const info = await client.docker.host.info({ connId });
      if (mine === generation.current) setHost(info);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, note]);

  const loadUsage = useCallback(async () => {
    if (connId === null) return;
    const mine = ++usageGeneration.current;
    setUsageLoading(true);
    setUsageError(null);
    try {
      const df = await client.docker.host.df({ connId });
      if (mine === usageGeneration.current) setUsage(df);
    } catch (e) {
      if (mine === usageGeneration.current) setUsageError(note(e));
    } finally {
      if (mine === usageGeneration.current) setUsageLoading(false);
    }
  }, [client, connId, note]);

  const load = useCallback(() => {
    void loadInfo();
    void loadUsage();
  }, [loadInfo, loadUsage]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useTabActions({ refresh: load });

  const live = useDockerEvents({
    client,
    connId,
    onEvent: (event) => {
      setEvents((list) => [event, ...list].slice(0, HOST_EVENTS_KEPT));
      if (!changesRows(event)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void loadInfo(), RELOAD_DEBOUNCE_MS);
    },
  });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const cgroups = host ? [host.cgroupVersion ? `v${host.cgroupVersion}` : "", host.cgroupDriver ?? ""].filter(Boolean).join(", ") : "";
  return (
    <Page>
      <PageHeader
        title={host?.name || profile.name}
        adornment={
          host ? (
            <>
              <CopyButton value={host.name} what="host name" />
              <Badge appearance="tint" variant="success">
                Connected
              </Badge>
            </>
          ) : null
        }
        subtitle={host ? hostSubtitle(host) : profile.name}
        actions={
          <Button appearance="subtle" onClick={load} loading={(loading && host !== null) || (usageLoading && usage !== null)}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      >
        {host ? (
          <dl aria-label="Counts" className="m-0 flex flex-wrap gap-x-inline-xl gap-y-stack-sm">
            <HeaderFact label="Containers">{containerCounts(host)}</HeaderFact>
            <HeaderFact label="Images">{formatCount(host.images)}</HeaderFact>
            <HeaderFact label="CPUs">{formatCount(host.cpus)}</HeaderFact>
            <HeaderFact label="Memory">{formatMemory(host.memoryBytes)}</HeaderFact>
          </dl>
        ) : null}
      </PageHeader>
      <PageRegion className="flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          {error ? <ErrorState error={error} onRetry={() => void loadInfo()} /> : null}
          {loading && host === null ? <LoadingRows label="Loading the host" /> : null}
          {host ? (
            <div className="flex flex-col gap-stack-lg px-inset-lg py-inset-md">
              {host.warnings.length > 0 ? (
                <Alert intent="warning">
                  <AlertTitle>The engine reports {host.warnings.length === 1 ? "a warning" : `${host.warnings.length} warnings`}</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc ps-inset-md">
                      {host.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              ) : null}
              <div className="flex flex-wrap gap-x-inline-xl gap-y-stack-lg">
                <DescriptionList aria-label="System" className="min-w-panel-sm flex-1">
                  <Fact term="Name">{host.name}</Fact>
                  <Fact term="OS">{host.operatingSystem}</Fact>
                  <Fact term="Kernel">
                    <Code>{host.kernelVersion}</Code>
                  </Fact>
                  <Fact term="Architecture">{host.architecture}</Fact>
                  {cgroups ? <Fact term="Cgroups">{cgroups}</Fact> : null}
                  {host.securityOptions.length > 0 ? <Fact term="Security">{host.securityOptions.join(", ")}</Fact> : null}
                </DescriptionList>
                <DescriptionList aria-label="Engine" className="min-w-panel-sm flex-1">
                  <Fact term="Docker">{[host.serverVersion, host.containerdVersion ? `containerd ${host.containerdVersion}` : ""].filter(Boolean).join(" · ")}</Fact>
                  <Fact term="API">
                    {host.apiVersion}
                    {host.serverApiVersion !== host.apiVersion ? ` (the host speaks up to ${host.serverApiVersion})` : " (negotiated, minimum 1.41)"}
                  </Fact>
                  <Fact term="Storage driver">{host.storageBackingFilesystem ? `${host.storageDriver} on ${host.storageBackingFilesystem}` : host.storageDriver}</Fact>
                  <Fact term="Logging driver">{host.loggingDriver}</Fact>
                  <Fact term="Root dir">
                    <Code>{host.dockerRootDir}</Code>
                  </Fact>
                  <Fact term="Rootless">{host.rootless ? "yes" : "no"}</Fact>
                </DescriptionList>
              </div>
              <DescriptionList aria-label="Connection">
                <Fact term="Host key">
                  <span className="flex min-w-0 items-center gap-inline-xs">
                    <Code className="break-all">
                      {keyTypeLabel(host.ssh.hostKey.algorithm)} · {host.ssh.hostKey.fingerprintSha256}
                    </Code>
                    <CopyButton value={host.ssh.hostKey.fingerprintSha256} what="fingerprint" />
                  </span>
                </Fact>
              </DescriptionList>
            </div>
          ) : null}
          <section aria-label="Disk usage" className="flex max-w-panel-xl flex-col gap-stack-sm px-inset-lg pb-inset-lg">
            <h3 className="text-body-1-strong text-fg">
              Disk usage <span className="text-caption-1 text-fg-muted">from /system/df · reclaimable is what a prune could free</span>
            </h3>
            {usageError ? <ErrorState error={usageError} onRetry={() => void loadUsage()} /> : null}
            {usageLoading && usage === null ? <LoadingRows label="Reading the disk usage (Docker sizes every volume)" /> : null}
            {usage ? <DiskUsageTable usage={usage} /> : null}
          </section>
        </div>
        <aside aria-label="Events" className="flex w-panel-sm max-w-1/2 min-w-0 shrink-0 flex-col gap-stack-sm overflow-auto border-s border-border-subtle py-inset-md">
          <div className="flex flex-col gap-stack-xs px-inset-md">
            <h3 className="flex items-center gap-inline-sm text-body-1-strong text-fg">
              Events
              {live.live ? (
                <Badge appearance="tint" variant="success">
                  Live
                </Badge>
              ) : null}
            </h3>
            <p className="text-caption-1 text-fg-muted">
              from <span className="font-mono">docker.events</span>, newest first, since this tab opened
              {live.error ? ` · ${live.error}; trying again` : ""}
            </p>
          </div>
          {events.length === 0 ? (
            <p className="px-inset-md text-body-1 text-fg-muted">None yet.</p>
          ) : (
            <ol aria-label="Events" className="flex flex-col">
              {events.map((e, i) => {
                const { action, detail } = eventText(e);
                return (
                  <li key={`${e.timeMs}-${e.kind}-${e.action}-${e.id}-${i}`} className="flex items-baseline gap-inline-md border-b border-border-subtle px-inset-md py-stack-xs text-body-1">
                    <span className="shrink-0 font-mono text-code text-fg-muted">{clockText(e.timeMs)}</span>
                    <span className="flex min-w-0 flex-col">
                      <span>
                        {e.kind} <span className="text-body-1-strong">{action}</span>
                      </span>
                      <span className="truncate text-fg-muted" title={detail}>
                        {detail}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </aside>
      </PageRegion>
    </Page>
  );
}
