// `docker.host {}` (Mightyconsole spec §10.4 "Host", TSK-81 mockup frame docker-host): the
// engine's `/info` and `/version` with the connection's SSH facts. The title is the host's name;
// the subtitle says who is logged in where, with which trusted key, on which socket, and the
// round trip; the facts row counts containers and images; two lists give the system and the
// engine. Disk usage and the host's live events join it in TSK-81's last batch.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { CopyButton, Page, PageHeader, PageRegion } from "@/app/page";
import { DisconnectedState, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import { keyTypeLabel } from "@/app/dialogs/HostKeyDialog";
import type { HostInfo } from "@/gen/api";
import { ArrowClockwise } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";

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

export function HostTab({ profile, connId, client, useTabActions, note }: TabProps) {
  const [host, setHost] = useState<HostInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
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

  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({ refresh: () => void load() });

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
          <Button appearance="subtle" onClick={() => void load()} loading={loading && host !== null}>
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
      <PageRegion className="overflow-auto">
        {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
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
            <div className="flex flex-wrap gap-inline-xl">
              <DescriptionList aria-label="System" className="min-w-0 flex-1">
                <Fact term="Name">{host.name}</Fact>
                <Fact term="OS">{host.operatingSystem}</Fact>
                <Fact term="Kernel">
                  <Code>{host.kernelVersion}</Code>
                </Fact>
                <Fact term="Architecture">{host.architecture}</Fact>
                {cgroups ? <Fact term="Cgroups">{cgroups}</Fact> : null}
                {host.securityOptions.length > 0 ? <Fact term="Security">{host.securityOptions.join(", ")}</Fact> : null}
              </DescriptionList>
              <DescriptionList aria-label="Engine" className="min-w-0 flex-1">
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
      </PageRegion>
    </Page>
  );
}
