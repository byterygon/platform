// `nats.server {}` (Mightyconsole spec §6.3 "Server", mockup frame nats-server): ServerInfo (id
// with a copy button, version, cluster, max payload, connect URLs, TLS, round trip), this
// client's connection, and the JetStream account's usage against its limits as bars. With
// JetStream off, the screen says so; the JetStream groups of the tree say it too.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { Progress } from "@/components/ui/progress";
import { CopyButton, Page, PageHeader, PageRegion } from "@/app/page";
import { DisconnectedState, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { NatsServerInfoOutput } from "@/gen/api";
import { ArrowClockwise } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";

/** "1 MiB", "980 B", "1.9 GiB". */
export function formatSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${n} B` : `${+n.toFixed(n >= 100 ? 0 : 1)} ${units[unit]}`;
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails>{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

/** One usage bar: "Storage 1.9 GiB / 10 GiB"; unlimited shows the use alone. */
function Usage({ label, used, limit, format }: { label: string; used: number; limit: number | undefined; format: (n: number) => string }) {
  const limited = limit !== undefined && limit > 0;
  const pct = limited ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="flex flex-col gap-stack-xs">
      <div className="flex items-baseline justify-between gap-inline-md text-body-1">
        <span className="text-fg">{label}</span>
        <span className="tabular-nums text-fg-muted">{limited ? `${format(used)} / ${format(limit)}` : `${format(used)} · no limit`}</span>
      </div>
      <Progress aria-label={label} value={limited ? pct : 0} variant={pct >= 90 ? "danger" : pct >= 75 ? "warning" : "accent"} />
    </div>
  );
}

export function ServerTab({ profile, connId, client, useTabActions, note }: TabProps) {
  const [info, setInfo] = useState<NatsServerInfoOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const out = await client.nats.server.info({ connId });
      if (mine === generation.current) setInfo(out);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, note]);
  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({ refresh: () => void load() });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const s = info?.server;
  const js = info?.jetstream ?? null;
  const subtitle = s
    ? [profile.name, `NATS ${s.version}`, s.cluster ? `cluster ${s.cluster}` : null, info.connection.tls ? "TLS" : "no TLS", `RTT ${info.rttMs.toFixed(1)} ms`].filter(Boolean).join(" · ")
    : profile.name;
  return (
    <Page>
      <PageHeader
        title={s ? s.serverName || s.serverId : "Server"}
        adornment={
          s ? (
            <>
              <CopyButton value={s.serverId} what="server ID" />
              <Badge appearance="tint" variant={js ? "success" : "neutral"}>
                {js ? "JetStream on" : "JetStream off"}
              </Badge>
            </>
          ) : null
        }
        subtitle={subtitle}
        actions={
          <Button appearance="subtle" onClick={() => void load()} loading={loading}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      <PageRegion className="gap-stack-lg overflow-auto px-inset-lg py-inset-md">
        {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
        {!s && loading ? <LoadingRows label="Loading the server" /> : null}
        {s && info ? (
          <div className="flex flex-wrap gap-inline-xl">
            <section aria-label="Server" className="flex min-w-panel-sm flex-1 flex-col gap-stack-sm">
              <h3 className="text-subtitle-2 text-fg">Server</h3>
              <DescriptionList>
                <Fact term="Server ID">
                  <span className="break-all font-mono">{s.serverId}</span>
                </Fact>
                <Fact term="Version">
                  {s.version}
                  {s.go ? ` · ${s.go}` : ""}
                </Fact>
                <Fact term="Cluster">{s.cluster ?? "none"}</Fact>
                {s.domain ? <Fact term="Domain">{s.domain}</Fact> : null}
                <Fact term="Max payload">{formatSize(s.maxPayload)}</Fact>
                <Fact term="Headers">{s.headers ? "supported" : "not supported"}</Fact>
                <Fact term="Connect URLs">
                  <span className="font-mono">{s.connectUrls.length > 0 ? s.connectUrls.join(", ") : "none"}</span>
                </Fact>
                <Fact term="TLS">{info.connection.tls ? "on" : s.tlsRequired ? "required by the server" : "off"}</Fact>
                <Fact term="Round trip">{`${info.rttMs.toFixed(1)} ms`}</Fact>
                {s.lameDuckMode ? <Fact term="Lame duck">the server will close soon</Fact> : null}
              </DescriptionList>
            </section>
            <section aria-label="This connection" className="flex min-w-panel-sm flex-1 flex-col gap-stack-sm">
              <h3 className="text-subtitle-2 text-fg">This connection</h3>
              <DescriptionList>
                <Fact term="Name">
                  <span className="font-mono">{info.connection.name}</span> · id {s.clientId}
                </Fact>
                <Fact term="Servers">
                  <span className="font-mono">{info.connection.servers.join(", ")}</span>
                </Fact>
                <Fact term="Authentication">{info.connection.auth}</Fact>
                <Fact term="State">{info.connection.state}</Fact>
                <Fact term="Messages">
                  {formatCount(info.connection.inMessages)} in · {formatCount(info.connection.outMessages)} out
                </Fact>
                <Fact term="Bytes">
                  {formatSize(info.connection.inBytes)} in · {formatSize(info.connection.outBytes)} out
                </Fact>
                <Fact term="Connects">{formatCount(info.connection.connects)}</Fact>
              </DescriptionList>
            </section>
            <section aria-label="JetStream account" className="flex min-w-panel-sm basis-full flex-col gap-stack-sm">
              <h3 className="text-subtitle-2 text-fg">JetStream account</h3>
              {js ? (
                <>
                  <Usage label="Storage" used={js.storage} limit={js.limits.maxStorage} format={formatSize} />
                  <Usage label="Memory" used={js.memory} limit={js.limits.maxMemory} format={formatSize} />
                  <Usage label="Streams" used={js.streams} limit={js.limits.maxStreams} format={formatCount} />
                  <Usage label="Consumers" used={js.consumers} limit={js.limits.maxConsumers} format={formatCount} />
                  <p className="text-caption-1 text-fg-muted">
                    API: {formatCount(js.apiTotal)} calls · {formatCount(js.apiErrors)} errors · domain {js.domain ?? "none"}
                  </p>
                </>
              ) : (
                <p className="text-body-1 text-fg-muted">{info.jetstreamError ?? "JetStream is not enabled on this server."}</p>
              )}
            </section>
          </div>
        ) : null}
      </PageRegion>
    </Page>
  );
}
