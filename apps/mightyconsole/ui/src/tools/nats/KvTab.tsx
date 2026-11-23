// `nats.kv { bucket }` (§6.3 "Key-Value", §6.4; mockup frame nats-kv): the bucket's header with
// Refresh, Put key and More (Delete bucket), then two views.
// - Keys: the key list with a filter (up to 10,000 keys, then "Narrow with a filter"), revision,
//   operation, update and a preview; deleted keys struck through when "Show deleted" is on. The
//   selected key's pane: Entry (the value through the codecs) and History (every revision kept;
//   pick one to compare with the latest and "Put revision n back", sent with the latest revision
//   expected so a concurrent change fails as Conflict: DOC-21 Open question 45 (o)); Put a new
//   value, Delete key (a delete marker) and Purge key (its history goes).
// - Watch: the messaging core's MessageViewer live over the bucket or a key pattern, with the
//   history first when asked.
// The mockup draws Watch beside the key; a message list needs the width, so it is a view of its
// own here (DOC-21 Open question 48).
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonView } from "@/app/json-view";
import { CodeBlock } from "@/components/ui/code-block";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { liveTimeout, useServices, type MightyClient } from "@/app/client";
import { formatCount } from "@/app/messages";
import { CopyButton, NoticeContext, Page, PageBar, PageHeader, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { useStore } from "@/app/store";
import { useTabView, viewOf } from "@/app/tab-view";
import * as api from "@/gen/api";
import { CodecMenu } from "@/messaging/schemas/CodecMenu";
import { FilterBar } from "@/messaging/FilterBar";
import { MessageViewer } from "@/messaging/MessageViewer";
import { useLiveTail } from "@/messaging/useLiveTail";
import { Add, ArrowClockwise, ArrowCounterclockwise, Delete, Edit, MoreHorizontal, Play } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { ProfileRecord } from "@/profiles/record";
import type { DescribedError, LiveState, TabProps } from "../types";
import { ConfirmDialog, useAction } from "./JetStreamDialogs";
import { KvPutSheet } from "./KvPutSheet";
import { diffLines } from "@/lib/diff";
import { formatAgo, formatDuration, formatSize } from "./format";
import { validatePattern } from "./profile";
import { reloadStreams } from "./tree-data";
import { type ViewDecoding, bucketPlace, useViewDecoding } from "./SchemasTab";

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** The bucket's views, the last word of its URL (DOC-21 §3.7). */
export const KV_VIEWS = ["keys", "watch"] as const;

export function kvTitle(params: Record<string, unknown>): string {
  return text(params["bucket"]) || "Key-Value";
}

/** The entry's value: JSON that parses in the JSON view (Text first, as a value is read), anything else as plain text. */
function KvValue({ record, deleted }: { record: api.MessageRecord; deleted: boolean }) {
  const text = record.payloadText;
  const json = useMemo(() => {
    if (deleted || record.payloadCodec !== "json" || text === undefined) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }, [deleted, record.payloadCodec, text]);
  return json ? (
    <JsonView modeKey="nats.kv.value" defaultMode="text" text={text!} aria-label="Value" className="max-h-panel-sm" />
  ) : (
    <CodeBlock aria-label="Value" code={valueText(record)} language="text" copyable wrap className="max-h-panel-sm" />
  );
}

/** A record's value as text: pretty JSON, other text, or what it is when it is not text. */
export function valueText(r: Pick<api.MessageRecord, "payloadText" | "payloadCodec" | "payloadSize" | "operation">): string {
  if (r.operation === "delete") return "(deleted)";
  if (r.operation === "purge") return "(purged)";
  if (r.payloadText === undefined) return `(${formatSize(r.payloadSize)}, not text)`;
  if (r.payloadCodec === "json") {
    try {
      return JSON.stringify(JSON.parse(r.payloadText), null, 2);
    } catch {
      return r.payloadText;
    }
  }
  return r.payloadText;
}

const revisionOf = (r: api.MessageRecord) => Number(r.sequence ?? 0);

type Dialog = { kind: "delete" | "purge" } | { kind: "back"; record: api.MessageRecord; latest: number } | { kind: "deleteBucket" } | null;

function KeyPane({ bucket, keyName, profile, connId, client, note, onChanged, onPutNew }: { bucket: string; keyName: string; profile: ProfileRecord; connId: string; client: MightyClient; note(e: unknown): DescribedError; onChanged(): void; onPutNew(revision: number | undefined): void }) {
  const notify = useContext(NoticeContext);
  const [section, setSection] = useState<"entry" | "history">("entry");
  const [history, setHistory] = useState<api.MessageRecord[] | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const action = useAction(note);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    setError(null);
    try {
      const h = await client.nats.kv.history({ connId, bucket, key: keyName });
      if (mine !== generation.current) return;
      setHistory(h);
      setFrom((f) => (f !== null && h.some((r) => revisionOf(r) === f) ? f : h.length > 1 ? revisionOf(h[h.length - 2]!) : null));
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    }
  }, [client, connId, bucket, keyName, note]);
  useEffect(() => {
    setHistory(null);
    setFrom(null);
    void load();
  }, [load]);
  const latest = history?.[history.length - 1];
  const base = history?.find((r) => revisionOf(r) === from);
  const diff = useMemo(() => (base && latest ? diffLines(valueText(base), valueText(latest)) : []), [base, latest]);
  const deleted = latest?.operation === "delete" || latest?.operation === "purge";
  return (
    <aside aria-label={`Key ${keyName}`} className="flex w-panel-md shrink-0 flex-col gap-stack-sm overflow-auto border-s border-border-subtle px-inset-lg py-inset-md">
      <div className="flex items-center gap-inline-sm">
        <h3 className="min-w-0 truncate font-mono text-body-1-strong text-fg">{keyName}</h3>
        <CopyButton value={keyName} what="key" />
      </div>
      {latest ? (
        <p className="text-caption-1 text-fg-muted">
          revision {revisionOf(latest)} · {latest.operation ?? "put"} {formatAgo(latest.timestampUs)} · {latest.payloadCodec}
        </p>
      ) : null}
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {!history && !error ? <LoadingRows label="Loading the key" /> : null}
      {history && latest ? (
        <Tabs value={section} onValueChange={(v) => setSection(v as "entry" | "history")} className="flex min-h-0 flex-col">
          <TabsList aria-label="Key views">
            <TabsTrigger value="entry">Entry</TabsTrigger>
            <TabsTrigger value="history" count={history.length} countLabel={["revision", "revisions"]}>
              History
            </TabsTrigger>
          </TabsList>
          <TabsContent value="entry" className="flex flex-col gap-stack-sm pt-stack-sm">
            {latest.decodeError ? <p className="text-caption-1 text-warning-fg">{latest.decodeError}</p> : null}
            <KvValue record={latest} deleted={deleted} />
          </TabsContent>
          <TabsContent value="history" className="flex flex-col gap-stack-sm pt-stack-sm">
            <Table aria-label="Revisions" size="small">
              <TableHeader>
                <TableRow>
                  <TableHead align="end">Rev</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...history].reverse().map((r) => {
                  const rev = revisionOf(r);
                  const isLatest = r === latest;
                  return (
                    <TableRow key={rev} selected={rev === from || isLatest}>
                      <TableCell align="end" className="tabular-nums">
                        {isLatest ? (
                          rev
                        ) : (
                          <Button size="small" appearance="subtle" aria-pressed={rev === from} aria-label={`Compare revision ${rev} with the latest`} onClick={() => setFrom(rev)}>
                            {rev}
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>{formatAgo(r.timestampUs)}</TableCell>
                      <TableCell className="max-w-panel-xs truncate font-mono text-fg-muted">{r.operation === "put" || r.operation === undefined ? (r.payloadText ?? `(${formatSize(r.payloadSize)})`) : `(${r.operation})`}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {base && base !== latest ? (
              <section aria-label={`Revision ${revisionOf(base)} to ${revisionOf(latest)}`} className="flex flex-col gap-stack-xs">
                <h4 className="text-body-1-strong text-fg">
                  {revisionOf(base)} → {revisionOf(latest)}
                </h4>
                <pre className="overflow-auto rounded-md border border-border-subtle bg-layer font-mono text-code" data-slot="diff">
                  {diff.map((l, i) => (
                    <div key={i} data-kind={l.kind} className={cn("px-inset-xs", l.kind === "removed" && "bg-danger-subtle text-danger-fg", l.kind === "added" && "bg-success-subtle text-success-fg")}>
                      {l.kind === "removed" ? "- " : l.kind === "added" ? "+ " : "  "}
                      {l.text}
                    </div>
                  ))}
                </pre>
                <div className="flex flex-wrap gap-inline-sm">
                  <Button size="small" onClick={() => setDialog({ kind: "back", record: base, latest: revisionOf(latest) })} disabled={base.operation !== undefined && base.operation !== "put"}>
                    <Icon icon={ArrowCounterclockwise} /> Put revision {revisionOf(base)} back…
                  </Button>
                </div>
              </section>
            ) : history.length === 1 ? (
              <p className="text-body-1 text-fg-muted">One revision kept: nothing to compare.</p>
            ) : null}
          </TabsContent>
        </Tabs>
      ) : null}
      {history ? (
        <div className="flex flex-wrap gap-inline-sm border-t border-border-subtle pt-stack-sm">
          <Button size="small" onClick={() => onPutNew(latest ? revisionOf(latest) : undefined)}>
            <Icon icon={Edit} /> Put a new value…
          </Button>
          <Button size="small" appearance="subtle" onClick={() => setDialog({ kind: "delete" })} disabled={deleted}>
            <Icon icon={Delete} /> Delete key…
          </Button>
          <Button size="small" appearance="subtle" onClick={() => setDialog({ kind: "purge" })}>
            <Icon icon={Delete} /> Purge key…
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(o) => !o && (setDialog(null), action.clear())}
        title={`Delete ${keyName} from ${bucket} on ${profile.name}?`}
        description="A delete marker is written: the key reads as deleted, and its earlier revisions stay until they age out or the key is purged."
        confirm="Delete key"
        disabled={false}
        busy={action.busy}
        error={action.error}
        onConfirm={() =>
          void action.run(
            async () => {
              await client.nats.kv.delete({ connId, bucket, key: keyName });
              notify({ title: `Deleted ${keyName}`, type: "success" });
            },
            () => {
              setDialog(null);
              void load();
              onChanged();
            },
          )
        }
      />
      <ConfirmDialog
        open={dialog?.kind === "purge"}
        onOpenChange={(o) => !o && (setDialog(null), action.clear())}
        title={`Purge ${keyName} from ${bucket} on ${profile.name}?`}
        description="Every revision of the key is removed, leaving one purge marker. This cannot be undone."
        confirm="Purge key"
        disabled={false}
        busy={action.busy}
        error={action.error}
        onConfirm={() =>
          void action.run(
            async () => {
              await client.nats.kv.purge({ connId, bucket, key: keyName });
              notify({ title: `Purged ${keyName}`, type: "success" });
            },
            () => {
              setDialog(null);
              void load();
              onChanged();
            },
          )
        }
      />
      {dialog?.kind === "back" ? (
        <ConfirmDialog
          open
          danger={false}
          onOpenChange={(o) => !o && (setDialog(null), action.clear())}
          title={`Put revision ${revisionOf(dialog.record)} of ${keyName} back?`}
          description={`Its value becomes a new revision. It is written only if the key is still at revision ${dialog.latest}: if someone changed it meanwhile, nothing is written and you see the change first.`}
          confirm={`Put revision ${revisionOf(dialog.record)} back`}
          disabled={false}
          busy={action.busy}
          error={action.error}
          onConfirm={() =>
            void action.run(
              async () => {
                const out = await client.nats.kv.put({ connId, bucket, key: keyName, payload: { codec: "base64", text: dialog.record.payloadRaw }, expectRevision: dialog.latest });
                notify({ title: `Put revision ${revisionOf(dialog.record)} back as revision ${out.revision}`, type: "success" });
              },
              () => {
                setDialog(null);
                void load();
                onChanged();
              },
            )
          }
        />
      ) : null}
    </aside>
  );
}

function KeysView({ bucket, profile, connId, client, note, refreshKey, onPut }: { bucket: string; profile: ProfileRecord; connId: string; client: MightyClient; note(e: unknown): DescribedError; refreshKey: number; onPut(key?: string, revision?: number): void }) {
  const [filter, setFilter] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);
  const [keys, setKeys] = useState<api.NatsKvKeysOutput | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const filterProblem = filter.trim() === "" ? null : validatePattern(filter.trim());
  const load = useCallback(async () => {
    if (filterProblem) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const out = await client.nats.kv.keys({ connId, bucket, filter: filter.trim() || null, includeDeleted: showDeleted });
      if (mine !== generation.current) return;
      setKeys(out);
      setSelected((s) => s ?? out.keys.find((k) => k.operation === "put")?.key ?? null);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, bucket, filter, showDeleted, filterProblem, note]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load, refreshKey, version]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar aria-label="Keys filter">
        <SearchInput aria-label="Filter keys" value={filter} onValueChange={setFilter} placeholder="Filter keys, e.g. feature.>" className="max-w-panel-md flex-1 font-mono" />
        {filterProblem ? <span className="text-caption-1 text-danger-fg">{filterProblem}</span> : null}
        <label className="flex items-center gap-inline-sm text-body-1 text-fg">
          <Switch checked={showDeleted} onCheckedChange={setShowDeleted} /> Show deleted
        </label>
        {loading ? <span className="text-caption-1 text-fg-muted">Loading…</span> : null}
      </PageBar>
      {error ? (
        <div className="px-inset-lg py-inset-sm">
          <ErrorState error={error} onRetry={() => void load()} />
        </div>
      ) : null}
      {keys?.truncated ? <p className="px-inset-lg py-inset-xs text-body-1 text-warning-fg">The first {formatCount(keys.keys.length)} keys are shown. Narrow with a filter.</p> : null}
      <div className="mt-stack-sm flex min-h-0 flex-1 border-t border-border-subtle">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
          {keys === null && !error ? <LoadingRows label="Loading the keys" /> : null}
          {keys !== null && keys.keys.length === 0 ? (
            <EmptyLine action={<Button onClick={() => onPut()}>Put key</Button>}>{filter.trim() ? `No key matches ${filter.trim()}.` : "No keys in this bucket."}</EmptyLine>
          ) : null}
          {keys !== null && keys.keys.length > 0 ? (
            <Table aria-label="Keys" size="small" className={gutterTable}>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead align="end">Revision</TableHead>
                  <TableHead>Op</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.keys.map((k) => (
                  <TableRow key={k.key} selected={k.key === selected}>
                    <TableCell>
                      <button type="button" onClick={() => setSelected(k.key)} className={cn("cursor-pointer rounded-sm text-start font-mono text-fg-link hover:underline", k.operation !== "put" && "text-fg-muted line-through")}>
                        {k.key}
                      </button>
                    </TableCell>
                    <TableCell align="end" className="tabular-nums">
                      {k.revision}
                    </TableCell>
                    <TableCell>
                      <Badge appearance="tint" variant={k.operation === "put" ? "neutral" : "danger"}>
                        {k.operation}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatAgo(k.createdUs)}</TableCell>
                    <TableCell className="max-w-panel-sm truncate font-mono text-fg-muted">{k.preview ?? (k.operation === "put" ? `(${formatSize(k.size)})` : "")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </div>
        {selected ? (
          <KeyPane
            key={`${selected}:${refreshKey}`}
            bucket={bucket}
            keyName={selected}
            profile={profile}
            connId={connId}
            client={client}
            note={note}
            onChanged={() => setVersion((v) => v + 1)}
            onPutNew={(revision) => onPut(selected, revision)}
          />
        ) : null}
      </div>
    </div>
  );
}

function WatchView({ bucket, connId, client, note, onLive, registerActions, decoding, active }: { active: boolean; bucket: string; connId: string; client: MightyClient; note(e: unknown): DescribedError; onLive(live: LiveState | null): void; registerActions(a: { primary: () => void; stop: () => void; pause: () => void }): void; decoding: ViewDecoding }) {
  const services = useServices();
  const { state } = useStore();
  const [keys, setKeys] = useState(">");
  const [history, setHistory] = useState(false);
  const [decode, setDecode] = useState<api.DecodeOptions>({ value: { codec: "auto" } });
  const [filter, setFilter] = useState<api.Filter>({});
  const problem = keys.trim() === "" ? null : validatePattern(keys.trim());
  const open = useMemo(
    () =>
      problem
        ? null
        : (streamId: string, resume: readonly api.LastPosition[] | null) => {
            const last = resume?.find((p) => p.sequence !== undefined)?.sequence;
            return client.nats.kv.watch(
              { connId, streamId, bucket, keys: keys.trim() || ">", includeHistory: history, fromRevision: last !== undefined ? Number(BigInt(last) + 1n) : null, decode, filter },
              liveTimeout(api.procedures.nats.kv.watch),
            );
          },
    [client, connId, bucket, keys, history, decode, filter, problem],
  );
  const tail = useLiveTail(services, open, note, onLive, active);
  registerActions({ primary: () => tail.start(tail.status === "ended"), stop: tail.stop, pause: tail.pause });
  const check = useCallback((f: api.Filter) => client.messaging.filter.check({ filter: f }), [client]);
  const running = tail.status === "live" || tail.status === "paused";
  const controls = (
    <>
      <div className="flex flex-wrap items-end gap-inline-sm border-b border-border-subtle px-inset-sm py-inset-xs" aria-label="Watch">
        <Field className="w-auto" invalid={problem !== null}>
          <FieldLabel>Keys</FieldLabel>
          <Input size="small" className="font-mono" value={keys} onValueChange={setKeys} placeholder=">" disabled={running} autoComplete="off" spellCheck={false} />
        </Field>
        <Field className="w-auto">
          <FieldLabel>
            <Switch checked={history} onCheckedChange={setHistory} disabled={running} /> History first
          </FieldLabel>
        </Field>
        <CodecMenu label="Value codec" value={decode.value ?? { codec: "auto" }} onChange={(value) => setDecode((d) => ({ ...d, value }))} schemas={decoding.choices} onManage={decoding.onManage} />
        <span className="flex-1" />
        <Button size="small" appearance="primary" disabled={problem !== null || running} onClick={() => tail.start()}>
          <Icon icon={Play} /> Watch
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="px-inset-sm py-inset-xs text-caption-1 text-danger-fg">
          Keys: {problem}
        </p>
      ) : null}
      <FilterBar system="kv" applied={filter} onApply={setFilter} check={check} />
    </>
  );
  return <MessageViewer system="kv" tail={tail} maxMessages={state.settings.liveBuffer} controls={controls} onLoadFull={null} {...(decoding.decodeAs ? { decodeAs: decoding.decodeAs } : {})} />;
}

export function KvTab({ tab, profile, connId, client, useTabActions, onLive, note, openTab, navigate, updateProfile, active }: TabProps) {
  const bucket = text(tab.params["bucket"]);
  const place = useCallback(() => bucketPlace(bucket), [bucket]);
  const decoding = useViewDecoding({ client, connId, profile, updateProfile, openTab }, place);
  const notify = useContext(NoticeContext);
  const [info, setInfo] = useState<api.NatsKvBucketInfo | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  // Tabs saved before the routes kept the view as `section`.
  const [section, setSection] = useTabView({ tab, navigate }, KV_VIEWS, viewOf({ view: tab.params["section"] }, KV_VIEWS, "keys"));
  const [refreshKey, setRefreshKey] = useState(0);
  const [put, setPut] = useState<{ key?: string; revision?: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const action = useAction(note);
  const live = useRef<{ primary?: () => void; stop?: () => void; pause?: () => void }>({});
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (connId === null || bucket === "") return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const i = await client.nats.kv.buckets.info({ connId, bucket });
      if (mine === generation.current) setInfo(i);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, bucket, note]);
  useEffect(() => {
    void load();
  }, [load]);
  const refresh = () => {
    void load();
    setRefreshKey((k) => k + 1);
  };
  useTabActions({ refresh, primary: () => (section === "watch" ? live.current.primary?.() : setPut({})), stop: () => live.current.stop?.(), pause: () => live.current.pause?.() });
  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const subtitle = info
    ? [profile.name, `${formatCount(info.values)} ${info.values === 1 ? "entry" : "entries"}`, `history ${info.history}`, info.ttlMs !== undefined ? `TTL ${formatDuration(info.ttlMs)}` : "no TTL", `${info.storage}, ${info.replicas} ${info.replicas === 1 ? "replica" : "replicas"}`, formatSize(info.bytes)].join(" · ")
    : profile.name;
  return (
    <Page>
      <PageHeader
        title={bucket}
        adornment={
          <>
            <CopyButton value={bucket} what="bucket name" />
            <Badge appearance="tint" variant="neutral">
              KV
            </Badge>
            {info?.mirror ? (
              <Badge appearance="tint" variant="info">
                mirror of {info.mirror}
              </Badge>
            ) : null}
          </>
        }
        subtitle={subtitle}
        actions={
          <>
            <Button appearance="subtle" onClick={refresh} loading={loading}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="primary" onClick={() => setPut({})} disabled={!info}>
              <Icon icon={Add} /> Put key
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton appearance="subtle" aria-label="More: Delete bucket" disabled={!info} />}>
                <Icon icon={MoreHorizontal} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setTyped("");
                    setDeleting(true);
                  }}
                >
                  <Icon icon={Delete} /> Delete bucket…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {error ? (
        <div className="px-inset-lg py-inset-md">
          <ErrorState error={error} onRetry={() => void load()} />
        </div>
      ) : null}
      {info ? (
        <Tabs value={section} onValueChange={(v) => setSection(v as "keys" | "watch")} className="mt-stack-md flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Bucket views" className="gap-inline-xs px-inset-lg [&_[data-slot=tabs-trigger]]:h-control-lg [&_[data-slot=tabs-trigger]]:px-inline-md [&_[data-slot=tabs-item]:first-child]:-ms-inline-md">
            <TabsTrigger value="keys">Keys</TabsTrigger>
            <TabsTrigger value="watch">Watch</TabsTrigger>
          </TabsList>
          <TabsContent value="keys" className="flex min-h-0 flex-1 flex-col border-t border-border-subtle">
            <KeysView bucket={bucket} profile={profile} connId={connId} client={client} note={note} refreshKey={refreshKey} onPut={(key, revision) => setPut({ ...(key !== undefined ? { key } : {}), ...(revision !== undefined ? { revision } : {}) })} />
          </TabsContent>
          <TabsContent value="watch" keepMounted className="flex min-h-0 flex-1 flex-col border-t border-border-subtle">
            <WatchView
              active={active && section === "watch"}
              bucket={bucket}
              decoding={decoding}
              connId={connId}
              client={client}
              note={note}
              onLive={onLive}
              registerActions={(a) => {
                live.current = a;
              }}
            />
          </TabsContent>
        </Tabs>
      ) : null}
      <KvPutSheet
        open={put !== null}
        onOpenChange={(o) => !o && setPut(null)}
        bucket={bucket}
        {...(put?.key !== undefined ? { initial: { key: put.key, ...(put.revision !== undefined ? { revision: put.revision } : {}) } } : {})}
        profile={profile}
        connId={connId}
        client={client}
        onPut={(key, revision) => {
          notify({ title: `Put ${key} at revision ${revision}`, type: "success" });
          setPut(null);
          refresh();
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={(o) => {
          setDeleting(o);
          action.clear();
        }}
        title={`Delete bucket ${bucket} on ${profile.name}?`}
        description={`Every key and revision of ${bucket} is deleted from every replica. This cannot be undone.`}
        confirm="Delete bucket"
        disabled={typed !== bucket}
        busy={action.busy}
        error={action.error}
        onConfirm={() =>
          void action.run(
            async () => {
              await client.nats.kv.buckets.delete({ connId, bucket });
              notify({ title: `Deleted bucket ${bucket}`, type: "success" });
            },
            () => {
              setDeleting(false);
              setInfo(null);
              setError({ title: `${bucket} was deleted.`, kind: "NotFound" });
              void reloadStreams(connId, client);
              openTab({ kind: "nats.kvs", params: {}, title: "Key-Value" });
            },
          )
        }
      >
        <Field>
          <FieldLabel>Type {bucket} to confirm</FieldLabel>
          <Input value={typed} onValueChange={setTyped} className="font-mono" autoComplete="off" spellCheck={false} placeholder={bucket} />
        </Field>
      </ConfirmDialog>
    </Page>
  );
}
