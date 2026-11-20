// `temporal.activities { namespace, query }` (Mightyconsole spec §9.3 "Activities", TSK-92; mockup
// frame `temporal-standalone-activity`): standalone activities, run without a workflow. A header
// with the count and "Run activity", one row with the namespace, the Status menu and the
// visibility query, the table paged by token as Workflows. A server without standalone activities
// (Temporal Server 1.31 or newer, enabled on the namespace) shows its reason in place of the table,
// and "Run activity" stays, disabled, saying why.
import { useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Field, FieldError } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton, LinkButton, NoticeContext, Page, PageFooter, PageHeader, PageRegion, Pager, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import { linkTo } from "@/app/tab-view";
import { cn } from "@/lib/cn";
import type { ActivityRow, ActivityStatus, NamespaceSummary } from "@/gen/api";
import { ArrowClockwise, Flash, Play } from "@/lib/icons";
import type { DescribedError, LinkEvent, TabProps } from "../types";
import { STATUS_TONE, formatDuration, formatShortTime, formatTime } from "./format";
import { namespaceOf, pageSizeOf } from "./profile";
import { statusOf, withStatus } from "./query";
import { RunActivitySheet } from "./RunActivitySheet";
import { useSheetRequest } from "./sheet-parts";
import { VISIBILITY_LANGUAGE, registerVisibilityLanguage } from "./visibility";

registerVisibilityLanguage();

/** `remote.name` of the server's "no standalone activities" error. */
export const UNSUPPORTED = "StandaloneActivitiesUnsupported";

/** The Status menu's entries: the statuses a standalone activity ends in, and Running. */
export const ACTIVITY_STATUSES: readonly Exclude<ActivityStatus, "Unspecified">[] = ["Running", "Completed", "Failed", "Canceled", "Terminated", "TimedOut", "Paused"];
const ANY = "any";
const PAGE_SIZES = [25, 50, 100, 200] as const;

export const activityStatusLabel = (s: ActivityStatus): string => s.replace(/([a-z])([A-Z])/g, "$1 $2");

/** Whether an error is the server saying it has no standalone activities. */
export const isUnsupported = (e: DescribedError | null): boolean => e?.remoteName === UNSUPPORTED;

