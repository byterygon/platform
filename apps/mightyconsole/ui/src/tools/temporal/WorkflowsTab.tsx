// `temporal.workflows { namespace, query }` (Mightyconsole spec §9.3): the workflow list. A query
// bar for visibility queries, quick status chips, the count, and a table paged by token ("Load
// more"). An invalid query shows the server's message under the bar, not in place of the list.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { NamespaceSummary, WorkflowRow, WorkflowStatus } from "@/gen/api";
import { ArrowClockwise, Play } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { formatDuration, formatTime } from "./format";
import { namespaceOf, pageSizeOf } from "./profile";
import { STATUS_CHIPS, statusOf, withStatus } from "./query";

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
export const statusLabel = (s: WorkflowStatus): string => s.replace(/([a-z])([A-Z])/g, "$1 $2");

export function WorkflowsTab({ tab, profile, connId, client, useTabActions, note, openTab }: TabProps) {
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
  const [more, setMore] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  // A response that arrives after a newer request started is dropped.
  const generation = useRef(0);
  const pageSize = pageSizeOf(profile);

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
        setNext(page.nextPageToken ?? null);
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
    [client, connId, note, pageSize],
  );

  const loadMore = async () => {
    if (connId === null || next === null) return;
    const mine = generation.current;
    setMore(true);
    try {
      const page = await client.temporal.workflows.list({ connId, namespace, query, pageSize, nextPageToken: next });
      if (mine !== generation.current) return;
      setRows((r) => [...r, ...page.executions]);
      setNext(page.nextPageToken ?? null);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      setMore(false);
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

  const run = () => {
    const q = draft.trim();
    if (q === query) void load(namespace, q);
    else setQuery(q);
  };
  const refresh = () => void load(namespace, query);
  useTabActions({ primary: run, refresh });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const chip = statusOf(draft);
  const names = namespaces.length > 0 ? namespaces.map((n) => n.name) : [namespace];
  if (!names.includes(namespace)) names.push(namespace);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label="Workflow list actions">
        <ToolbarGroup>
          <Select aria-label="Namespace" value={namespace} onValueChange={(v) => setNamespace(String(v))} size="small" className="w-panel-xs">
            {names.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </Select>
        </ToolbarGroup>
        <ToolbarGroup>
          <Button size="small" onClick={refresh} aria-label="Refresh">
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        </ToolbarGroup>
        {count !== null ? (
          <Badge variant="neutral" role="status">
            {formatCount(count)} {count === 1 ? "workflow" : "workflows"}
          </Badge>
        ) : null}
      </Toolbar>
      <form
        className="flex flex-col gap-stack-sm border-b border-border-subtle p-inset-sm"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <Field invalid={invalid !== null}>
          <div className="flex items-center gap-inline-sm">
            <Input
              aria-label="Visibility query"
              value={draft}
              onValueChange={setDraft}
              placeholder='WorkflowType = "Order" AND StartTime > "2026-01-01T00:00:00Z"'
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
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
        <ToggleGroup
          aria-label="Status"
          value={chip ? [chip] : []}
          onValueChange={(value) => {
            const picked = (value[0] as WorkflowStatus | undefined) ?? null;
            const q = withStatus(draft, picked);
            setDraft(q);
            if (q === query) void load(namespace, q);
            else setQuery(q);
          }}
          size="small"
        >
          {STATUS_CHIPS.map((s) => (
            <ToggleGroupItem key={s} value={s}>
              {statusLabel(s)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </form>
      {error ? <ErrorState error={error} onRetry={refresh} /> : null}
      {loading && rows.length === 0 ? (
        <LoadingRows label="Loading workflows" />
      ) : rows.length === 0 && !error && !invalid ? (
        <EmptyLine>{query === "" ? `No workflows in ${namespace}.` : "No workflow matches this query."}</EmptyLine>
      ) : rows.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col gap-stack-sm p-inset-sm">
          <Table aria-label="Workflows" className="min-h-0 flex-1">
            <TableHeader>
              <TableRow>
                <TableHead>Workflow ID</TableHead>
                <TableHead>Run ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Close</TableHead>
                <TableHead align="end">Duration</TableHead>
                <TableHead>Task queue</TableHead>
                <TableHead align="end">History</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((w) => (
                <TableRow key={`${w.workflowId}/${w.runId}`}>
                  <TableCell>
                    <Button size="small" appearance="subtle" onClick={() => openTab({ kind: "temporal.workflow", params: { namespace, workflowId: w.workflowId, runId: w.runId }, title: w.workflowId })}>
                      {w.workflowId}
                    </Button>
                  </TableCell>
                  <TableCell className="font-mono text-code" title={w.runId}>
                    {w.runId.slice(0, 8)}
                  </TableCell>
                  <TableCell>{w.workflowType}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[w.status]}>{statusLabel(w.status)}</Badge>
                  </TableCell>
                  <TableCell>{formatTime(w.startTime)}</TableCell>
                  <TableCell>{formatTime(w.closeTime)}</TableCell>
                  <TableCell align="end">{w.durationMs === undefined ? "" : formatDuration(w.durationMs)}</TableCell>
                  <TableCell>
                    <Button size="small" appearance="subtle" onClick={() => openTab({ kind: "temporal.taskQueue", params: { namespace, name: w.taskQueue }, title: `Task queue ${w.taskQueue}` })}>
                      {w.taskQueue}
                    </Button>
                  </TableCell>
                  <TableCell align="end">{formatCount(w.historyLength)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {next !== null ? (
            <div>
              <Button onClick={() => void loadMore()} loading={more}>
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
