// `nats.stream { stream }` (§6.3 "Stream", §6.4; mockup frames nats-stream-info, -messages, -purge,
// -stream-form): the stream's header with Refresh, Edit, Purge… and More (Delete stream, Copy
// config as JSON), and three views. Info: counts and the first and last sequence with their times,
// the limits as bars (amber near a limit, with what Discard does), the configuration in two
// columns, the cluster's peers, the mirror and sources, and the busiest subjects as bars that
// open Messages filtered by them. Messages: StreamMessages. Consumers: a table, and New consumer.
// Sealed and mirror streams disable Edit and Purge and say why.
import { linkTo, useTabView, viewOf } from "@/app/tab-view";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DescriptionList } from "@/components/ui/description-list";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton, LinkButton, NoticeContext, Page, PageHeader, PageRegion, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { NatsConsumerInfo, NatsStreamInfo } from "@/gen/api";
import { Add, ArrowClockwise, Copy, Delete, Edit, MoreHorizontal } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { DescribedError, LinkEvent, TabProps } from "../types";
import { ConsumerSheet } from "./ConsumerSheet";
import { DeleteStreamDialog, PurgeDialog, useAction } from "./JetStreamDialogs";
import { StreamMessages } from "./StreamMessages";
import { subjectPlace, useViewDecoding } from "./SchemasTab";
import { StreamSheet } from "./StreamSheet";
import { formatAgo, formatDuration, formatShortCount, formatSize, formatUs } from "./format";
import { Fact, Usage } from "./parts";
import { readOnlyReason } from "./stream-form";
import { reloadStreams } from "./tree-data";

/** The stream's views, the last word of its URL (DOC-21 §3.7). */
export const STREAM_VIEWS = ["info", "messages", "consumers"] as const;
type Section = (typeof STREAM_VIEWS)[number];

const text = (v: unknown) => (typeof v === "string" ? v : "");

export function streamTitle(params: Record<string, unknown>): string {
  return text(params["stream"]) || "Stream";
}

const RETENTION: Record<string, string> = { limits: "limits", interest: "interest", workQueue: "work queue" };

/** "pull · durable", "push · ephemeral". */
export function consumerKind(c: NatsConsumerInfo): string {
  return `${c.config.deliverSubject ? "push" : "pull"} · ${c.config.durable ? "durable" : "ephemeral"}`;
}

/** What Discard does at a limit, in one sentence. */
export function discardLine(info: NatsStreamInfo): string {
  const c = info.config;
  if (c.retention === "workQueue") return "Work queue: a message goes once a consumer acknowledges it.";
  if (c.retention === "interest") return "Interest: a message goes once every consumer has acknowledged it.";
  if (c.maxBytes === undefined && c.maxMessages === undefined && c.maxAgeMs === undefined && c.maxMessagesPerSubject === undefined) return "No limits: messages stay until they are purged or deleted.";
  return c.discard === "old" ? "Discard old: at a limit the oldest messages go first." : "Discard new: at a limit new messages are refused.";
}

