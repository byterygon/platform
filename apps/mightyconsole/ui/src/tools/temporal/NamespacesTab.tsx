// `temporal.namespaces {}` (Mightyconsole spec §9.3 "Namespaces", TSK-92): every namespace of the
// cluster in a table; the selected one in a side pane with its settings (`DescribeNamespace`) and
// its search attributes, which are what the query bar suggests in it. Buttons open that
// namespace's Workflows, Workers and Schedules. Read only: registering and changing namespaces is
// cluster administration (spec §9.4).
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton, Page, PageHeader, PageRegion, gutterTable, LinkButton } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import { cn } from "@/lib/cn";
import type { NamespaceDetail, NamespaceSummary, SearchAttributesOutput } from "@/gen/api";
import { ArrowClockwise, CalendarClock, Flash, Server } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { namespaceOf } from "./profile";

/** "30 days", "36 hours", "" when unknown. */
export function formatRetention(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return "";
  const days = seconds / 86_400;
  if (Number.isInteger(days)) return `${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.round(seconds / 3_600);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** "2 MiB", "512 KiB", "980 B". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

const STATE_VARIANT: Record<string, "success" | "warning" | "danger" | "neutral"> = { Registered: "success", Deprecated: "warning", Deleted: "danger" };

export function NamespacesTab({ profile, connId, client, useTabActions, note, openTab }: TabProps) {
  const [rows, setRows] = useState<NamespaceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [selected, setSelected] = useState(namespaceOf(profile));
  // The server version for the subtitle ("server 1.28.1"); nothing when the call fails.
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    if (connId === null) return undefined;
    let live = true;
    client.temporal.info({ connId }).then(
      (info) => live && setServer(info.serverVersion || null),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, connId]);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const list = await client.temporal.namespaces.list({ connId });
      if (mine === generation.current) setRows(list);
    } catch (e) {
      if (mine === generation.current) {
        setRows([]);
        setError(note(e));
      }
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, note]);

  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({ refresh: () => void load() });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  return (
    <Page>
      <PageHeader
        title="Namespaces"
        subtitle={`${profile.name} · ${formatCount(rows.length)} ${rows.length === 1 ? "namespace" : "namespaces"}${server ? ` · server ${server}` : ""}`}
        actions={
          <Button appearance="subtle" onClick={() => void load()} loading={loading && rows.length > 0}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      <PageRegion>
        {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
        {loading && rows.length === 0 ? (
          <LoadingRows label="Loading namespaces" />
        ) : rows.length === 0 && !error ? (
          <EmptyLine>The cluster lists no namespaces.</EmptyLine>
        ) : rows.length > 0 ? (
          <Resizable orientation="horizontal" className="min-h-0 flex-1" aria-label="Namespaces and the selected one">
            <ResizablePanel defaultSize={52.7} minSize={30} className="flex min-h-0 flex-col">
              <Table aria-label="Namespaces" className={cn("min-h-0 flex-1", gutterTable)}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Retention</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Global</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((n) => (
                    <TableRow key={n.name} selected={n.name === selected} className="group">
                      <TableCell>
                        <span className="flex items-center gap-inline-xs">
                          <LinkButton aria-pressed={n.name === selected} onClick={() => setSelected(n.name)}>
                            {n.name}
                          </LinkButton>
                          {n.isDefault ? <Badge appearance="tint" variant="neutral">profile</Badge> : null}
                          <CopyButton value={n.name} what="namespace" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge appearance="tint" variant={STATE_VARIANT[n.state] ?? "neutral"}>{n.state}</Badge>
                      </TableCell>
                      <TableCell>{formatRetention(n.retentionSecs)}</TableCell>
                      <TableCell>{n.description ? n.description : <span className="text-fg-muted">—</span>}</TableCell>
                      <TableCell>{n.isGlobal ? "Yes" : "No"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={47.3} minSize={25} className="flex min-h-0 flex-col">
              <NamespacePane key={selected} namespace={selected} connId={connId} client={client} note={note} openTab={openTab} />
            </ResizablePanel>
          </Resizable>
        ) : null}
      </PageRegion>
    </Page>
  );
}

function NamespacePane({ namespace, connId, client, note, openTab }: { namespace: string; connId: string; client: TabProps["client"]; note: TabProps["note"]; openTab: TabProps["openTab"] }) {
  const [detail, setDetail] = useState<NamespaceDetail | null>(null);
  const [attributes, setAttributes] = useState<SearchAttributesOutput | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [d, a] = await Promise.all([client.temporal.namespaces.describe({ connId, namespace }), client.temporal.namespaces.searchAttributes({ connId, namespace }).catch(() => null)]);
      setDetail(d);
      setAttributes(a);
    } catch (e) {
      setError(note(e));
    }
  }, [client, connId, namespace, note]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (kind: string, title: string, params: Record<string, unknown> = {}) => openTab({ kind, params: { namespace, ...params }, title: `${title} · ${namespace}` });

  return (
    <aside aria-label={`Namespace ${namespace}`} className="flex min-h-0 flex-1 flex-col gap-stack-md overflow-auto px-inset-lg py-inset-md">
      <div className="flex flex-col gap-stack-xs">
        <h3 className="flex items-center gap-inline-md text-body-1-strong text-fg">
          {namespace}
          <CopyButton value={namespace} what="namespace" />
        </h3>
        {detail ? (
          <p className="flex items-center gap-inline-xs text-body-1 text-fg-muted">
            ID{" "}
            <span className="font-mono text-code" title={detail.id}>
              {shortId(detail.id)}
            </span>
            <CopyButton value={detail.id} what="namespace ID" />
          </p>
        ) : null}
      </div>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {!detail && !error ? <LoadingRows label={`Loading ${namespace}`} /> : null}
      {detail ? (
        <DescriptionList layout="aligned" aria-label="Settings">
          <Item term="State">{detail.state}</Item>
          <Item term="Retention">{formatRetention(detail.retentionSecs) || "—"}</Item>
          <Item term="History archival">{detail.historyArchival.enabled ? detail.historyArchival.uri || "Enabled" : "Disabled"}</Item>
          <Item term="Visibility archival">{detail.visibilityArchival.enabled ? detail.visibilityArchival.uri || "Enabled" : "Disabled"}</Item>
          <Item term="Owner">{detail.ownerEmail || "—"}</Item>
          <Item term="Global">{detail.isGlobal ? `Yes · active ${detail.activeCluster}` : `No${detail.activeCluster ? ` · ${detail.activeCluster}` : ""}`}</Item>
          {detail.clusters.length > 1 ? <Item term="Clusters">{detail.clusters.join(", ")}</Item> : null}
          {detail.limits.blobSizeLimitError !== undefined ? <Item term="Payload limit">{formatBytes(detail.limits.blobSizeLimitError)}</Item> : null}
          {detail.capabilities.length > 0 ? <Item term="Features">{detail.capabilities.map(capabilityLabel).join(", ")}</Item> : null}
          {detail.description ? <Item term="Description">{detail.description}</Item> : null}
        </DescriptionList>
      ) : null}
      {attributes ? (
        <section className="flex flex-col gap-stack-md" aria-label="Search attributes">
          <div className="flex flex-col gap-stack-xs">
            <h3 className="text-body-1-strong text-fg">Search attributes</h3>
            <p className="text-body-1 text-fg-muted">What the query bar suggests in this namespace{attributes.fallback ? `. The server did not list them (${attributes.fallback}); these are the built-in ones.` : ""}</p>
          </div>
          <Table aria-label="Search attributes" className={cn("-mx-inset-lg w-auto", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Kind</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attributes.attributes.map((a) => (
                <TableRow key={a.name}>
                  <TableCell>
                    <span className="font-mono text-code">{a.name}</span>
                  </TableCell>
                  <TableCell>{a.valueType}</TableCell>
                  <TableCell>{a.custom ? "custom" : <span className="text-fg-muted">built-in</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
      {detail ? (
        <div className="flex flex-wrap gap-inline-md">
          <Button appearance="secondary" onClick={() => open("temporal.workflows", "Workflows", { query: "" })}>
            <Icon icon={Flash} /> Workflows
          </Button>
          <Button appearance="secondary" onClick={() => open("temporal.workers", "Workers")}>
            <Icon icon={Server} /> Workers
          </Button>
          <Button appearance="secondary" onClick={() => open("temporal.schedules", "Schedules")}>
            <Icon icon={CalendarClock} /> Schedules
          </Button>
        </div>
      ) : null}
    </aside>
  );
}

/** "6a1f0c3e-…-9b72": a long ID shortened as the mockup shows it; the whole one is its title and its copy. */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}-…-${id.slice(-4)}` : id;
}

function Item({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails>{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

/** "standaloneActivities" → "standalone activities". */
export const capabilityLabel = (name: string): string => name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
