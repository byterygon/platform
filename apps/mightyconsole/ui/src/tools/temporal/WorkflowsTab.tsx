// `temporal.workflows { namespace, query }` (Mightyconsole spec §9.3, laid out by TSK-91): the workflow
// list. A header with the context and the count, one row with the namespace, the Status menu (it
// rewrites the query's ExecutionStatus clause, Open question 45 (f)), the visibility query and Run;
// the table on the layer with copy buttons on the IDs, paged by token (Previous, Next). An invalid
// query shows the server's message under the row, not in place of the list.
//
// The query is a one-line Monaco editor in the temporal-visibility language (TSK-93, Open question
// 45 (m)): highlighting, suggestions from the namespace's search attributes, the operators of
// their types, values seen in the rows and recent and saved queries (Ctrl+Space), Enter or
// Mod+Enter runs, and the server's error marked on the part it names.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { CodeEditor } from "@/components/ui/code-editor";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton, Page, PageFooter, PageHeader, PageRegion, Pager, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { cn } from "@/lib/cn";
import { formatCount } from "@/app/messages";
import type { NamespaceSummary, SearchAttribute, WorkflowRow, WorkflowStatus } from "@/gen/api";
import { Add, ArrowClockwise, Play } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { formatDuration, formatShortTime, formatTime } from "./format";
import { namespaceOf, pageSizeOf, savedQueriesOf } from "./profile";
import { STATUS_CHIPS, statusOf, withStatus } from "./query";
import { useSheetRequest } from "./sheet-parts";
import { StartWorkflowSheet } from "./StartWorkflowSheet";
import { VISIBILITY_LANGUAGE, collectValues, queryErrorMarker, recentQueries, registerVisibilityLanguage, rememberQuery, visibilityCompletion } from "./visibility";

registerVisibilityLanguage();

const STATUS_VARIANT: Record<WorkflowStatus, "neutral" | "accent" | "danger" | "warning" | "success" | "info"> = {
  Running: "accent",
  Completed: "success",
  Failed: "danger",
  Canceled: "neutral",
  Terminated: "warning",
  ContinuedAsNew: "info",
  TimedOut: "warning",
  Paused: "neutral",
  Unspecified: "neutral",
};

/** "ContinuedAsNew" as the chips and rows read it. */
/** The Status menu's "any" entry. */
const ANY = "any";

export const statusLabel = (s: WorkflowStatus): string => s.replace(/([a-z])([A-Z])/g, "$1 $2");

/** The footer's choices of rows per page (the mockup's). */
const PAGE_SIZES = [25, 50, 100, 200] as const;