function InfoView({ info, onSubject }: { info: NatsStreamInfo; onSubject(subject: string): void }) {
  const c = info.config;
  const s = info.state;
  const age = s.firstUs !== undefined ? Date.now() - s.firstUs / 1000 : 0;
  const maxCount = info.subjectCounts[0]?.messages ?? 0;
  const yes = (b: boolean) => (b ? "yes" : "no");
  return (
    <div className="flex min-h-0 flex-1 overflow-auto">
      <div className="flex min-w-0 flex-1 flex-col gap-stack-lg px-inset-lg py-inset-md">
        <DescriptionList layout="stacked" className="flex-row flex-wrap gap-x-inline-xl gap-y-stack-sm">
          <Fact term="Messages">{formatCount(s.messages)}</Fact>
          <Fact term="Bytes">{formatSize(s.bytes)}</Fact>
          <Fact term="First">{s.messages > 0 ? `seq ${formatCount(s.firstSequence)} · ${formatUs(s.firstUs)}` : "none"}</Fact>
          <Fact term="Last">{s.lastSequence > 0 ? `seq ${formatCount(s.lastSequence)} · ${formatUs(s.lastUs)}` : "none"}</Fact>
          <Fact term="Subjects">{formatCount(s.subjects)}</Fact>
          <Fact term="Consumers">{formatCount(s.consumers)}</Fact>
          {s.deleted > 0 ? <Fact term="Deleted inside">{formatCount(s.deleted)}</Fact> : null}
        </DescriptionList>
        <section aria-label="Limits" className="flex max-w-panel-lg flex-col gap-stack-sm">
          <h3 className="text-body-1-strong text-fg">Limits</h3>
          <Usage label="Bytes" used={s.bytes} limit={c.maxBytes} format={formatSize} />
          <Usage label="Messages" used={s.messages} limit={c.maxMessages} format={formatShortCount} />
          <Usage label="Age" used={age} limit={c.maxAgeMs} format={formatDuration} />
          <p className="text-body-1 text-fg-muted">{discardLine(info)}</p>
        </section>
        <div className="flex flex-wrap gap-inline-xl">
          <DescriptionList aria-label="Storage and limits" className="min-w-panel-xs flex-1">
            <Fact term="Storage">{`${c.storage}${c.compression === "s2" ? ", s2 compression" : ""}`}</Fact>
            <Fact term="Retention">{RETENTION[c.retention]}</Fact>
            <Fact term="Discard">{c.discard}{c.discardNewPerSubject ? ", per subject too" : ""}</Fact>
            <Fact term="Max message">{c.maxMessageSize !== undefined ? formatSize(c.maxMessageSize) : "no limit"}</Fact>
            <Fact term="Per subject">{c.maxMessagesPerSubject !== undefined ? formatCount(c.maxMessagesPerSubject) : "no limit"}</Fact>
            <Fact term="Max consumers">{c.maxConsumers !== undefined ? formatCount(c.maxConsumers) : "no limit"}</Fact>
          </DescriptionList>
          <DescriptionList aria-label="Replication and options" className="min-w-panel-xs flex-1">
            <Fact term="Replicas">{info.cluster?.leader ? `${c.replicas} · leader ${info.cluster.leader}` : String(c.replicas)}</Fact>
            <Fact term="Duplicates">{c.duplicateWindowMs !== undefined ? `${formatDuration(c.duplicateWindowMs)} window` : "server default"}</Fact>
            <Fact term="Direct get">{c.allowDirect ? "allowed" : "off"}</Fact>
            <Fact term="Rollup">{c.allowRollup ? "allowed" : "off"}</Fact>
            <Fact term="Deny delete">{yes(c.denyDelete)}</Fact>
            <Fact term="Deny purge">{yes(c.denyPurge)}</Fact>
            <Fact term="Created">{formatUs(info.createdUs)}</Fact>
          </DescriptionList>
        </div>
      </div>
      <aside aria-label="Cluster and subjects" className="flex w-panel-sm shrink-0 flex-col gap-stack-lg border-s border-border-subtle px-inset-lg py-inset-md">
        <section className="flex flex-col gap-stack-sm">
          <h3 className="text-body-1-strong text-fg">Cluster</h3>
          {info.cluster ? (
            <DescriptionList>
              {info.cluster.leader ? (
                <Fact term={info.cluster.leader}>
                  <Badge appearance="tint" variant="success">
                    leader
                  </Badge>
                </Fact>
              ) : null}
              {info.cluster.replicas.map((p) => (
                <Fact key={p.name} term={p.name}>
                  {p.offline ? "offline" : p.current ? "current" : "catching up"}
                  {p.lag !== undefined ? ` · lag ${formatCount(p.lag)}` : ""}
                </Fact>
              ))}
            </DescriptionList>
          ) : (
            <p className="text-body-1 text-fg-muted">A single server.</p>
          )}
          {info.cluster?.name ? <p className="text-caption-1 text-fg-muted">cluster {info.cluster.name}</p> : null}
        </section>
        {info.mirror || info.sources.length > 0 ? (
          <section className="flex flex-col gap-stack-sm">
            <h3 className="text-body-1-strong text-fg">{info.mirror ? "Mirror of" : "Sources"}</h3>
            <DescriptionList>
              {[...(info.mirror ? [info.mirror] : []), ...info.sources].map((m) => (
                <Fact key={m.name} term={m.name}>
                  lag {formatCount(m.lag)}
                  {m.filterSubject ? ` · ${m.filterSubject}` : ""}
                </Fact>
              ))}
            </DescriptionList>
          </section>
        ) : null}
        <section className="flex flex-col gap-stack-sm">
          <h3 className="text-body-1-strong text-fg">Subjects</h3>
          <p className="text-caption-1 text-fg-muted">Messages per subject, the busiest first.</p>
          {info.subjectCounts.length === 0 ? (
            <p className="text-body-1 text-fg-muted">No messages.</p>
          ) : (
            <ul className="flex flex-col gap-stack-sm">
              {info.subjectCounts.map((sc) => (
                <li key={sc.subject} className="flex flex-col gap-stack-xs">
                  <div className="flex items-baseline justify-between gap-inline-md text-body-1">
                    <LinkButton className="font-mono" onClick={() => onSubject(sc.subject)} title={`Messages on ${sc.subject}`}>
                      {sc.subject}
                    </LinkButton>
                    <span className="tabular-nums text-fg-muted">{formatShortCount(sc.messages)}</span>
                  </div>
                  <Progress aria-label={sc.subject} value={maxCount > 0 ? (sc.messages / maxCount) * 100 : 0} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

function ConsumersView({ consumers, onOpen, onNew, disabled }: { consumers: NatsConsumerInfo[] | null; onOpen(name: string, event?: LinkEvent): void; onNew(): void; disabled: boolean }) {
  if (consumers === null) return <LoadingRows label="Loading the consumers" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-inline-sm px-inset-lg py-inset-sm">
        <span className="flex-1 text-body-1 text-fg-muted">
          {consumers.length} {consumers.length === 1 ? "consumer" : "consumers"}
        </span>
        <Button appearance="primary" onClick={onNew} disabled={disabled}>
          <Icon icon={Add} /> New consumer…
        </Button>
      </div>
      {consumers.length === 0 ? (
        <EmptyLine>No consumers read this stream.</EmptyLine>
      ) : (
        <Table aria-label="Consumers" className={cn("min-h-0 flex-1", gutterTable)}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Filter</TableHead>
              <TableHead align="end">Pending</TableHead>
              <TableHead align="end">Ack pending</TableHead>
              <TableHead align="end">Redelivered</TableHead>
              <TableHead>Last delivered</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {consumers.map((c) => (
              <TableRow key={c.name}>
                <TableCell>
                  <LinkButton className="font-mono" onOpen={(e) => onOpen(c.name, e)}>
                    {c.name}
                  </LinkButton>
                </TableCell>
                <TableCell>{consumerKind(c)}</TableCell>
                <TableCell className="font-mono">{c.config.filterSubjects.join(", ") || "all"}</TableCell>
                <TableCell align="end" className="tabular-nums">
                  {formatCount(c.numPending)}
                </TableCell>
                <TableCell align="end" className="tabular-nums">
                  {formatCount(c.numAckPending)}
                </TableCell>
                <TableCell align="end" className="tabular-nums">
                  {formatCount(c.numRedelivered)}
                </TableCell>
                <TableCell>{c.delivered.stream > 0 ? `seq ${formatCount(c.delivered.stream)}${c.delivered.lastActiveUs ? ` · ${formatAgo(c.delivered.lastActiveUs)}` : ""}` : "nothing yet"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

type Dialog = "edit" | "purge" | "delete" | "consumer" | null;

export function StreamTab({ tab, profile, connId, client, useTabActions, onLive, note, openTab, navigate, go: goProp, updateProfile }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });
  const name = text(tab.params["stream"]);
  const place = useCallback((m: Parameters<typeof subjectPlace>[0]) => subjectPlace(m, name), [name]);
  const decoding = useViewDecoding({ client, connId, profile, updateProfile, openTab }, place);
  const notify = useContext(NoticeContext);
  const [info, setInfo] = useState<NatsStreamInfo | null>(null);
  const [consumers, setConsumers] = useState<NatsConsumerInfo[] | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  // Tabs saved before the routes kept the view as `section`.
  const [section, setSection] = useTabView({ tab, navigate }, STREAM_VIEWS, viewOf({ view: tab.params["section"] }, STREAM_VIEWS, "info"));
  const [subject, setSubject] = useState<{ value: string; key: number }>({ value: "", key: 0 });
  const [dialog, setDialog] = useState<Dialog>(null);
  const action = useAction(note);
  const generation = useRef(0);
  const live = useRef<{ primary?: () => void; stop?: () => void; pause?: () => void }>({});

  const load = useCallback(async () => {
    if (connId === null || name === "") return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const [i, c] = await Promise.all([client.nats.js.streams.info({ connId, stream: name, subjectCounts: true }), client.nats.js.consumers.list({ connId, stream: name })]);
      if (mine !== generation.current) return;
      setInfo(i);
      setConsumers(c);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, name, note]);
  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({
    refresh: () => void load(),
    primary: () => live.current.primary?.(),
    stop: () => live.current.stop?.(),
    pause: () => live.current.pause?.(),
  });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const c = info?.config;
  const reasons = c ? readOnlyReason(c) : { edit: null, purge: null };
  const subtitle = info
    ? [
        profile.name,
        `subjects ${c!.subjects.join(", ") || "none"}`,
        `${c!.replicas} ${c!.replicas === 1 ? "replica" : "replicas"}${info.cluster?.name ? ` on cluster ${info.cluster.name}` : ""}`,
        `${formatCount(info.state.messages)} messages`,
        formatSize(info.state.bytes),
      ].join(" · ")
    : profile.name;
  const copyConfig = async () => {
    if (!c) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(c, null, 2));
      notify({ title: `Copied the configuration of ${name}`, type: "success" });
    } catch {
      notify({ title: "The clipboard refused the copy", type: "warning" });
    }
  };
  const showSubject = (s: string) => {
    setSubject((x) => ({ value: s, key: x.key + 1 }));
    setSection("messages");
  };
  return (
    <Page>
      <PageHeader
        title={name}
        adornment={
          <>
            <CopyButton value={name} what="stream name" />
            {c ? (
              <Badge appearance="tint" variant="neutral">
                {c.storage} · {RETENTION[c.retention]}
              </Badge>
            ) : null}
            {c?.sealed ? (
              <Badge appearance="tint" variant="warning">
                sealed
              </Badge>
            ) : null}
            {c?.mirror ? (
              <Badge appearance="tint" variant="info">
                mirror of {c.mirror.name}
              </Badge>
            ) : null}
          </>
        }
        subtitle={subtitle}
        actions={
          <>
            <Button appearance="subtle" onClick={() => void load()} loading={loading}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button onClick={() => setDialog("edit")} disabled={!info || reasons.edit !== null} title={reasons.edit ?? undefined}>
              <Icon icon={Edit} /> Edit
            </Button>
            <Button onClick={() => setDialog("purge")} disabled={!info || reasons.purge !== null || info.state.messages === 0} title={reasons.purge ?? (info?.state.messages === 0 ? "No messages to purge." : undefined)}>
              <Icon icon={Delete} /> Purge…
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton appearance="subtle" aria-label="More: Delete stream, Copy config as JSON" disabled={!info} />}>
                <Icon icon={MoreHorizontal} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void copyConfig()}>
                  <Icon icon={Copy} /> Copy config as JSON
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setDialog("delete")}>
                  <Icon icon={Delete} /> Delete stream…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {reasons.edit ? <p className="px-inset-lg pt-stack-xs text-body-1 text-fg-muted">{reasons.edit}</p> : null}
      {error ? (
        <PageRegion className="px-inset-lg py-inset-md">
          <ErrorState error={error} onRetry={() => void load()} />
        </PageRegion>
      ) : null}
      {!info && loading && !error ? <LoadingRows label="Loading the stream" /> : null}
      {info ? (
        <Tabs value={section} onValueChange={(v) => setSection(v as Section)} className="mt-stack-md flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Stream views" className="gap-inline-xs px-inset-lg [&_[data-slot=tabs-trigger]]:h-control-lg [&_[data-slot=tabs-trigger]]:px-inline-md [&_[data-slot=tabs-item]:first-child]:-ms-inline-md">
            <TabsTrigger value="info">Info</TabsTrigger>
            <TabsTrigger value="messages">Messages</TabsTrigger>
            <TabsTrigger value="consumers">
              Consumers <span className="text-body-1 text-fg-muted">{consumers?.length ?? info.state.consumers}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="info" className="flex min-h-0 flex-1 flex-col border-t border-border-subtle">
            <InfoView info={info} onSubject={showSubject} />
          </TabsContent>
          <TabsContent value="messages" keepMounted className="flex min-h-0 flex-1 flex-col border-t border-border-subtle">
            <StreamMessages
              key={subject.key}
              stream={name}
              lastSequence={info.state.lastSequence}
              connId={connId}
              client={client}
              note={note}
              onLive={onLive}
              subject={subject.value}
              decoding={decoding}
              registerActions={(a) => {
                live.current = a;
              }}
            />
          </TabsContent>
          <TabsContent value="consumers" className="flex min-h-0 flex-1 flex-col border-t border-border-subtle">
            <ConsumersView
              consumers={consumers}
              disabled={c?.sealed === true}
              onNew={() => setDialog("consumer")}
              onOpen={(consumer, event) => go({ kind: "nats.consumer", params: { stream: name, consumer }, title: consumer }, event)}
            />
          </TabsContent>
        </Tabs>
      ) : null}
      {info ? (
        <>
          <StreamSheet
            open={dialog === "edit"}
            onOpenChange={(o) => setDialog(o ? "edit" : null)}
            stream={info.config}
            profileName={profile.name}
            connId={connId}
            client={client}
            onSaved={(saved) => {
              notify({ title: `Updated stream ${name}`, type: "success" });
              setInfo((i) => (i ? { ...saved, subjectCounts: i.subjectCounts } : saved));
              void load();
            }}
          />
          <PurgeDialog
            open={dialog === "purge"}
            onOpenChange={(o) => {
              setDialog(o ? "purge" : null);
              action.clear();
            }}
            info={info}
            profileName={profile.name}
            busy={action.busy}
            error={action.error}
            onPurge={(input) =>
              void action.run(
                async () => {
                  const out = await client.nats.js.streams.purge({ connId, stream: name, ...input });
                  notify({ title: `Purged ${formatCount(out.purged)} ${out.purged === 1 ? "message" : "messages"} from ${name}`, type: "success" });
                },
                () => {
                  setDialog(null);
                  void load();
                  void reloadStreams(connId, client);
                },
              )
            }
          />
          <DeleteStreamDialog
            open={dialog === "delete"}
            onOpenChange={(o) => {
              setDialog(o ? "delete" : null);
              action.clear();
            }}
            name={name}
            consumers={info.state.consumers}
            messages={info.state.messages}
            profileName={profile.name}
            busy={action.busy}
            error={action.error}
            onDelete={() =>
              void action.run(
                async () => {
                  await client.nats.js.streams.delete({ connId, stream: name });
                  notify({ title: `Deleted stream ${name}`, type: "success" });
                },
                () => {
                  setDialog(null);
                  setInfo(null);
                  setError({ title: `${name} was deleted.`, kind: "NotFound" });
                  void reloadStreams(connId, client);
                },
              )
            }
          />
          <ConsumerSheet
            open={dialog === "consumer"}
            onOpenChange={(o) => setDialog(o ? "consumer" : null)}
            stream={name}
            profileName={profile.name}
            connId={connId}
            client={client}
            onCreated={(created) => {
              notify({ title: `Created consumer ${created.name}`, type: "success", action: { label: "Open consumer", onClick: () => openTab({ kind: "nats.consumer", params: { stream: name, consumer: created.name }, title: created.name }) } });
              void load();
              void reloadStreams(connId, client);
            }}
          />
        </>
      ) : null}
    </Page>
  );
}
