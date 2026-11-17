// Threads: search by status and metadata, create, delete; a row opens the thread (spec §11.2).
import { useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/ui/relative-time";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { Toolbar, ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { Add, ArrowClockwise, Delete } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { StatusBadge, parseJson, preview, shortId, useLoad } from "./shared";

const STATUSES = { any: "Any status", idle: "Idle", busy: "Busy", interrupted: "Interrupted", error: "Error" } as const;

export function ThreadsTab({ tab, profile, connId, client, useTabActions, note, openTab }: TabProps) {
  const [status, setStatus] = useState<keyof typeof STATUSES>("any");
  const [metadataText, setMetadataText] = useState("");
  const [applied, setApplied] = useState<{ status: string | null; metadata: api.JsonValue | null }>({ status: null, metadata: null });
  const [deleting, setDeleting] = useState<api.Thread | null>(null);
  const [actionError, setActionError] = useState<DescribedError | null>(null);
  const toast = useToast();
  const metadata = parseJson(metadataText);
  const { data, error, loading, reload } = useLoad(connId ? () => client.langgraph.threads.search({ connId, metadata: applied.metadata, status: applied.status, limit: 50, offset: null }) : null, [connId, applied], note);

  const search = () => {
    if (!metadata.ok) return;
    setApplied({ status: status === "any" ? null : status, metadata: (metadata.value ?? null) as api.JsonValue | null });
  };
  const open = (t: api.Thread) => openTab({ kind: "langgraph.thread", params: { threadId: t.threadId }, title: `Thread ${shortId(t.threadId)} · ${profile.name}` });
  const create = async () => {
    if (!connId) return;
    setActionError(null);
    try {
      const t = await client.langgraph.threads.create({ connId, metadata: null });
      toast.add({ title: `Thread ${shortId(t.threadId)} created`, type: "success" });
      void reload();
      open(t);
    } catch (e) {
      setActionError(note(e));
    }
  };
  const remove = async (t: api.Thread) => {
    if (!connId) return;
    setDeleting(null);
    try {
      await client.langgraph.threads.delete({ connId, threadId: t.threadId });
      toast.add({ title: `Thread ${shortId(t.threadId)} deleted`, type: "success" });
      void reload();
    } catch (e) {
      setActionError(note(e));
    }
  };
  useTabActions({ refresh: () => void reload(), primary: search });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label={`${tab.title} actions`}>
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="primary" />} onClick={() => void create()}>
            <Icon icon={Add} /> New thread
          </ToolbarButton>
          <ToolbarButton render={<Button appearance="subtle" loading={loading} />} onClick={() => void reload()}>
            <Icon icon={ArrowClockwise} /> Refresh
          </ToolbarButton>
        </ToolbarGroup>
      </Toolbar>
      <form
        className="flex flex-wrap items-end gap-inline-sm p-inset-sm"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <Select aria-label="Status" value={status} onValueChange={(v) => setStatus(v as keyof typeof STATUSES)} items={STATUSES} className="w-panel-xs">
          {Object.entries(STATUSES).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </Select>
        <Input aria-label="Metadata (JSON)" aria-invalid={!metadata.ok || undefined} placeholder='Metadata, e.g. {"user": "ana"}' value={metadataText} onValueChange={setMetadataText} className="min-w-panel-xs flex-1 font-mono" />
        <Button type="submit" disabled={!metadata.ok}>
          Search
        </Button>
      </form>
      {!metadata.ok ? <p className="px-inset-sm text-caption-1 text-danger-fg">Metadata is not valid JSON: {metadata.message}</p> : null}
      {actionError ? <ErrorState error={actionError} onRetry={() => setActionError(null)} /> : null}
      {error ? <ErrorState error={error} onRetry={() => void reload()} onRefresh={() => void reload()} /> : null}
      {loading && data === null ? <LoadingRows label="Loading threads" /> : null}
      {data !== null && data.length === 0 ? (
        <EmptyLine
          action={
            <Button size="small" onClick={() => void create()}>
              New thread
            </Button>
          }
        >
          No threads.
        </EmptyLine>
      ) : null}
      {data && data.length > 0 ? (
        <Table aria-label="Threads" className="min-h-0 flex-1">
          <TableHeader>
            <TableRow>
              <TableHead>Thread</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>Metadata</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((t) => (
              <TableRow key={t.threadId} onDoubleClick={() => open(t)}>
                <TableCell>
                  <Button appearance="transparent" size="small" className="font-mono" onClick={() => open(t)} title={t.threadId}>
                    {shortId(t.threadId)}
                  </Button>
                </TableCell>
                <TableCell>
                  <StatusBadge status={t.status} />
                </TableCell>
                <TableCell>{t.createdAt ? <RelativeTime date={t.createdAt} /> : null}</TableCell>
                <TableCell>{t.updatedAt ? <RelativeTime date={t.updatedAt} /> : null}</TableCell>
                <TableCell className="max-w-panel-sm truncate font-mono text-code" title={preview(t.metadata, 2000)}>
                  {preview(t.metadata)}
                </TableCell>
                <TableCell>
                  <IconButton aria-label={`Delete thread ${shortId(t.threadId)}`} size="small" onClick={() => setDeleting(t)}>
                    <Icon icon={Delete} />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete thread {deleting ? shortId(deleting.threadId) : ""} on {profile.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>The thread, its checkpoints and its runs are deleted on the server.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction appearance="danger" onClick={() => deleting && void remove(deleting)}>
              Delete thread
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
