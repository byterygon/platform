// A container's Files, read only (TSK-81 batch 4c, mockup frame docker-files, DOC-21 Open question
// 45 q): a folder at a time from `docker.containers.files.list`, which reads the folder's tar
// headers through `/containers/{id}/archive` (no shell in the image needed, stopped containers
// too). The path bar goes back up; a folder opens, a symlink goes to its target, a file opens in
// the preview beside (text up to 1 MiB in Monaco, read only, with Copy). A file or a folder
// downloads as the .tar Docker makes of it. A listing stops at 2,000 entries or 64 MiB read and
// says so. Nothing is ever written to the container.
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { liveTimeout } from "@/app/client";
import { CopyButton, LinkButton, PageBar, PageFooter, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import * as api from "@/gen/api";
import type { FileEntry, FileKind, FileReadOutput, FilesListOutput } from "@/gen/api";
import { ArrowDownload, Document, Folder, Link } from "@/lib/icons";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import type { DescribedError, TabProps } from "../types";
import { formatBytes, formatCreated } from "./format";

/** `/app/media` + `logo.png`. */
export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** `/app/media/../x/./y` as `/app/x/y`; never above `/`. */
export function normalPath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Where a symlink in `dir` points: its target, absolute or relative to `dir`. */
export function resolveLink(dir: string, target: string): string {
  return normalPath(target.startsWith("/") ? target : `${dir}/${target}`);
}

/** The path bar's steps: `/`, `/app`, `/app/media`. */
export function pathSteps(path: string): { label: string; path: string }[] {
  const parts = normalPath(path).split("/").filter(Boolean);
  return [{ label: "/", path: "/" }, ...parts.map((p, i) => ({ label: p, path: `/${parts.slice(0, i + 1).join("/")}` }))];
}

/** `drwxr-xr-x` from the kind and the permission bits (set-id and sticky bits as `ls` shows them). */
export function modeText(kind: FileKind, mode: number): string {
  const type = kind === "dir" ? "d" : kind === "symlink" ? "l" : kind === "other" ? "?" : "-";
  const bits = ["r", "w", "x", "r", "w", "x", "r", "w", "x"].map((c, i) => ((mode >> (8 - i)) & 1 ? c : "-"));
  const special = (at: number, bit: number, set: string, unset: string) => {
    if (mode & bit) bits[at] = bits[at] === "x" ? set : unset;
  };
  special(2, 0o4000, "s", "S");
  special(5, 0o2000, "s", "S");
  special(8, 0o1000, "t", "T");
  return type + bits.join("");
}

/** The Monaco language of a preview by the file's name. */
export function previewLanguage(name: string): "json" | "yaml" | "plaintext" {
  if (/\.json$/i.test(name)) return "json";
  if (/\.ya?ml$/i.test(name)) return "yaml";
  return "plaintext";
}

const baseName = (path: string) => (path === "/" ? "root" : (path.split("/").filter(Boolean).pop() ?? "root"));

export interface FilesPanelProps extends Pick<TabProps, "client" | "connId" | "note" | "useTabActions"> {
  container: string;
}

type Preview = { path: string; entry: FileEntry } & ({ state: "loading" } | { state: "ready"; out: FileReadOutput } | { state: "error"; error: DescribedError });

export function FilesPanel({ client, connId, note, useTabActions, container }: FilesPanelProps) {
  const [path, setPath] = useState("/");
  const [list, setList] = useState<FilesListOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [downloading, setDownloading] = useState<{ path: string; bytes: number; cancel(): void } | null>(null);
  const generation = useRef(0);
  const pathRef = useRef(path);
  pathRef.current = path;

  const show = useCallback(
    async (file: string, entry: FileEntry) => {
      if (connId === null) return;
      setPreview({ path: file, entry, state: "loading" });
      try {
        const out = await client.docker.containers.files.read({ connId, id: container, path: file });
        setPreview((p) => (p?.path === file ? { path: file, entry, state: "ready", out } : p));
      } catch (e) {
        const d = note(e);
        setPreview((p) => (p?.path === file ? { path: file, entry, state: "error", error: d } : p));
      }
    },
    [client, connId, container, note],
  );

  const open = useCallback(
    async (next: string) => {
      if (connId === null) return;
      const mine = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const out = await client.docker.containers.files.list({ connId, id: container, path: next });
        if (mine !== generation.current) return;
        // A symlink to a folder lists the folder; to a file, the file opens beside the parent.
        if (out.kind === "symlink" && out.linkTarget) {
          const parent = normalPath(`${next}/..`);
          void open(resolveLink(parent, out.linkTarget));
          return;
        }
        if (out.kind !== "dir") {
          const parent = normalPath(`${next}/..`);
          if (parent !== pathRef.current) void open(parent);
          const name = baseName(next);
          void show(next, { name, kind: out.kind, size: 0, mode: 0, mtimeMs: 0 });
          return;
        }
        setPath(out.path);
        setList(out);
      } catch (e) {
        if (mine === generation.current) setError(note(e));
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [client, connId, container, note, show],
  );

  useEffect(() => {
    setPreview(null);
    void open("/");
  }, [open]);
  useTabActions({ refresh: () => void open(path) });

  const download = async (target: string) => {
    if (connId === null) return;
    const call = client.docker.containers.files.download({ connId, id: container, path: target, streamId: crypto.randomUUID() }, liveTimeout(api.procedures.docker.containers.files.download));
    let cancelled = false;
    setDownloading({
      path: target,
      bytes: 0,
      cancel: () => {
        cancelled = true;
        call.cancel();
      },
    });
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of call.chunks()) {
        parts.push(chunk);
        bytes += chunk.byteLength;
        setDownloading((d) => (d ? { ...d, bytes } : d));
      }
      await call.result;
      const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: "application/x-tar" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName(target)}.tar`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (!cancelled) setError(note(e));
    } finally {
      setDownloading(null);
    }
  };

  const entries = list?.entries ?? [];
  const activate = (entry: FileEntry) => {
    const full = joinPath(path, entry.name);
    if (entry.kind === "dir") {
      setPreview(null);
      void open(full);
    } else if (entry.kind === "symlink" && entry.linkTarget) void open(resolveLink(path, entry.linkTarget));
    else void show(full, entry);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar aria-label="Path" className="pb-stack-sm">
        <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-inline-xs font-mono text-code">
          {pathSteps(path).map((step, i, all) => (
            <span key={step.path} className="flex items-center gap-inline-xs">
              {i > 1 ? <span className="text-fg-muted">/</span> : null}
              {i === all.length - 1 ? (
                <span aria-current="location" className="text-fg">
                  {step.label}
                </span>
              ) : (
                <LinkButton
                  className="font-mono text-code"
                  onClick={() => {
                    setPreview(null);
                    void open(step.path);
                  }}
                >
                  {step.label}
                </LinkButton>
              )}
            </span>
          ))}
        </nav>
        <CopyButton value={path} what="path" />
        <span className="flex-1" />
        <span className="text-body-1 text-fg-muted">Read only</span>
        {downloading ? (
          <Button appearance="subtle" size="small" onClick={downloading.cancel}>
            Cancel download ({formatBytes(downloading.bytes)})
          </Button>
        ) : (
          <Button appearance="secondary" size="small" disabled={list === null} onClick={() => void download(path)}>
            <Icon icon={ArrowDownload} /> Download folder (.tar)
          </Button>
        )}
      </PageBar>
      <div className="flex min-h-0 flex-1 border-t border-border-subtle">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error ? (
            <div className="px-inset-lg pt-stack-md">
              <ErrorState error={error} onRetry={() => void open(path)} />
            </div>
          ) : null}
          {loading && list === null ? <LoadingRows label="Reading the folder" /> : null}
          {list !== null && entries.length === 0 && !error ? <EmptyLine>An empty folder.</EmptyLine> : null}
          {entries.length > 0 ? (
            <Table aria-label="Files" size="small" className={cn("min-h-0 flex-1", gutterTable)}>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead align="end">Size</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Modified</TableHead>
                  <TableHead align="end">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => {
                  const full = joinPath(path, entry.name);
                  const picked = preview?.path === full;
                  return (
                    <TableRow key={entry.name} selected={picked}>
                      <TableCell className="max-w-panel-sm">
                        <button type="button" className={cn("flex min-w-0 items-center gap-inline-sm rounded-sm text-start text-fg hover:underline", focusRing)} onClick={() => activate(entry)}>
                          <Icon icon={entry.kind === "dir" ? Folder : entry.kind === "symlink" ? Link : Document} className="shrink-0 text-fg-muted" />
                          <span className="truncate">{entry.name}</span>
                          {entry.linkTarget ? <span className="truncate font-mono text-code text-fg-muted">→ {entry.linkTarget}</span> : null}
                        </button>
                      </TableCell>
                      <TableCell align="end" className="whitespace-nowrap tabular-nums">
                        {entry.kind === "dir" ? <span className="text-fg-muted">—</span> : formatBytes(entry.size)}
                      </TableCell>
                      <TableCell className="font-mono text-code text-fg-muted">{modeText(entry.kind, entry.mode)}</TableCell>
                      <TableCell className="whitespace-nowrap text-fg-muted">{formatCreated(entry.mtimeMs / 1000)}</TableCell>
                      <TableCell align="end">
                        {entry.kind === "file" ? (
                          <IconButton size="small" appearance="subtle" aria-label={`Download ${entry.name}`} title={`Download ${entry.name} (.tar)`} disabled={downloading !== null} onClick={() => void download(full)}>
                            <Icon icon={ArrowDownload} />
                          </IconButton>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : null}
          <PageFooter>
            <span className="shrink-0">
              {list ? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}` : ""}
              {list?.truncated === "entries" ? " · stopped at 2,000 entries" : list?.truncated === "bytes" ? " · stopped after reading 64 MiB (the folder holds large files): download it to see everything" : ""}
            </span>
            <span className="flex-1" />
            <span className="truncate" title="Listed from the tar Docker makes of the folder (GET /containers/{id}/archive): no shell in the image is needed, and stopped containers work too">
              From the folder's tar: no shell needed, stopped containers too
            </span>
          </PageFooter>
        </div>
        {preview ? (
          <aside aria-label={`Preview of ${preview.entry.name}`} className="flex w-panel-pane max-w-1/2 min-w-0 shrink-0 flex-col gap-stack-sm overflow-auto border-s border-border-subtle px-inset-md py-inset-md">
            <div className="flex flex-col gap-stack-xs">
              <h3 className="truncate text-body-1-strong text-fg">{preview.entry.name}</h3>
              <p className="text-caption-1 text-fg-muted">
                {preview.state === "ready"
                  ? `${formatBytes(preview.out.size)} · ${preview.out.text !== undefined ? "text" : preview.out.tooLarge ? "larger than 1 MiB" : "binary"}`
                  : preview.state === "loading"
                    ? "Reading…"
                    : ""}
              </p>
            </div>
            {preview.state === "error" ? <ErrorState error={preview.error} onRetry={() => void show(preview.path, preview.entry)} /> : null}
            {preview.state === "ready" && preview.out.text !== undefined ? (
              <CodeEditor aria-label={`${preview.entry.name}, read only`} language={previewLanguage(preview.entry.name)} value={preview.out.text} readOnly lineNumbers rows={20} />
            ) : null}
            {preview.state === "ready" && preview.out.text === undefined ? (
              <p className="text-body-1 text-fg-muted">{preview.out.tooLarge ? "Larger than 1 MiB: download it to read it." : "Not text: download it to open it."}</p>
            ) : null}
            <div className="flex items-center gap-inline-md">
              <Button appearance="secondary" size="small" disabled={downloading !== null} onClick={() => void download(preview.path)}>
                <Icon icon={ArrowDownload} /> Download (.tar)
              </Button>
              {preview.state === "ready" && preview.out.text !== undefined ? <CopyButton value={preview.out.text} what="text" /> : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
