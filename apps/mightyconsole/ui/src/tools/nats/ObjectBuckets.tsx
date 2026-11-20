// `nats.objects {}`: the account's object stores as a table (`nats.obj.buckets.list`: bytes, TTL,
// storage, sealed), and New object store (§6.4: description, TTL, max bytes, storage, replicas,
// compression). The tree's Object Store group opens it, as Key-Value opens the KV buckets.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { MightyClient } from "@/app/client";
import { useSheetGuard } from "@/app/leave-guard";
import { linkTo } from "@/app/tab-view";
import { parseDuration } from "@/app/duration";
import { Required } from "@/app/form-parts";
import { LinkButton, NoticeContext, Page, PageHeader, PageRegion, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type { NatsObjBucketInfo, NatsObjConfig, NatsStorage } from "@/gen/api";
import { describeError } from "@/messaging/compose-helpers";
import { Add, ArrowClockwise } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { DescribedError, TabProps, LinkEvent } from "../types";
import { formatAgo, formatDuration, formatSize } from "./format";
import { parseCount, parseSize } from "./stream-form";
import { reloadStreams } from "./tree-data";

export interface ObjectStoreDraft {
  bucket: string;
  description: string;
  ttl: string;
  maxBytes: string;
  storage: NatsStorage;
  replicas: string;
  compression: boolean;
}

export const EMPTY_OBJECT_STORE: ObjectStoreDraft = { bucket: "", description: "", ttl: "", maxBytes: "", storage: "file", replicas: "1", compression: false };

const BUCKET = /^[A-Za-z0-9_-]+$/;

export function objectStoreErrors(d: ObjectStoreDraft): Partial<Record<keyof ObjectStoreDraft, string>> {
  const out: Partial<Record<keyof ObjectStoreDraft, string>> = {};
  if (d.bucket.trim() === "") out.bucket = "A bucket name is required.";
  else if (!BUCKET.test(d.bucket.trim())) out.bucket = "Letters, digits, _ and - only.";
  const ttl = parseDuration(d.ttl);
  if (ttl === "invalid" || ttl === 0) out.ttl = "A duration such as 1h or 7d, or empty for none.";
  const n = parseSize(d.maxBytes);
  if (n !== null && (Number.isNaN(n) || n <= 0)) out.maxBytes = "A size such as 10 GiB, or empty for no limit.";
  const r = parseCount(d.replicas);
  if (r === null || Number.isNaN(r) || r < 1 || r > 5) out.replicas = "1 to 5.";
  return out;
}

export function objectStoreConfigOf(d: ObjectStoreDraft): NatsObjConfig {
  const ttl = parseDuration(d.ttl);
  const max = parseSize(d.maxBytes);
  return {
    bucket: d.bucket.trim(),
    description: d.description.trim() || null,
    ttlMs: typeof ttl === "number" ? ttl : null,
    maxBytes: max === null || Number.isNaN(max) ? null : max,
    storage: d.storage,
    replicas: parseCount(d.replicas) ?? 1,
    compression: d.compression,
  };
}

export function ObjectStoreSheet({ open, onOpenChange, profileName, connId, client, onCreated }: { open: boolean; onOpenChange(open: boolean): void; profileName: string; connId: string; client: MightyClient; onCreated(info: NatsObjBucketInfo): void }) {
  const [d, setD] = useState<ObjectStoreDraft>(EMPTY_OBJECT_STORE);
  const releaseGuard = useSheetGuard(open, d);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<{ title: string; field: string | null } | null>(null);
  useEffect(() => {
    if (!open) return;
    setD(EMPTY_OBJECT_STORE);
    setTried(false);
    setServer(null);
  }, [open]);
  const set = (patch: Partial<ObjectStoreDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setServer(null);
  };
  const errors = objectStoreErrors(d);
  const map: Record<string, keyof ObjectStoreDraft> = { ttlMs: "ttl" };
  const errorOf = (f: keyof ObjectStoreDraft): string | null => (server && (map[server.field ?? ""] ?? server.field) === f ? server.title : tried ? (errors[f] ?? null) : null);
  const save = async () => {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    try {
      const info = await client.nats.obj.buckets.create({ connId, config: objectStoreConfigOf(d) });
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
  const text = (f: keyof ObjectStoreDraft, label: string, placeholder: string, description?: string, required = false) => (
    <Field invalid={errorOf(f) !== null}>
      <FieldLabel>
        {label}
        {required ? <Required /> : null}
      </FieldLabel>
      <Input value={d[f] as string} onValueChange={(v) => set({ [f]: v } as Partial<ObjectStoreDraft>)} placeholder={placeholder} autoComplete="off" spellCheck={false} className="font-mono" />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {errorOf(f) ? <FieldError match>{errorOf(f)}</FieldError> : null}
    </Field>
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="md">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New object store</SheetTitle>
          <SheetDescription>{profileName}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="object-store-form"
            aria-label="New object store"
            className="flex flex-col gap-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {text("bucket", "Bucket", "files", undefined, true)}
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Input value={d.description} onValueChange={(description) => set({ description })} autoComplete="off" />
            </Field>
            <div className="grid grid-cols-2 gap-inline-md">
              {text("ttl", "TTL", "None", "Objects older than this go, such as 30d.")}
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
          <Button appearance="primary" type="submit" form="object-store-form" loading={busy}>
            <Icon icon={Add} /> Create object store
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function ObjectBucketsTab({ tab, profile, connId, client, useTabActions, note, openTab, go: goProp }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });
  const notify = useContext(NoticeContext);
  const [buckets, setBuckets] = useState<NatsObjBucketInfo[] | null>(null);
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
      const list = await client.nats.obj.buckets.list({ connId });
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
  const open = (bucket: string, event?: LinkEvent) => go({ kind: "nats.object", params: { bucket }, title: bucket }, event);
  return (
    <Page>
      <PageHeader
        title="Object Store"
        subtitle={[profile.name, buckets ? `${buckets.length} ${buckets.length === 1 ? "bucket" : "buckets"}` : null].filter(Boolean).join(" · ")}
        actions={
          <>
            <Button appearance="subtle" onClick={() => void load()} loading={loading}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="primary" onClick={() => setCreating(true)}>
              <Icon icon={Add} /> New object store
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
        {buckets === null && loading ? <LoadingRows label="Loading the object stores" /> : null}
        {buckets !== null && buckets.length === 0 && !error ? <EmptyLine action={<Button onClick={() => setCreating(true)}>New object store</Button>}>No object stores on this account yet.</EmptyLine> : null}
        {buckets !== null && buckets.length > 0 ? (
          <Table aria-label="Object stores" className={cn("min-h-0 flex-1", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Bucket</TableHead>
                <TableHead>Description</TableHead>
                <TableHead align="end">Bytes</TableHead>
                <TableHead>TTL</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {buckets.map((b) => (
                <TableRow key={b.bucket}>
                  <TableCell>
                    <span className="flex items-center gap-inline-sm">
                      <LinkButton className="font-mono" onOpen={(e) => open(b.bucket, e)}>
                        {b.bucket}
                      </LinkButton>
                      {b.sealed ? (
                        <Badge appearance="tint" variant="warning">
                          sealed
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-fg-muted">{b.description ?? ""}</TableCell>
                  <TableCell align="end" className="tabular-nums">
                    {formatSize(b.bytes)}
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
      <ObjectStoreSheet
        open={creating}
        onOpenChange={setCreating}
        profileName={profile.name}
        connId={connId}
        client={client}
        onCreated={(info) => {
          notify({ title: `Created object store ${info.bucket}`, type: "success", action: { label: "Open bucket", onClick: () => open(info.bucket) } });
          void load();
          void reloadStreams(connId, client);
        }}
      />
    </Page>
  );
}