export function ActivitiesTab(props: TabProps) {
  const { tab, profile, connId, client, active, useTabActions, note } = props;
  const go = linkTo(props);
  const notify = useContext(NoticeContext);
  const [namespace, setNamespace] = useState(typeof tab.params["namespace"] === "string" ? tab.params["namespace"] : namespaceOf(profile));
  const initial = typeof tab.params["query"] === "string" ? tab.params["query"] : "";
  const [draft, setDraft] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [namespaces, setNamespaces] = useState<NamespaceSummary[]>([]);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const tokens = useRef<(string | null)[]>([null]);
  const [error, setError] = useState<DescribedError | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const generation = useRef(0);
  const [pageSize, setPageSize] = useState(() => pageSizeOf(profile));
  const [running, setRunning] = useState(false);
  // "Run activity" from the palette opens this tab and asks it for the sheet.
  const request = useSheetRequest(profile.id, "runActivity");
  const unsupported = isUnsupported(error);
  useEffect(() => {
    if (request.waiting && active && connId !== null && !unsupported) {
      request.take();
      setRunning(true);
    }
  }, [request, active, connId, unsupported]);

  const load = useCallback(
    async (ns: string, q: string) => {
      if (connId === null) return;
      const mine = ++generation.current;
      setLoading(true);
      setError(null);
      setInvalid(null);
      try {
        const [list, total] = await Promise.all([
          client.temporal.activities.list({ connId, namespace: ns, query: q, pageSize, nextPageToken: null }),
          client.temporal.activities.count({ connId, namespace: ns, query: q }).then((c) => c.count, () => null),
        ]);
        if (mine !== generation.current) return;
        setRows(list.executions);
        setNext(list.nextPageToken ?? null);
        tokens.current = list.nextPageToken ? [null, list.nextPageToken] : [null];
        setPage(1);
        setCount(total === null ? null : Number(total));
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
    [client, connId, note, pageSize],
  );

  const goPage = async (target: number) => {
    const token = tokens.current[target - 1];
    if (connId === null || target < 1 || token === undefined) return;
    const mine = generation.current;
    setLoading(true);
    try {
      const result = await client.temporal.activities.list({ connId, namespace, query, pageSize, nextPageToken: token });
      if (mine !== generation.current) return;
      setRows(result.executions);
      setNext(result.nextPageToken ?? null);
      if (result.nextPageToken) tokens.current[target] = result.nextPageToken;
      setPage(target);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load(namespace, query);
  }, [load, namespace, query]);

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

  const run = () => {
    const q = draft.trim();
    if (q === query) void load(namespace, q);
    else setQuery(q);
  };
  const refresh = () => void load(namespace, query);
  useTabActions({ primary: run, refresh });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const chip = statusOf(draft) as ActivityStatus | null;
  const pickStatus = (picked: ActivityStatus | null) => {
    const q = withStatus(draft, picked);
    setDraft(q);
    if (q === query) void load(namespace, q);
    else setQuery(q);
  };
  const names = namespaces.length > 0 ? namespaces.map((n) => n.name) : [namespace];
  if (!names.includes(namespace)) names.push(namespace);
  const first = (page - 1) * pageSize + 1;
  const activityPlace = (a: ActivityRow) => ({ kind: "temporal.activity", params: { namespace, activityId: a.activityId, runId: a.runId }, title: a.activityId });
  const openActivity = (a: ActivityRow, event?: LinkEvent) => go(activityPlace(a), event);
  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, a: ActivityRow) => {
    if (e.target !== e.currentTarget) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      void navigator.clipboard.writeText(a.activityId).then(
        () => notify({ title: "Copied activity ID", description: a.activityId, type: "success" }),
        () => notify({ title: "Could not copy activity ID", description: "The browser refused the clipboard. Select the text instead.", type: "warning" }),
      );
      e.preventDefault();
    } else if (e.key === "Enter") {
      openActivity(a, e);
      e.preventDefault();
    }
  };

  const runButton = (
    <Button appearance="primary" onClick={() => setRunning(true)} disabled={unsupported}>
      <Icon icon={Flash} /> Run activity
    </Button>
  );

  return (
    <Page>
      <PageHeader
        title="Activities"
        subtitle={
          <>
            {profile.name} · namespace <span className="text-body-1-strong text-fg">{namespace}</span> · standalone activities, run without a workflow
            {count !== null ? (
              <span role="status">
                {" "}
                · {formatCount(count)} {count === 1 ? "activity" : "activities"}
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            <Button appearance="subtle" onClick={refresh} aria-label="Refresh" loading={loading && rows.length > 0}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            {unsupported ? (
              <Tooltip>
                <TooltipTrigger render={<span tabIndex={0} />}>{runButton}</TooltipTrigger>
                <TooltipContent>{error?.title}</TooltipContent>
              </Tooltip>
            ) : (
              runButton
            )}
          </>
        }
      />
      <RunActivitySheet
        open={running}
        onOpenChange={setRunning}
        client={client}
        connId={connId}
        profile={profile}
        namespace={namespace}
        suggestions={{ types: [...new Set(rows.map((a) => a.activityType))], queues: [...new Set(rows.map((a) => a.taskQueue))] }}
        note={note}
        onStarted={refresh}
        onOpenActivity={(activityId, runId) => go({ kind: "temporal.activity", params: { namespace, activityId, runId }, title: activityId })}
      />
      <form
        className="flex shrink-0 flex-col gap-stack-xs px-inset-lg pt-stack-md"
        aria-label="Activity query"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <Field>
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
              onValueChange={(v) => pickStatus(v === ANY ? null : (v as ActivityStatus))}
              items={{ [ANY]: "Any status", ...Object.fromEntries(ACTIVITY_STATUSES.map((s) => [s, activityStatusLabel(s)])) }}
              className="w-panel-xs shrink-0"
            >
              <SelectItem value={ANY}>Any status</SelectItem>
              {ACTIVITY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {activityStatusLabel(s)}
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
              invalid={invalid !== null && draft.trim() === query}
              placeholder='ActivityType = "charge" AND ExecutionStatus = "Failed"'
              className="min-w-0 flex-1"
            />
            <Button type="submit" appearance="primary" loading={loading}>
              <Icon icon={Play} /> Run
            </Button>
          </div>
          {invalid ? (
            <FieldError match>
              <Badge appearance="tint" variant="danger">Invalid</Badge> {invalid}
            </FieldError>
          ) : null}
        </Field>
      </form>
      <PageRegion>
        {unsupported && error ? (
          <div className="px-inset-lg pt-stack-md">
            <Alert intent="warning">
              <AlertTitle>Standalone activities are not available here</AlertTitle>
              <AlertDescription>{error.title}</AlertDescription>
            </Alert>
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={refresh} />
        ) : null}
        {loading && rows.length === 0 ? (
          <LoadingRows label="Loading activities" />
        ) : rows.length === 0 && !error && !invalid ? (
          <EmptyLine>{query === "" ? `No standalone activities in ${namespace}.` : "No activity matches this query."}</EmptyLine>
        ) : rows.length > 0 ? (
          <>
            <Table aria-label="Standalone activities" className={cn("min-h-0 flex-1", gutterTable)}>
              <TableHeader>
                <TableRow>
                  <TableHead>Activity ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Closed</TableHead>
                  <TableHead align="end">Duration</TableHead>
                  <TableHead>Task queue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={`${a.activityId}/${a.runId}`} tabIndex={0} onKeyDown={(e) => onRowKey(e, a)} className="group">
                    <TableCell>
                      <span className="flex items-center gap-inline-xs">
                        <LinkButton onOpen={(e) => openActivity(a, e)}>{a.activityId}</LinkButton>
                        <CopyButton value={a.activityId} what="activity ID" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
                      </span>
                    </TableCell>
                    <TableCell>{a.activityType}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" variant={STATUS_TONE[a.status]}>
                        {activityStatusLabel(a.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap" title={formatTime(a.startTime)}>
                      {formatShortTime(a.startTime)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap" title={a.closeTime ? formatTime(a.closeTime) : undefined}>
                      {a.closeTime ? formatShortTime(a.closeTime) : <span className="text-fg-muted">—</span>}
                    </TableCell>
                    <TableCell align="end">{a.durationMs === undefined ? "" : formatDuration(a.durationMs)}</TableCell>
                    <TableCell>
                      <LinkButton onOpen={(e) => go({ kind: "temporal.taskQueue", params: { namespace, name: a.taskQueue }, title: `Task queue ${a.taskQueue}` }, e)}>{a.taskQueue}</LinkButton>
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
