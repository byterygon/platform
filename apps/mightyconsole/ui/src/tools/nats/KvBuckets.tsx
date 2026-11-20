// `nats.kvs {}`: the account's KV buckets as a table (`nats.kv.buckets.list`: values, bytes, history,
// TTL, storage), and New bucket (§6.4: history, TTL, max value size, storage, replicas). The tree's
// Key-Value group opens it, as Streams opens the streams (DOC-21 Open question 47).
import { useSheetGuard } from "@/app/leave-guard";
import type { LinkEvent } from "../types";
import { linkTo } from "@/app/tab-view";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { MightyClient } from "@/app/client";
import { parseDuration } from "@/app/duration";
import { Required } from "@/app/form-parts";
import { formatCount } from "@/app/messages";
import { LinkButton, NoticeContext, Page, PageHeader, PageRegion, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type { NatsKvBucketInfo, NatsKvConfig, NatsStorage } from "@/gen/api";
import { describeError } from "@/messaging/compose-helpers";
import { Add, ArrowClockwise } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { DescribedError, TabProps } from "../types";
import { formatAgo, formatDuration, formatSize } from "./format";
import { parseCount, parseSize } from "./stream-form";
import { reloadStreams } from "./tree-data";

export interface BucketDraft {
  bucket: string;
  description: string;
  history: string;
  ttl: string;
  maxValueSize: string;
  maxBytes: string;
  storage: NatsStorage;
  replicas: string;
  compression: boolean;
}

export const EMPTY_BUCKET: BucketDraft = { bucket: "", description: "", history: "1", ttl: "", maxValueSize: "", maxBytes: "", storage: "file", replicas: "1", compression: false };

const BUCKET = /^[A-Za-z0-9_-]+$/;

export function bucketErrors(d: BucketDraft): Partial<Record<keyof BucketDraft, string>> {
  const out: Partial<Record<keyof BucketDraft, string>> = {};
  if (d.bucket.trim() === "") out.bucket = "A bucket name is required.";
  else if (!BUCKET.test(d.bucket.trim())) out.bucket = "Letters, digits, _ and - only.";
  const h = parseCount(d.history);
  if (h === null || Number.isNaN(h) || h < 1 || h > 64) out.history = "1 to 64 revisions per key.";
  const ttl = parseDuration(d.ttl);
  if (ttl === "invalid" || ttl === 0) out.ttl = "A duration such as 1h or 7d, or empty for none.";
  for (const f of ["maxValueSize", "maxBytes"] as const) {
    const n = parseSize(d[f]);
    if (n !== null && (Number.isNaN(n) || n <= 0)) out[f] = "A size such as 1 MiB, or empty for no limit.";
  }
  const r = parseCount(d.replicas);
  if (r === null || Number.isNaN(r) || r < 1 || r > 5) out.replicas = "1 to 5.";
  return out;
}

export function bucketConfigOf(d: BucketDraft): NatsKvConfig {
  const ttl = parseDuration(d.ttl);
  const size = (t: string) => {
    const n = parseSize(t);
    return n === null || Number.isNaN(n) ? null : n;
  };
  return {
    bucket: d.bucket.trim(),
    description: d.description.trim() || null,
    history: parseCount(d.history) ?? 1,
    ttlMs: typeof ttl === "number" ? ttl : null,
    maxValueSize: size(d.maxValueSize),
    maxBytes: size(d.maxBytes),
    storage: d.storage,
    replicas: parseCount(d.replicas) ?? 1,
    compression: d.compression,
  };
}

export function BucketSheet({ open, onOpenChange, profileName, connId, client, onCreated }: { open: boolean; onOpenChange(open: boolean): void; profileName: string; connId: string; client: MightyClient; onCreated(info: NatsKvBucketInfo): void }) {
  const [d, setD] = useState<BucketDraft>(EMPTY_BUCKET);
  const releaseGuard = useSheetGuard(open, d);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<{ title: string; field: string | null } | null>(null);
  useEffect(() => {
    if (!open) return;
    setD(EMPTY_BUCKET);
    setTried(false);
    setServer(null);
  }, [open]);
  const set = (patch: Partial<BucketDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setServer(null);
  };
  const errors = bucketErrors(d);
  const map: Record<string, keyof BucketDraft> = { ttlMs: "ttl" };
  const errorOf = (f: keyof BucketDraft): string | null => (server && (map[server.field ?? ""] ?? server.field) === f ? server.title : tried ? (errors[f] ?? null) : null);
  const save = async () => {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    try {
      const info = await client.nats.kv.buckets.create({ connId, config: bucketConfigOf(d) });
      releaseGuard();
      onCreated(info);
      onOpenChange(false);
    } catch (e) {
      const err = describeError(e);
      setServer({ title: err.title, field: err.field ?? null });
    } finally {
      setBusy(false);
    }
  };
  const text = (f: keyof BucketDraft, label: string, placeholder: string, description?: string, required = false) => (
    <Field invalid={errorOf(f) !== null}>
      <FieldLabel>
        {label}
        {required ? <Required /> : null}
      </FieldLabel>
      <Input value={d[f] as string} onValueChange={(v) => set({ [f]: v } as Partial<BucketDraft>)} placeholder={placeholder} autoComplete="off" spellCheck={false} className="font-mono" />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {errorOf(f) ? <FieldError match>{errorOf(f)}</FieldError> : null}
    </Field>
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="md">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New KV bucket</SheetTitle>
          <SheetDescription>{profileName}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="bucket-form"
            aria-label="New KV bucket"
            className="flex flex-col gap-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {text("bucket", "Bucket", "config", undefined, true)}
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Input value={d.description} onValueChange={(description) => set({ description })} autoComplete="off" />
            </Field>
            <div className="grid grid-cols-2 gap-inline-md">
              {text("history", "History", "1", "Revisions kept per key, 1 to 64.")}
              {text("ttl", "TTL", "None", "Entries older than this go, such as 24h.")}
              {text("maxValueSize", "Max value size", "No limit")}
              {text("maxBytes", "Max bytes", "No limit")}
              {text("replicas", "Replicas", "1")}
              <Field>
                <FieldLabel>Storage</FieldLabel>
                <ToggleGroup aria-label="Storage" value={[d.storage]} onValueChange={(v) => v[0] && set({ storage: v[0] as NatsStorage })}>
                  <ToggleGroupItem value="file">File</ToggleGroupItem>
                  <ToggleGroupItem value="memory">Memory</ToggleGroupItem>
                </ToggleGroup>
              </Field>
            </div>
            <Field>
              <FieldLabel>
                <Switch checked={d.compression} onCheckedChange={(compression) => set({ compression })} /> S2 compression
              </FieldLabel>
              <FieldDescription>File storage only.</FieldDescription>
            </Field>
          </form>
          {server ? (
            <Alert intent="danger" className="mt-stack-md">
              <AlertDescription>
                {server.field ? <strong className="font-mono">{server.field}: </strong> : null}
                {server.title}
              </AlertDescription>
            </Alert>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button appearance="primary" type="submit" form="bucket-form" loading={busy}>
            <Icon icon={Add} /> Create bucket
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function KvBucketsTab({ tab, profile, connId, client, useTabActions, note, openTab, go: goProp }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });

  const notify = useContext(NoticeContext);
  const [buckets, setBuckets] = useState<NatsKvBucketInfo[] | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(tab.params["create"] === true);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const list = await client.nats.kv.buckets.list({ connId });
      if (mine === generation.current) setBuckets(list);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, note]);
  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({ refresh: () => void load(), primary: () => setCreating(true) });
  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const open = (bucket: string, event?: LinkEvent) => go({ kind: "nats.kv", params: { bucket }, title: bucket }, event);
  return (
    <Page>
      <PageHeader
        title="Key-Value"
        subtitle={[profile.name, buckets ? `${buckets.length} ${buckets.length === 1 ? "bucket" : "buckets"}` : null].filter(Boolean).join(" · ")}
        actions={
          <>
            <Button appearance="subtle" onClick={() => void load()} loading={loading}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="primary" onClick={() => setCreating(true)}>
              <Icon icon={Add} /> New bucket
            </Button>
          </>
        }
      />
      <PageRegion className="mt-stack-md">
        {error ? (
          <div className="px-inset-lg">
            <ErrorState error={error} onRetry={() => void load()} />
          </div>
        ) : null}
        {buckets === null && loading ? <LoadingRows label="Loading the buckets" /> : null}
        {buckets !== null && buckets.length === 0 && !error ? <EmptyLine action={<Button onClick={() => setCreating(true)}>New bucket</Button>}>No KV buckets on this account yet.</EmptyLine> : null}
        {buckets !== null && buckets.length > 0 ? (
          <Table aria-label="Buckets" className={cn("min-h-0 flex-1", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Bucket</TableHead>
                <TableHead align="end">Values</TableHead>
                <TableHead align="end">Bytes</TableHead>
                <TableHead align="end">History</TableHead>
                <TableHead>TTL</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {buckets.map((b) => (
                <TableRow key={b.bucket}>
                  <TableCell>
                    <LinkButton className="font-mono" onOpen={(e) => open(b.bucket, e)}>
                      {b.bucket}
                    </LinkButton>
                  </TableCell>
                  <TableCell align="end" className="tabular-nums">
                    {formatCount(b.values)}
                  </TableCell>
                  <TableCell align="end" className="tabular-nums">
                    {formatSize(b.bytes)}
                  </TableCell>
                  <TableCell align="end" className="tabular-nums">
                    {b.history}
                  </TableCell>
                  <TableCell>{b.ttlMs !== undefined ? formatDuration(b.ttlMs) : "none"}</TableCell>
                  <TableCell>
                    {b.storage}, {b.replicas} {b.replicas === 1 ? "replica" : "replicas"}
                  </TableCell>
                  <TableCell>{formatAgo(b.createdUs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </PageRegion>
      <BucketSheet
        open={creating}
        onOpenChange={setCreating}
        profileName={profile.name}
        connId={connId}
        client={client}
        onCreated={(info) => {
          notify({ title: `Created bucket ${info.bucket}`, type: "success", action: { label: "Open bucket", onClick: () => open(info.bucket) } });
          void load();
          void reloadStreams(connId, client);
        }}
      />
    </Page>
  );
}
