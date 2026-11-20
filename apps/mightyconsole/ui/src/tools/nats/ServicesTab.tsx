// `nats.services {}` (§6.3 "Services"): the services that answer the NATS service API within 2 s:
// `$SRV.INFO` (name, id, version, description, endpoints with their subjects and queue groups),
// `$SRV.PING` (latency) and `$SRV.STATS` (requests, errors, processing time and the last error per
// endpoint), asked together. The selected instance shows its endpoints with their counters.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DescriptionList } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCount } from "@/app/messages";
import { CopyButton, Page, PageHeader, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { ArrowClockwise } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { Fact } from "./parts";

/** How long the screen waits for answers (§6.3). */
export const DISCOVER_MS = 2000;

/** A handler time in nanoseconds: "850 µs", "12.4 ms", "1.2 s". */
export function formatNanos(ns: number): string {
  if (ns < 1000) return `${ns} ns`;
  if (ns < 1_000_000) return `${+(ns / 1000).toFixed(ns < 10_000 ? 1 : 0)} µs`;
  if (ns < 1_000_000_000) return `${+(ns / 1_000_000).toFixed(ns < 10_000_000 ? 2 : 1)} ms`;
  return `${+(ns / 1_000_000_000).toFixed(2)} s`;
}

const key = (s: { name: string; id: string }) => `${s.name}/${s.id}`;

interface Found {
  services: api.NatsServiceInfo[];
  stats: Map<string, api.NatsServiceStats>;
  pings: Map<string, api.NatsServicePing>;
  /** Why STATS or PING could not be asked, when INFO answered. */
  partial: string | null;
}

function EndpointsPane({ service, stats, ping }: { service: api.NatsServiceInfo; stats: api.NatsServiceStats | undefined; ping: api.NatsServicePing | undefined }) {
  const counters = new Map((stats?.endpoints ?? []).map((e) => [`${e.name}:${e.subject}`, e]));
  const metadata = Object.entries(service.metadata);
  return (
    <section aria-label={`Service ${service.name} ${service.id}`} className="flex flex-col gap-stack-sm border-t border-border-subtle px-inset-lg py-inset-md">
      <div className="flex items-center gap-inline-sm">
        <h3 className="text-body-1-strong text-fg">
          {service.name} <span className="font-mono text-fg-muted">{service.id}</span>
        </h3>
        <CopyButton value={service.id} what="service id" />
      </div>
      <DescriptionList aria-label="Instance">
        <Fact term="Version">{service.version}</Fact>
        {service.description ? <Fact term="Description">{service.description}</Fact> : null}
        <Fact term="PING">{ping ? `${ping.rttMs.toFixed(1)} ms` : "no answer"}</Fact>
        {stats?.started ? <Fact term="Started">{new Date(stats.started).toLocaleString("en-GB")}</Fact> : null}
        {metadata.length > 0 ? <Fact term="Metadata">{metadata.map(([k, v]) => `${k}=${v}`).join(", ")}</Fact> : null}
      </DescriptionList>
      <Table aria-label="Endpoints" size="small">
        <TableHeader>
          <TableRow>
            <TableHead>Endpoint</TableHead>
            <TableHead>Subject</TableHead>
            <TableHead>Queue group</TableHead>
            <TableHead align="end">Requests</TableHead>
            <TableHead align="end">Errors</TableHead>
            <TableHead align="end">Average</TableHead>
            <TableHead align="end">Total time</TableHead>
            <TableHead>Last error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {service.endpoints.map((e) => {
            const c = counters.get(`${e.name}:${e.subject}`);
            return (
              <TableRow key={`${e.name}:${e.subject}`}>
                <TableCell>{e.name}</TableCell>
                <TableCell className="font-mono">{e.subject}</TableCell>
                <TableCell className="font-mono text-fg-muted">{e.queueGroup ?? ""}</TableCell>
                <TableCell align="end" className="tabular-nums">
                  {c ? formatCount(c.requests) : ""}
                </TableCell>
                <TableCell align="end" className="tabular-nums">
                  {c ? (
                    c.errors > 0 ? (
                      <Badge appearance="tint" variant="danger">
                        {formatCount(c.errors)}
                      </Badge>
                    ) : (
                      "0"
                    )
                  ) : (
                    ""
                  )}
                </TableCell>
                <TableCell align="end" className="tabular-nums">
                  {c ? formatNanos(c.averageProcessingTimeNs) : ""}
                </TableCell>
                <TableCell align="end" className="tabular-nums">
                  {c ? formatNanos(c.processingTimeNs) : ""}
                </TableCell>
                <TableCell className="max-w-panel-xs truncate text-danger-fg">{c?.lastError ?? ""}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {!stats ? <p className="text-caption-1 text-fg-muted">This instance did not answer STATS.</p> : null}
    </section>
  );
}

export function ServicesTab({ profile, connId, client, useTabActions, note }: TabProps) {
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    const input = { connId, timeoutMs: DISCOVER_MS };
    const [info, stats, ping] = await Promise.allSettled([client.nats.services.discover(input), client.nats.services.stats(input), client.nats.services.ping(input)]);
    if (mine !== generation.current) return;
    setLoading(false);
    if (info.status === "rejected") {
      setError(note(info.reason));
      return;
    }
    const failed = [stats, ping].find((r) => r.status === "rejected");
    const next: Found = {
      services: info.value,
      stats: new Map(stats.status === "fulfilled" ? stats.value.map((s) => [key(s), s]) : []),
      pings: new Map(ping.status === "fulfilled" ? ping.value.map((p) => [key(p), p]) : []),
      partial: failed && failed.status === "rejected" ? note(failed.reason).title : null,
    };
    setFound(next);
    setSelected((s) => (s !== null && next.services.some((x) => key(x) === s) ? s : next.services[0] ? key(next.services[0]) : null));
  }, [client, connId, note]);
  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({ refresh: () => void load() });
  const current = useMemo(() => found?.services.find((s) => key(s) === selected) ?? null, [found, selected]);
  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const count = found?.services.length ?? 0;
  const names = new Set(found?.services.map((s) => s.name) ?? []);
  return (
    <Page>
      <PageHeader
        title="Services"
        subtitle={[profile.name, found ? `${names.size} ${names.size === 1 ? "service" : "services"}, ${count} ${count === 1 ? "instance" : "instances"} answered within 2 s` : null].filter(Boolean).join(" · ")}
        actions={
          <Button appearance="subtle" onClick={() => void load()} loading={loading}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      {error ? (
        <div className="px-inset-lg py-inset-md">
          <ErrorState error={error} onRetry={() => void load()} />
        </div>
      ) : null}
      {found === null && loading ? <LoadingRows label="Asking $SRV.INFO, PING and STATS" /> : null}
      {found?.partial ? <p className="px-inset-lg py-inset-xs text-body-1 text-warning-fg">Some counters are missing: {found.partial}</p> : null}
      {found !== null && count === 0 && !error ? <EmptyLine action={<Button onClick={() => void load()}>Ask again</Button>}>No services answered within 2 s.</EmptyLine> : null}
      {found !== null && count > 0 ? (
        <div className="mt-stack-md flex min-h-0 flex-1 flex-col overflow-auto">
          <Table aria-label="Services" size="small" className={gutterTable}>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Description</TableHead>
                <TableHead align="end">Endpoints</TableHead>
                <TableHead align="end">PING</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {found.services.map((s) => {
                const ping = found.pings.get(key(s));
                return (
                  <TableRow key={key(s)} selected={key(s) === selected}>
                    <TableCell>
                      <button type="button" onClick={() => setSelected(key(s))} className="cursor-pointer rounded-sm text-start text-fg-link hover:underline">
                        {s.name}
                      </button>
                    </TableCell>
                    <TableCell className="font-mono text-fg-muted">{s.id}</TableCell>
                    <TableCell>{s.version}</TableCell>
                    <TableCell className="max-w-panel-sm truncate text-fg-muted">{s.description ?? ""}</TableCell>
                    <TableCell align="end" className="tabular-nums">
                      {s.endpoints.length}
                    </TableCell>
                    <TableCell align="end" className="tabular-nums">
                      {ping ? `${ping.rttMs.toFixed(1)} ms` : "no answer"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {current ? <EndpointsPane service={current} stats={found.stats.get(key(current))} ping={found.pings.get(key(current))} /> : null}
        </div>
      ) : null}
    </Page>
  );
}
