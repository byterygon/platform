// Threads: search by status and metadata, create, delete; a row opens the thread (spec §11.2). Laid
// out by TSK-91: a header with the context and New thread, the filters in one row, the table on the
// layer with copy buttons, paged by offset (Previous, Next; the API has no count).
import type { LinkEvent } from "../types";
import { linkTo } from "@/app/tab-view";
import { useMemo, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { CodeEditor } from "@/components/ui/code-editor";
import { RelativeTime } from "@/components/ui/relative-time";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { CopyButton, Page, PageFooter, PageHeader, PageRegion, Pager, gutterTable, linkHandlers } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { cn } from "@/lib/cn";
import type * as api from "@/gen/api";
import { Add, ArrowClockwise, Delete } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { StatusBadge, parseJson, preview, seenKeysSchema, shortId, useLoad } from "./shared";

/** Threads per page (spec §11.2 lists the latest 50). */
const PAGE = 50;

const STATUSES = { any: "Any status", idle: "Idle", busy: "Busy", interrupted: "Interrupted", error: "Error" } as const;

export function ThreadsTab({ tab, profile, connId, client, useTabActions, note, openTab, go: goProp }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });

  const [status, setStatus] = useState<keyof typeof STATUSES>("any");
  const [metadataText, setMetadataText] = useState("");
  const [applied, setApplied] = useState<{ status: string | null; metadata: api.JsonValue | null }>({ status: null, metadata: null });
  const [deleting, setDeleting] = useState<api.Thread | null>(null);
  const [actionError, setActionError] = useState<DescribedError | null>(null);
  const [page, setPage] = useState(1);
  const toast = useToast();
  const metadata = parseJson(metadataText);
  // The parse error shows only once Search is asked for with text that does not parse, so the
  // table does not move while typing (TSK-94); the field's danger edge shows at once.
  const [tried, setTried] = useState(false);
  const { data, error, loading, reload } = useLoad(connId ? () => client.langgraph.threads.search({ connId, metadata: applied.metadata, status: applied.status, limit: PAGE, offset: page === 1 ? null : (page - 1) * PAGE }) : null, [connId, applied, page], note);
  // The metadata keys and values of the threads listed, as suggestions for the filter (TSK-93).
  const metadataSchema = useMemo(() => seenKeysSchema((data ?? []).map((t) => t.metadata)), [data]);

  const search = () => {
    setTried(!metadata.ok);
    if (!metadata.ok) return;
    setApplied({ status: status === "any" ? null : status, metadata: (metadata.value ?? null) as api.JsonValue | null });
    setPage(1);
  };
  const open = (t: api.Thread, event?: LinkEvent) => go({ kind: "langgraph.thread", params: { threadId: t.threadId }, title: `Thread ${shortId(t.threadId)} · ${profile.name}` }, event);
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

  const first = (page - 1) * PAGE + 1;
  const subtitle = [profile.name, data ? (page > 1 || data.length === PAGE ? `page ${page}` : `${data.length} thread${data.length === 1 ? "" : "s"}`) : null, applied.status ? STATUSES[applied.status as keyof typeof STATUSES] : null].filter(Boolean).join(" · ");
  return (
    <Page>
      <PageHeader
        title="Threads"
        subtitle={subtitle}
        actions={
          <>
            <Button appearance="subtle" loading={loading} onClick={() => void reload()}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="primary" onClick={() => void create()}>
              <Icon icon={Add} /> New thread
            </Button>
          </>
        }
      />
      <form
        aria-label={`${tab.title} search`}
        className="flex shrink-0 flex-col gap-stack-xs px-inset-lg pt-stack-md"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <div className="flex items-center gap-inline-md">
          <Select aria-label="Status" value={status} onValueChange={(v) => setStatus(v as keyof typeof STATUSES)} items={STATUSES} className="w-panel-xs shrink-0">
            {Object.entries(STATUSES).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </Select>
          <CodeEditor
            singleLine
            language="json"
            aria-label="Metadata (JSON)"
            invalid={!metadata.ok}
            placeholder='Metadata, e.g. {"user": "ana"}'
            value={metadataText}
            onValueChange={(text) => {
              setMetadataText(text);
              if (parseJson(text).ok) setTried(false);
            }}
            onSubmit={search}
            jsonSchema={metadataSchema}
            className="min-w-0 flex-1"
          />
          <Button type="submit" appearance="secondary">
            Search
          </Button>
        </div>
        {tried && !metadata.ok ? <p className="text-caption-1 text-danger-fg">Metadata is not valid JSON: {metadata.message}</p> : null}
      </form>
      <PageRegion>
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
            {page > 1 ? "No more threads." : "No threads."}
          </EmptyLine>
        ) : null}
        {data && data.length > 0 ? (
          <Table aria-label="Threads" className={cn("min-h-0 flex-1", gutterTable)}>
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
                <TableRow key={t.threadId} onDoubleClick={(e) => open(t, e)} className="group">
                  <TableCell>
                    <span className="flex items-center gap-inline-xs">
                      <Button appearance="transparent" size="small" className="font-mono text-fg-link" {...linkHandlers((e) => open(t, e))} title={t.threadId}>
                        {shortId(t.threadId)}
                      </Button>
                      <CopyButton value={t.threadId} what="thread ID" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell>{t.createdAt ? <RelativeTime date={t.createdAt} /> : null}</TableCell>
                  <TableCell>{t.updatedAt ? <RelativeTime date={t.updatedAt} /> : null}</TableCell>
                  <TableCell className="max-w-panel-sm truncate font-mono text-code text-fg-muted" title={preview(t.metadata, 2000)}>
                    {preview(t.metadata)}
                  </TableCell>
                  <TableCell align="end">
                    <IconButton aria-label={`Delete thread ${shortId(t.threadId)}`} size="small" onClick={() => setDeleting(t)}>
                      <Icon icon={Delete} />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {data && (page > 1 || data.length === PAGE) ? (
          <PageFooter>
            <Pager range={`${first}–${first + Math.max(data.length, 1) - 1}`} page={page} hasPrev={page > 1} hasNext={data.length === PAGE} busy={loading} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
          </PageFooter>
        ) : null}
      </PageRegion>
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
    </Page>
  );
}
