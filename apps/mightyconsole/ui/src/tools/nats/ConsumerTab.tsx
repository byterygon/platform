// `nats.consumer { stream, consumer }` (§6.3 "Consumer", mockup frame nats-consumer): pending, ack
// pending, redelivered and waiting pulls large; where the consumer is in the stream as one bar from
// the first to the last sequence (acknowledged, delivered and not acknowledged, not yet delivered:
// DOC-21 Open question 45 (o)); the configuration and the last delivered and ack floor sequences
// (stream and consumer) below. Refreshes every 2 s while the tab is shown; Pause refresh holds it.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DescriptionList } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { CopyButton, NoticeContext, Page, PageHeader, PageRegion } from "@/app/page";
import { DisconnectedState, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { NatsConsumerInfo, NatsStreamState } from "@/gen/api";
import { Delete, Pause, Play } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { DeleteConsumerDialog, useAction } from "./JetStreamDialogs";
import { consumerKind } from "./StreamTab";
import { formatAgo, formatDuration, formatUs } from "./format";
import { Fact } from "./parts";
import { reloadStreams } from "./tree-data";

/** How often the screen reads the consumer again (§6.3). */
export const CONSUMER_REFRESH_MS = 2000;

const text = (v: unknown) => (typeof v === "string" ? v : "");

export function consumerTitle(params: Record<string, unknown>): string {
  return text(params["consumer"]) || "Consumer";
}

export interface Position {
  first: number;
  last: number;
  /** Shares of the range from first to last, in percent. */
  acked: number;
  delivered: number;
  rest: number;
}

/** Where a consumer is in its stream, by stream sequence (an empty stream is all "rest"). */
export function positionOf(state: Pick<NatsStreamState, "firstSequence" | "lastSequence" | "messages">, c: Pick<NatsConsumerInfo, "ackFloor" | "delivered">): Position {
  const first = state.firstSequence;
  const last = state.lastSequence;
  const total = state.messages > 0 && last >= first ? last - first + 1 : 0;
  if (total === 0) return { first, last, acked: 0, delivered: 0, rest: 100 };
  const clamp = (n: number) => Math.min(total, Math.max(0, n));
  const acked = clamp(c.ackFloor.stream - first + 1);
  const delivered = Math.max(0, clamp(c.delivered.stream - first + 1) - acked);
  const pct = (n: number) => (n / total) * 100;
  return { first, last, acked: pct(acked), delivered: pct(delivered), rest: Math.max(0, 100 - pct(acked) - pct(delivered)) };
}

function PositionBar({ state, info }: { state: NatsStreamState; info: NatsConsumerInfo }) {
  const p = positionOf(state, info);
  const label = `Acknowledged up to stream sequence ${formatCount(info.ackFloor.stream)}, delivered up to ${formatCount(info.delivered.stream)}, of ${formatCount(p.first)} to ${formatCount(p.last)}`;
  return (
    <section aria-label="Where it is in the stream" className="flex max-w-panel-xl flex-col gap-stack-sm">
      <h3 className="text-body-1-strong text-fg">Where it is in the stream</h3>
      <div role="img" aria-label={label} className="flex h-inline-sm w-full overflow-hidden rounded-full bg-inset">
        <span data-part="acked" className="h-full bg-accent-compound" style={{ width: `${p.acked}%` }} />
        <span data-part="delivered" className="h-full bg-warning" style={{ width: `${p.delivered}%` }} />
      </div>
      <div className="flex flex-wrap justify-between gap-inline-md text-caption-1 text-fg-muted tabular-nums">
        <span>first {formatCount(p.first)}</span>
        <span>
          ack floor {formatCount(info.ackFloor.stream)} · delivered {formatCount(info.delivered.stream)}
        </span>
        <span>last {formatCount(p.last)}</span>
      </div>
      <div className="flex flex-wrap gap-inline-lg text-caption-1 text-fg-muted">
        <span className="flex items-center gap-inline-xs">
          <span aria-hidden="true" className="size-icon-xs rounded-full bg-accent-compound" /> acknowledged
        </span>
        <span className="flex items-center gap-inline-xs">
          <span aria-hidden="true" className="size-icon-xs rounded-full bg-warning" /> delivered, not acknowledged
        </span>
        <span className="flex items-center gap-inline-xs">
          <span aria-hidden="true" className="size-icon-xs rounded-full bg-inset" /> not delivered yet
        </span>
      </div>
      {info.config.filterSubjects.length > 0 ? <p className="text-caption-1 text-fg-muted">By stream sequence: the stream also holds messages its filter does not take.</p> : null}
    </section>
  );
}

function Big({ term, value }: { term: string; value: number }) {
  return (
    <div className="flex flex-col gap-stack-xs">
      <span className="text-caption-1 text-fg-muted">{term}</span>
      <span className="text-subtitle-1 tabular-nums text-fg">{formatCount(value)}</span>
    </div>
  );
}

export function ConsumerTab({ tab, profile, connId, client, active, useTabActions, note, openTab }: TabProps) {
  const stream = text(tab.params["stream"]);
  const name = text(tab.params["consumer"]);
  const notify = useContext(NoticeContext);
  const [info, setInfo] = useState<NatsConsumerInfo | null>(null);
  const [state, setState] = useState<NatsStreamState | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [paused, setPaused] = useState(false);
  const [gone, setGone] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const action = useAction(note);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (connId === null || stream === "" || name === "") return;
    const mine = ++generation.current;
    try {
      const [c, s] = await Promise.all([client.nats.js.consumers.info({ connId, stream, consumer: name }), client.nats.js.streams.info({ connId, stream })]);
      if (mine !== generation.current) return;
      setInfo(c);
      setState(s.state);
      setError(null);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    }
  }, [client, connId, stream, name, note]);
  useEffect(() => {
    void load();
  }, [load]);
  const refreshing = active && !paused && !gone && error === null;
  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = setInterval(() => void load(), CONSUMER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshing, load]);
  useTabActions({ refresh: () => void load(), pause: () => setPaused((p) => !p) });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const c = info?.config;
  const subtitle = c
    ? [
        `Consumer of ${stream}`,
        c.filterSubjects.length > 0 ? `filter ${c.filterSubjects.join(", ")}` : "every subject",
        c.ackPolicy === "none" ? "no acks" : `ack ${c.ackPolicy}`,
        c.ackPolicy === "none" ? null : `ack wait ${formatDuration(c.ackWaitMs)}`,
        c.maxDeliver !== undefined ? `max deliver ${c.maxDeliver}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : `Consumer of ${stream}`;
  return (
    <Page>
      <PageHeader
        title={name}
        adornment={
          <>
            <CopyButton value={name} what="consumer name" />
            {info ? (
              <Badge appearance="tint" variant="neutral">
                {consumerKind(info)}
              </Badge>
            ) : null}
            {info?.paused ? (
              <Badge appearance="tint" variant="warning">
                paused on the server
              </Badge>
            ) : null}
          </>
        }
        subtitle={subtitle}
        actions={
          <>
            {refreshing ? (
              <Badge appearance="tint" variant="info">
                Refreshing every 2 s
              </Badge>
            ) : null}
            <Button appearance="subtle" onClick={() => setPaused((p) => !p)} disabled={gone}>
              <Icon icon={paused ? Play : Pause} /> {paused ? "Resume refresh" : "Pause refresh"}
            </Button>
            <Button onClick={() => setDeleting(true)} disabled={!info || gone}>
              <Icon icon={Delete} /> Delete…
            </Button>
          </>
        }
      />
      <PageRegion className="gap-stack-lg overflow-auto px-inset-lg py-inset-md">
        {error ? <ErrorState error={error} onRetry={() => void load()} onRefresh={() => openTab({ kind: "nats.stream", params: { stream, section: "consumers" }, title: stream })} /> : null}
        {!info && !error ? <LoadingRows label="Loading the consumer" /> : null}
        {info && state && c ? (
          <>
            <div className="flex flex-wrap gap-inline-xl" aria-label="State">
              <Big term="Pending" value={info.numPending} />
              <Big term="Ack pending" value={info.numAckPending} />
              <Big term="Redelivered" value={info.numRedelivered} />
              <Big term="Waiting pulls" value={info.numWaiting} />
            </div>
            <PositionBar state={state} info={info} />
            <div className="flex flex-wrap gap-inline-xl">
              <DescriptionList aria-label="Configuration" className="min-w-panel-xs flex-1">
                <Fact term="Deliver">{c.deliver === "byStartSequence" ? `from sequence ${formatCount(c.startSequence ?? 0)}` : c.deliver === "byStartTime" ? `from ${formatUs(c.startTimeUs)}` : c.deliver}</Fact>
                <Fact term="Ack">{c.ackPolicy === "none" ? "none" : `${c.ackPolicy}, wait ${formatDuration(c.ackWaitMs)}`}</Fact>
                <Fact term="Max deliver">{c.maxDeliver !== undefined ? formatCount(c.maxDeliver) : "no limit"}</Fact>
                <Fact term="Max ack pending">{c.maxAckPending !== undefined ? formatCount(c.maxAckPending) : "server default"}</Fact>
                <Fact term="Replay">{c.replay}</Fact>
                {c.deliverSubject ? <Fact term="Deliver subject">{`${c.deliverSubject}${c.deliverGroup ? ` · group ${c.deliverGroup}` : ""}${info.pushBound ? " · a client listens" : " · no client listens"}`}</Fact> : null}
                {c.inactiveThresholdMs !== undefined ? <Fact term="Inactive threshold">{formatDuration(c.inactiveThresholdMs)}</Fact> : null}
              </DescriptionList>
              <DescriptionList aria-label="Sequences" className="min-w-panel-xs flex-1">
                <Fact term="Last delivered">{`stream ${formatCount(info.delivered.stream)} · consumer ${formatCount(info.delivered.consumer)}${info.delivered.lastActiveUs ? ` · ${formatAgo(info.delivered.lastActiveUs)}` : ""}`}</Fact>
                <Fact term="Ack floor">{`stream ${formatCount(info.ackFloor.stream)} · consumer ${formatCount(info.ackFloor.consumer)}${info.ackFloor.lastActiveUs ? ` · ${formatAgo(info.ackFloor.lastActiveUs)}` : ""}`}</Fact>
                <Fact term="Created">{formatAgo(info.createdUs)}</Fact>
                <Fact term="Replicas">{c.replicas !== undefined ? String(c.replicas) : "as the stream"}</Fact>
                {info.cluster?.leader ? <Fact term="Leader">{info.cluster.leader}</Fact> : null}
              </DescriptionList>
            </div>
          </>
        ) : null}
      </PageRegion>
      <DeleteConsumerDialog
        open={deleting}
        onOpenChange={(o) => {
          setDeleting(o);
          action.clear();
        }}
        stream={stream}
        name={name}
        profileName={profile.name}
        busy={action.busy}
        error={action.error}
        onDelete={() =>
          void action.run(
            async () => {
              await client.nats.js.consumers.delete({ connId, stream, consumer: name });
              notify({ title: `Deleted consumer ${name} of ${stream}`, type: "success" });
            },
            () => {
              setDeleting(false);
              setGone(true);
              setError({ title: `${name} was deleted.`, kind: "NotFound" });
              void reloadStreams(connId, client);
            },
          )
        }
      />
    </Page>
  );
}
