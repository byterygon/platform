// `nats.object { bucket }` (§6.3 "Object Store", §6.4): the object store's header with Refresh,
// Upload and More (Delete bucket), the object list (name, size, chunks, modified, digest,
// description; a filter on the name) and the selected object's pane: Info (every field the
// metadata holds: chunks and their size, digest, nuid, headers, metadata, a link) with Download
// (progress, cancel) and Delete. Upload is a Sheet with a dropzone: the file goes in parts of
// 4 MiB with the progress per part and Cancel, which purges what was written (objects-io.ts).
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DescriptionList } from "@/components/ui/description-list";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { SearchInput } from "@/components/ui/search-input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MightyClient } from "@/app/client";
import { formatCount } from "@/app/messages";
import { CopyButton, NoticeContext, Page, PageBar, PageHeader, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { describeError } from "@/messaging/compose-helpers";
import { ArrowClockwise, ArrowDownload, ArrowUpload, Delete, Dismiss, MoreHorizontal } from "@/lib/icons";
import type { ProfileRecord } from "@/profiles/record";
import type { DescribedError, TabProps } from "../types";
import { ConfirmDialog, useAction } from "./JetStreamDialogs";
import { formatAgo, formatDuration, formatSize, formatUs } from "./format";
import { MAX_OBJECT_BYTES, downloadObject, fileNameOf, saveBlob, uploadObject, type UploadProgress } from "./objects-io";
import { Fact } from "./parts";
import { reloadStreams } from "./tree-data";

const text = (v: unknown) => (typeof v === "string" ? v : "");

export function objectTitle(params: Record<string, unknown>): string {
  return text(params["bucket"]) || "Object Store";
}

/** "SHA-256=ab12…ef90": enough of a digest to tell two apart. */
export function shortDigest(digest: string | undefined): string {
  if (!digest) return "";
  const [algo, value] = digest.includes("=") ? [digest.slice(0, digest.indexOf("=")), digest.slice(digest.indexOf("=") + 1)] : ["", digest];
  const short = value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
  return algo ? `${algo} ${short}` : short;
}

/** Why an object name cannot be used, or null. */
export function validateObjectName(name: string): string | null {
  if (name.trim() === "") return "A name is required.";
  if (name.trim() !== name) return "No spaces at the start or end.";
  if ([...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return "No control characters.";
  return null;
}

function UploadSheet({ open, onOpenChange, bucket, profile, connId, client, existing, onUploaded }: { open: boolean; onOpenChange(open: boolean): void; bucket: string; profile: ProfileRecord; connId: string; client: MightyClient; existing: ReadonlySet<string>; onUploaded(info: api.NatsObjectInfo): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<{ title: string; field: string | null } | null>(null);
  const [tried, setTried] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setName("");
    setNameTouched(false);
    setDescription("");
    setProgress(null);
    setError(null);
    setTried(false);
  }, [open]);
  const busy = progress !== null;
  const nameProblem = validateObjectName(name);
  const fileProblem = file === null ? "Choose a file or drop one here." : file.size > MAX_OBJECT_BYTES ? "The file is over 1 GiB, the largest upload." : null;
  const close = (o: boolean) => {
    if (!o) abort.current?.abort();
    onOpenChange(o);
  };
  const start = async () => {
    setTried(true);
    if (nameProblem || fileProblem || !file) return;
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setProgress({ part: 0, parts: Math.max(1, Math.ceil(file.size / (4 * 1024 * 1024))), sent: 0, total: file.size });
    try {
      const info = await uploadObject(client, { connId, bucket, name, description, file }, setProgress, controller.signal);
      onUploaded(info);
      onOpenChange(false);
    } catch (e) {
      if (controller.signal.aborted) {
        setError({ title: "Upload cancelled: nothing was kept.", field: null });
      } else {
        const d = describeError(e);
        setError({ title: d.title, field: d.field ?? null });
      }
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };
  const showName = (tried || nameTouched) && nameProblem ? nameProblem : error?.field === "name" ? error.title : null;
  return (
    <Sheet open={open} onOpenChange={close} size="md">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Upload to {bucket}</SheetTitle>
          <SheetDescription>{profile.name} · in parts of 4 MiB, up to 1 GiB</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="upload-form"
            aria-label="Upload an object"
            className="flex flex-col gap-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <Field invalid={tried && fileProblem !== null}>
              <FieldLabel>File</FieldLabel>
              <FileInput
                variant="dropzone"
                disabled={busy}
                onFilesChange={(files) => {
                  const f = files[0] ?? null;
                  setFile(f);
                  if (f && !nameTouched) setName(f.name);
                }}
              />
              {file ? <FieldDescription>{formatSize(file.size)}</FieldDescription> : null}
              {tried && fileProblem ? <FieldError match>{fileProblem}</FieldError> : null}
            </Field>
            <Field invalid={showName !== null}>
              <FieldLabel>Object name</FieldLabel>
              <Input
                value={name}
                onValueChange={(v) => {
                  setName(v);
                  setNameTouched(true);
                }}
                disabled={busy}
                placeholder="reports/2026-q3.pdf"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              {existing.has(name) ? <FieldDescription>An object by this name exists: the upload replaces it once every part is in.</FieldDescription> : null}
              {showName ? <FieldError match>{showName}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Input value={description} onValueChange={setDescription} disabled={busy} autoComplete="off" />
            </Field>
          </form>
          {progress ? (
            <div className="mt-stack-md flex flex-col gap-stack-xs">
              <Progress label={`Part ${Math.min(progress.part + 1, progress.parts)} of ${progress.parts}`} value={progress.total === 0 ? null : (progress.sent / progress.total) * 100} showValue />
              <p className="text-caption-1 tabular-nums text-fg-muted">
                {formatSize(progress.sent)} of {formatSize(progress.total)} stored
              </p>
            </div>
          ) : null}
          {error && error.field !== "name" ? (
            <p role="alert" className="mt-stack-md text-body-1 text-danger-fg">
              {error.title}
            </p>
          ) : null}
        </SheetBody>
        <SheetFooter>
          {busy ? (
            <Button onClick={() => abort.current?.abort()}>
              <Icon icon={Dismiss} /> Cancel upload
            </Button>
          ) : (
            <Button onClick={() => close(false)}>Cancel</Button>
          )}
          <Button appearance="primary" type="submit" form="upload-form" loading={busy}>
            <Icon icon={ArrowUpload} /> Upload
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function ObjectPane({ bucket, object, profile, connId, client, note, onDeleted }: { bucket: string; object: api.NatsObjectInfo; profile: ProfileRecord; connId: string; client: MightyClient; note(e: unknown): DescribedError; onDeleted(): void }) {
  const notify = useContext(NoticeContext);
  const [deleting, setDeleting] = useState(false);
  const [received, setReceived] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState<DescribedError | null>(null);
  const abort = useRef<AbortController | null>(null);
  const action = useAction(note);
  useEffect(() => () => abort.current?.abort(), []);
  const download = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setDownloadError(null);
    setReceived(0);
    try {
      const { blob, summary } = await downloadObject(client, { connId, bucket, name: object.name }, setReceived, controller.signal);
      saveBlob(blob, fileNameOf(object.name));
      notify({ title: `Downloaded ${object.name}`, description: formatSize(summary.size), type: "success" });
    } catch (e) {
      if (!controller.signal.aborted) setDownloadError(note(e));
    } finally {
      abort.current = null;
      setReceived(null);
    }
  };
  const link = object.link;
  return (
    <aside aria-label={`Object ${object.name}`} className="flex w-panel-md shrink-0 flex-col gap-stack-sm overflow-auto border-s border-border-subtle px-inset-lg py-inset-md">
      <div className="flex items-center gap-inline-sm">
        <h3 className="min-w-0 truncate font-mono text-body-1-strong text-fg">{object.name}</h3>
        <CopyButton value={object.name} what="object name" />
      </div>
      <p className="text-caption-1 text-fg-muted">
        {formatSize(object.size)} · {formatCount(object.chunks)} {object.chunks === 1 ? "chunk" : "chunks"} · modified {formatAgo(object.modifiedUs)}
      </p>
      <div className="flex flex-wrap gap-inline-sm">
        {received === null ? (
          <Button size="small" appearance="primary" onClick={() => void download()} disabled={link !== undefined && link.name === undefined}>
            <Icon icon={ArrowDownload} /> Download
          </Button>
        ) : (
          <Button size="small" onClick={() => abort.current?.abort()}>
            <Icon icon={Dismiss} /> Cancel download
          </Button>
        )}
        <Button size="small" appearance="subtle" onClick={() => setDeleting(true)} disabled={received !== null}>
          <Icon icon={Delete} /> Delete…
        </Button>
      </div>
      {received !== null ? <Progress label="Downloading" value={object.size > 0 ? (received / object.size) * 100 : null} showValue /> : null}
      {downloadError ? <ErrorState error={downloadError} onRetry={() => void download()} /> : null}
      <DescriptionList aria-label="Info">
        <Fact term="Size">{`${formatSize(object.size)} (${formatCount(object.size)} bytes)`}</Fact>
        <Fact term="Chunks">{`${formatCount(object.chunks)}${object.chunkSize ? ` of up to ${formatSize(object.chunkSize)}` : ""}`}</Fact>
        <Fact term="Modified">{formatUs(object.modifiedUs)}</Fact>
        {object.description ? <Fact term="Description">{object.description}</Fact> : null}
        <Fact term="Digest">
          <span className="break-all font-mono">{object.digest ?? "none"}</span>
        </Fact>
        <Fact term="NUID">
          <span className="font-mono">{object.nuid}</span>
        </Fact>
        {link ? <Fact term="Link">{link.name ? `${link.bucket} / ${link.name}` : `the whole bucket ${link.bucket}`}</Fact> : null}
      </DescriptionList>
      <section aria-label="Headers" className="flex flex-col gap-stack-xs">
        <h4 className="text-body-1-strong text-fg">Headers</h4>
        {object.headers.length === 0 ? (
          <p className="text-body-1 text-fg-muted">No headers.</p>
        ) : (
          <Table aria-label="Object headers" size="small">
            <TableBody>
              {object.headers.map((h, i) => (
                <TableRow key={`${h.name}:${i}`}>
                  <TableCell className="font-mono">{h.name}</TableCell>
                  <TableCell className="break-all font-mono text-fg-muted">{h.value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      {Object.keys(object.metadata).length > 0 ? (
        <section aria-label="Metadata" className="flex flex-col gap-stack-xs">
          <h4 className="text-body-1-strong text-fg">Metadata</h4>
          <Table aria-label="Object metadata" size="small">
            <TableBody>
              {Object.entries(object.metadata).map(([k, v]) => (
                <TableRow key={k}>
                  <TableCell className="font-mono">{k}</TableCell>
                  <TableCell className="break-all font-mono text-fg-muted">{v}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={(o) => {
          setDeleting(o);
          action.clear();
        }}
        title={`Delete ${object.name} from ${bucket} on ${profile.name}?`}
        description={`Its ${formatSize(object.size)} in ${formatCount(object.chunks)} ${object.chunks === 1 ? "chunk" : "chunks"} are purged. This cannot be undone.`}
        confirm="Delete object"
        disabled={false}
        busy={action.busy}
        error={action.error}
        onConfirm={() =>
          void action.run(
            async () => {
              await client.nats.obj.delete({ connId, bucket, name: object.name });
              notify({ title: `Deleted ${object.name}`, type: "success" });
            },
            () => {
              setDeleting(false);
              onDeleted();
            },
          )
        }
      />
    </aside>
  );
}

export function ObjectTab({ tab, profile, connId, client, useTabActions, note, openTab }: TabProps) {
  const bucket = text(tab.params["bucket"]);
  const notify = useContext(NoticeContext);
  const [info, setInfo] = useState<api.NatsObjBucketInfo | null>(null);
  const [list, setList] = useState<api.NatsObjListOutput | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const action = useAction(note);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (connId === null || bucket === "") return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const [i, l] = await Promise.all([client.nats.obj.buckets.info({ connId, bucket }), client.nats.obj.list({ connId, bucket })]);
      if (mine !== generation.current) return;
      setInfo(i);
      setList(l);
      setSelected((s) => (s !== null && l.objects.some((o) => o.name === s) ? s : (l.objects[0]?.name ?? null)));
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, bucket, note]);
  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({ refresh: () => void load(), primary: () => setUploading(true) });
  const objects = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (list?.objects ?? []).filter((o) => f === "" || o.name.toLowerCase().includes(f));
  }, [list, filter]);
  const names = useMemo(() => new Set((list?.objects ?? []).map((o) => o.name)), [list]);
  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const total = (list?.objects ?? []).reduce((n, o) => n + o.size, 0);
  const subtitle = info
    ? [profile.name, list ? `${formatCount(list.objects.length)} ${list.objects.length === 1 ? "object" : "objects"} (${formatSize(total)})` : null, info.ttlMs !== undefined ? `TTL ${formatDuration(info.ttlMs)}` : "no TTL", `${info.storage}, ${info.replicas} ${info.replicas === 1 ? "replica" : "replicas"}`, `${formatSize(info.bytes)} stored`].filter(Boolean).join(" · ")
    : profile.name;
  const current = list?.objects.find((o) => o.name === selected) ?? null;
  return (
    <Page>
      <PageHeader
        title={bucket}
        adornment={
          <>
            <CopyButton value={bucket} what="bucket name" />
            <Badge appearance="tint" variant="neutral">
              Object Store
            </Badge>
            {info?.sealed ? (
              <Badge appearance="tint" variant="warning">
                sealed
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
            <Button appearance="primary" onClick={() => setUploading(true)} disabled={!info || info.sealed}>
              <Icon icon={ArrowUpload} /> Upload
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
      {info && info.description ? <p className="px-inset-lg text-body-1 text-fg-muted">{info.description}</p> : null}
      {info ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <PageBar aria-label="Objects filter">
            <SearchInput aria-label="Filter objects" value={filter} onValueChange={setFilter} placeholder="Filter by name" className="max-w-panel-md flex-1 font-mono" />
          </PageBar>
          {list?.truncated ? <p className="px-inset-lg py-inset-xs text-body-1 text-warning-fg">The first {formatCount(list.objects.length)} objects are shown.</p> : null}
          <div className="mt-stack-sm flex min-h-0 flex-1 border-t border-border-subtle">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
              {list === null && !error ? <LoadingRows label="Loading the objects" /> : null}
              {list !== null && objects.length === 0 ? (
                <EmptyLine action={filter.trim() ? undefined : <Button onClick={() => setUploading(true)}>Upload</Button>}>{filter.trim() ? `No object name has ${filter.trim()}.` : "No objects in this bucket."}</EmptyLine>
              ) : null}
              {objects.length > 0 ? (
                <Table aria-label="Objects" size="small" className={gutterTable}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead align="end">Size</TableHead>
                      <TableHead align="end">Chunks</TableHead>
                      <TableHead>Modified</TableHead>
                      <TableHead>Digest</TableHead>
                      <TableHead>Description</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {objects.map((o) => (
                      <TableRow key={o.name} selected={o.name === selected}>
                        <TableCell>
                          <button type="button" onClick={() => setSelected(o.name)} className="cursor-pointer rounded-sm text-start font-mono text-fg-link hover:underline">
                            {o.name}
                          </button>
                          {o.link ? (
                            <Badge appearance="tint" variant="info" className="ms-inline-xs">
                              link
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell align="end" className="tabular-nums">
                          {formatSize(o.size)}
                        </TableCell>
                        <TableCell align="end" className="tabular-nums">
                          {formatCount(o.chunks)}
                        </TableCell>
                        <TableCell>{formatAgo(o.modifiedUs)}</TableCell>
                        <TableCell className="font-mono text-fg-muted">{shortDigest(o.digest)}</TableCell>
                        <TableCell className="max-w-panel-xs truncate text-fg-muted">{o.description ?? ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}
            </div>
            {current ? (
              <ObjectPane
                key={`${current.name}:${current.nuid}`}
                bucket={bucket}
                object={current}
                profile={profile}
                connId={connId}
                client={client}
                note={note}
                onDeleted={() => {
                  setSelected(null);
                  void load();
                }}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      <UploadSheet
        open={uploading}
        onOpenChange={setUploading}
        bucket={bucket}
        profile={profile}
        connId={connId}
        client={client}
        existing={names}
        onUploaded={(o) => {
          notify({ title: `Uploaded ${o.name}`, description: `${formatSize(o.size)} in ${formatCount(o.chunks)} ${o.chunks === 1 ? "chunk" : "chunks"}`, type: "success" });
          setSelected(o.name);
          void load();
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={(o) => {
          setDeleting(o);
          action.clear();
        }}
        title={`Delete object store ${bucket} on ${profile.name}?`}
        description={`Every object of ${bucket} is deleted from every replica. This cannot be undone.`}
        confirm="Delete bucket"
        disabled={typed !== bucket}
        busy={action.busy}
        error={action.error}
        onConfirm={() =>
          void action.run(
            async () => {
              await client.nats.obj.buckets.delete({ connId, bucket });
              notify({ title: `Deleted object store ${bucket}`, type: "success" });
            },
            () => {
              setDeleting(false);
              setInfo(null);
              setList(null);
              setError({ title: `${bucket} was deleted.`, kind: "NotFound" });
              void reloadStreams(connId, client);
              openTab({ kind: "nats.objects", params: {}, title: "Object Store" });
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