export function WorkflowsTab({ tab, profile, connId, client, active, useTabActions, note, openTab }: TabProps) {
  const [namespace, setNamespace] = useState(typeof tab.params["namespace"] === "string" ? tab.params["namespace"] : namespaceOf(profile));
  const initial = typeof tab.params["query"] === "string" ? tab.params["query"] : "";
  const [draft, setDraft] = useState(initial);
  // The query the table shows: what Run last sent.
  const [query, setQuery] = useState(initial);
  const [namespaces, setNamespaces] = useState<NamespaceSummary[]>([]);
  const [rows, setRows] = useState<WorkflowRow[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const tokens = useRef<(string | null)[]>([null]);
  const [error, setError] = useState<DescribedError | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [attributes, setAttributes] = useState<readonly SearchAttribute[]>([]);
  // Values of the rows loaded so far in this tab, per attribute, for the query's suggestions.
  const seen = useRef(new Map<string, Set<string>>());
  // A response that arrives after a newer request started is dropped.
  const generation = useRef(0);
  // Rows per page: the profile's setting, changed for this tab from the footer.
  const [pageSize, setPageSize] = useState(() => pageSizeOf(profile));
  const [starting, setStarting] = useState(false);
  // "Start workflow" from the palette opens this tab and asks it for the sheet.
  const request = useSheetRequest(profile.id, "startWorkflow");
  useEffect(() => {
    if (request.waiting && active && connId !== null) {
      request.take();
      setStarting(true);
    }
  }, [request, active, connId]);

  const load = useCallback(
    async (ns: string, q: string) => {
      if (connId === null) return;
      const mine = ++generation.current;
      setLoading(true);
      setError(null);
      setInvalid(null);
      try {
        const [page, total] = await Promise.all([
          client.temporal.workflows.list({ connId, namespace: ns, query: q, pageSize, nextPageToken: null }),
          client.temporal.workflows.count({ connId, namespace: ns, query: q }).then((c) => c.count, () => null),
        ]);
        if (mine !== generation.current) return;
        setRows(page.executions);
        collectValues(page.executions, seen.current);
        rememberQuery(profile.id, ns, q);
        setNext(page.nextPageToken ?? null);
        tokens.current = page.nextPageToken ? [null, page.nextPageToken] : [null];
        setPage(1);
        setCount(total);
      } catch (e) {
        if (mine !== generation.current) return;
        const described = note(e);
        setRows([]);
        setNext(null);
        setCount(null);
        if (described.kind === "Invalid") setInvalid(described.title);
        else setError(described);
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [client, connId, note, pageSize, profile.id],
  );

  // Paging by token (Open question 45 (i)): tokens[i] fetches page i + 1; Previous reuses the
  // tokens already seen, and there is no jump to page n, which the visibility API cannot do.
  const goPage = async (target: number) => {
    const token = tokens.current[target - 1];
    if (connId === null || target < 1 || token === undefined) return;
    const mine = generation.current;
    setLoading(true);
    try {
      const result = await client.temporal.workflows.list({ connId, namespace, query, pageSize, nextPageToken: token });
      if (mine !== generation.current) return;
      setRows(result.executions);
      collectValues(result.executions, seen.current);
      setNext(result.nextPageToken ?? null);
      if (result.nextPageToken) tokens.current[target] = result.nextPageToken;
      setPage(target);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  };

  // Load when the connection, the namespace or the shown query changes.
  useEffect(() => {
    void load(namespace, query);
  }, [load, namespace, query]);

  // The namespaces of the cluster, for the picker.
  useEffect(() => {
    if (connId === null) return;
    let live = true;
    client.temporal.namespaces.list({ connId }).then(
      (list) => live && setNamespaces(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, connId]);

  // The namespace's search attributes, for the query's suggestions (the built-in ones when the
  // server does not list them; nothing when the call fails, and the editor still works).
  useEffect(() => {
    if (connId === null) return;
    let live = true;
    setAttributes([]);
    client.temporal.namespaces.searchAttributes({ connId, namespace }).then(
      (out) => live && setAttributes(out.attributes),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, connId, namespace]);

  const sources = useRef({ attributes, namespace, extras: profile.extras });
  sources.current = { attributes, namespace, extras: profile.extras };
  const completion = useMemo(
    () =>
      visibilityCompletion(() => ({
        attributes: sources.current.attributes,
        values: seen.current,
        recent: recentQueries(profile.id, sources.current.namespace),
        saved: savedQueriesOf(sources.current.extras),
      })),
    [profile.id],
  );

  const run = () => {
    const q = draft.trim();
    if (q === query) void load(namespace, q);
    else setQuery(q);
  };
  const refresh = () => void load(namespace, query);
  useTabActions({ primary: run, refresh });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const chip = statusOf(draft);
  // The server's error belongs to the query that ran; it is marked while the text is still that query.
  const marker = invalid !== null && draft.trim() === query ? queryErrorMarker(invalid, draft) : null;
  const markers = marker ? [marker] : undefined;
  const names = namespaces.length > 0 ? namespaces.map((n) => n.name) : [namespace];
  if (!names.includes(namespace)) names.push(namespace);
  const first = (page - 1) * pageSize + 1;
  const running = rows.filter((w) => w.status === "Running").length;
  const pickStatus = (picked: WorkflowStatus | null) => {
    const q = withStatus(draft, picked);
    setDraft(q);
    if (q === query) void load(namespace, q);
    else setQuery(q);
  };

  return (
    <Page>
      <PageHeader
        title="Workflows"
        subtitle={
          <>
            {profile.name} · namespace <span className="text-fg">{namespace}</span>
            {count !== null ? (
              <span role="status">
                {" "}
                · {formatCount(count)} {count === 1 ? "workflow" : "workflows"}
              </span>
            ) : null}
            {running > 0 ? ` · ${formatCount(running)} running on this page` : ""}
          </>
        }
        actions={
          <>
            <Button appearance="subtle" onClick={refresh} aria-label="Refresh" loading={loading && rows.length > 0}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="primary" onClick={() => setStarting(true)}>
              <Icon icon={Add} /> Start workflow
            </Button>
          </>
        }
      />
      <StartWorkflowSheet
        open={starting}
        onOpenChange={setStarting}
        client={client}
        connId={connId}
        profile={profile}
        namespace={namespace}
        suggestions={{ types: [...new Set(rows.map((w) => w.workflowType))], queues: [...new Set(rows.map((w) => w.taskQueue))] }}
        note={note}
        onStarted={refresh}
        onOpenWorkflow={(workflowId, runId) => openTab({ kind: "temporal.workflow", params: { namespace, workflowId, runId }, title: workflowId })}
      />
      <form
        className="flex shrink-0 flex-col gap-stack-xs px-inset-lg pt-stack-md"
        aria-label="Workflow query"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <Field invalid={invalid !== null}>
          <div className="flex items-center gap-inline-md">
            <Select aria-label="Namespace" value={namespace} onValueChange={(v) => setNamespace(String(v))} className="w-panel-xs shrink-0">
              {names.map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </Select>
            <Select
              aria-label="Status"
              value={chip ?? ANY}
              onValueChange={(v) => pickStatus(v === ANY ? null : (v as WorkflowStatus))}
              items={{ [ANY]: "Any status", ...Object.fromEntries(STATUS_CHIPS.map((s) => [s, statusLabel(s)])) }}
              className="w-panel-xs shrink-0"
            >
              <SelectItem value={ANY}>Any status</SelectItem>
              {STATUS_CHIPS.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabel(s)}
                </SelectItem>
              ))}
            </Select>
            <CodeEditor
              singleLine
              language={VISIBILITY_LANGUAGE}
              aria-label="Visibility query"
              value={draft}
              onValueChange={setDraft}
              onSubmit={run}
              completion={completion}
              invalid={invalid !== null}
              markers={markers}
              placeholder='WorkflowType = "Order" AND StartTime > "2026-01-01T00:00:00Z"'
              className="min-w-0 flex-1"
            />
            <Button type="submit" appearance="primary" loading={loading}>
              <Icon icon={Play} /> Run
            </Button>
          </div>
          {invalid ? (
            <FieldError match>
              <Badge variant="danger">Invalid</Badge> {invalid}
            </FieldError>
          ) : null}
        </Field>
      </form>
      <PageRegion>
        {error ? <ErrorState error={error} onRetry={refresh} /> : null}
        {loading && rows.length === 0 ? (
          <LoadingRows label="Loading workflows" />
        ) : rows.length === 0 && !error && !invalid ? (
          <EmptyLine>{query === "" ? `No workflows in ${namespace}.` : "No workflow matches this query."}</EmptyLine>
        ) : rows.length > 0 ? (
          <>
            <Table aria-label="Workflows" className={cn("min-h-0 flex-1", gutterTable)}>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>Close</TableHead>
                  <TableHead align="end">Duration</TableHead>
                  <TableHead>Task queue</TableHead>
                  <TableHead align="end">History</TableHead>
                  <TableHead>Run ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((w) => (
                  <TableRow key={`${w.workflowId}/${w.runId}`} className="group">
                    <TableCell>
                      <span className="flex items-center gap-inline-xs">
                        <Button appearance="transparent" className="text-body-1 text-fg-link" onClick={() => openTab({ kind: "temporal.workflow", params: { namespace, workflowId: w.workflowId, runId: w.runId }, title: w.workflowId })}>
                          {w.workflowId}
                        </Button>
                        <CopyButton value={w.workflowId} what="workflow ID" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[w.status]}>{statusLabel(w.status)}</Badge>
                    </TableCell>
                    <TableCell>{w.workflowType}</TableCell>
                    <TableCell className="whitespace-nowrap" title={formatTime(w.startTime)}>
                      {formatShortTime(w.startTime)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap" title={w.closeTime ? formatTime(w.closeTime) : undefined}>
                      {w.closeTime ? formatShortTime(w.closeTime) : <span className="text-fg-muted">—</span>}
                    </TableCell>
                    <TableCell align="end">{w.durationMs === undefined ? "" : formatDuration(w.durationMs)}</TableCell>
                    <TableCell>
                      <Button appearance="transparent" className="text-body-1 text-fg-link" onClick={() => openTab({ kind: "temporal.taskQueue", params: { namespace, name: w.taskQueue }, title: `Task queue ${w.taskQueue}` })}>
                        {w.taskQueue}
                      </Button>
                    </TableCell>
                    <TableCell align="end">{formatCount(w.historyLength)}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-inline-xs">
                        <span className="font-mono text-code text-fg-muted" title={w.runId}>
                          {w.runId.slice(0, 8)}
                        </span>
                        <CopyButton value={w.runId} what="run ID" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PageFooter>
              <span className="whitespace-nowrap">Rows per page</span>
              <Select aria-label="Rows per page" size="small" className="w-auto shrink-0" value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))} items={Object.fromEntries(PAGE_SIZES.map((n) => [String(n), String(n)]))}>
                {PAGE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </Select>
              <Pager
                range={`${formatCount(first)}–${formatCount(first + rows.length - 1)}${count !== null ? ` of ${formatCount(count)}` : ""}`}
                page={page}
                hasPrev={page > 1}
                hasNext={next !== null}
                busy={loading}
                onFirst={() => void goPage(1)}
                onPrev={() => void goPage(page - 1)}
                onNext={() => void goPage(page + 1)}
              />
            </PageFooter>
          </>
        ) : null}
      </PageRegion>
    </Page>
  );
}
