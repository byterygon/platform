// A workflow's Relations view (DOC-21 §9.3 "Workflow: Relations", TSK-104): its parent, children,
// the signals and cancels between it and other workflows, and its runs, as a graph (GraphView, left
// to right) and as lists. Whole family draws every workflow under the root (RootWorkflowId); Direct
// only one level each way. Loaded when the view is first shown, again when the scope changes.
import type { LinkEvent } from "../types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Field, FieldLabel } from "@/components/ui/field";
import { GraphView, type GraphViewEdge, type GraphViewNode } from "@/components/ui/graph-view";
import { Icon } from "@/components/ui/icon";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton, LinkButton } from "@/app/page";
import { ErrorState, LoadingRows } from "@/app/states";
import { List } from "@/lib/icons";
import type { RelationNode, RelationScope, RelationSignal, WorkflowRelations, WorkflowStatus } from "@/gen/api";
import type { MightyClient } from "@/app/client";
import type { DescribedError } from "../types";
import { STATUS_TONE, formatDuration, formatTime } from "./format";
import { spanText } from "./history";
import { statusLabel } from "./WorkflowsTab";

export interface RelationsPanelProps {
  client: MightyClient;
  connId: string | null;
  namespace: string;
  workflowId: string;
  runId: string;
  /** The view is shown: the first time loads it. */
  active: boolean;
  /** Grows with the history (its event count): the relations are read again. */
  version: number;
  now: number;
  note(error: unknown): DescribedError;
  onOpenWorkflow(workflowId: string, runId?: string, event?: LinkEvent): void;
  onListWorkflows(query: string): void;
}

/** "Running · OrderWorkflow", or "Not found" for a workflow the server no longer has. */
export function nodeDetail(n: RelationNode): string {
  if (n.missing) return "Not found";
  return [relationStatus(n.status), n.workflowType].filter(Boolean).join(" · ");
}

/** A status as the relations say it: a child only initiated (or refused) has not started. */
function relationStatus(s: WorkflowStatus): string {
  return s === "Unspecified" ? "Not started" : statusLabel(s);
}

/** The graph's boxes and arrows; without signals, the arrows of signals and cancels and the boxes only they bring. */
export function graphOf(r: WorkflowRelations, signals: boolean): { nodes: GraphViewNode[]; edges: GraphViewEdge[] } {
  const shown = r.nodes.filter((n) => signals || n.level !== undefined);
  const nodes = shown.map((n): GraphViewNode => ({ id: n.workflowId, label: n.workflowId, detail: nodeDetail(n), tone: n.missing ? "neutral" : STATUS_TONE[n.status], ...(n.current ? { emphasis: true } : {}) }));
  const edges = r.edges
    .filter((e) => signals || e.kind === "child")
    .map((e): GraphViewEdge => (e.kind === "child" ? { source: e.from, target: e.to } : { source: e.from, target: e.to, dashed: true, label: e.label ?? e.kind }));
  return { nodes, edges };
}

/** The bar's words: "Root checkout-9912 · 6 workflows in 3 levels". */
export function summaryOf(r: WorkflowRelations): string {
  const f = r.family;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (f.scope === "family") {
    const more = f.notDrawn > 0 ? ` · ${plural(f.notDrawn, "more not drawn", "more not drawn")}` : "";
    return `Root ${r.rootWorkflowId ?? r.workflow.workflowId} · ${plural(f.drawn, "workflow", "workflows")} in ${plural(f.levels, "level", "levels")}${more}`;
  }
  return `${r.parent ? "1 parent" : "No parent"} · ${plural(r.children.length, "child", "children")}`;
}

const CLOSE_POLICY: Record<string, string> = { Terminate: "if it closes, this is terminated", Abandon: "if it closes, this goes on", RequestCancel: "if it closes, this is asked to cancel" };

function shortRun(runId: string): string {
  return runId.length > 13 ? `${runId.slice(0, 8)}…` : runId;
}

function StatusBadge({ status, missing }: { status: WorkflowStatus; missing?: boolean }) {
  return (
    <Badge appearance="tint" variant={missing ? "neutral" : STATUS_TONE[status]}>
      {missing ? "Not found" : relationStatus(status)}
    </Badge>
  );
}

function SideHead({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="flex items-center gap-inline-xs text-body-1-strong text-fg">
      {title}
      {count !== undefined ? <span className="text-body-1 text-fg-muted">{count}</span> : null}
    </h3>
  );
}

export function RelationsPanel({ client, connId, namespace, workflowId, runId, active, version, now, note, onOpenWorkflow, onListWorkflows }: RelationsPanelProps) {
  const [scope, setScope] = useState<RelationScope>("family");
  const [signals, setSignals] = useState(true);
  const [data, setData] = useState<WorkflowRelations | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);

  useEffect(() => {
    if (active) setWanted(true);
  }, [active]);

  const load = useCallback(async () => {
    if (connId === null) return;
    setLoading(true);
    setError(null);
    try {
      const out = await client.temporal.workflows.relations({ connId, namespace, workflowId, runId: runId || null, scope });
      setData(out);
    } catch (e) {
      setError(note(e));
    } finally {
      setLoading(false);
    }
  }, [client, connId, namespace, workflowId, runId, scope, note]);

  // Again when the scope changes, and a moment after the history grows (a child started or closed,
  // a signal arrived).
  const loaded = useRef(false);
  useEffect(() => {
    if (!wanted) return undefined;
    if (!loaded.current) {
      loaded.current = true;
      void load();
      return undefined;
    }
    const timer = setTimeout(() => void load(), 1000);
    return () => clearTimeout(timer);
  }, [wanted, load, version]);

  const graph = useMemo(() => (data ? graphOf(data, signals) : { nodes: [], edges: [] }), [data, signals]);
  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.workflowId, n])), [data]);
  const picked = selected ? byId.get(selected) : undefined;
  const open = (id: string, run?: string) => {
    if (id === workflowId && (!run || run === runId)) return;
    onOpenWorkflow(id, run || byId.get(id)?.runId || undefined);
  };

  if (error && !data) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!data) return <LoadingRows label="Loading the relations" />;

  const family = data.family;
  const effectiveScope = family.scope;
  const workflowLink = (id: string, run?: string) =>
    id === workflowId ? (
      <span className="truncate font-mono text-code">{id}</span>
    ) : (
      <LinkButton className="font-mono text-code" onClick={() => open(id, run)}>
        {id}
      </LinkButton>
    );
  const runLink = (run: string) =>
    run === runId ? (
      <span className="font-mono text-code">{shortRun(run)} (this run)</span>
    ) : (
      <LinkButton className="font-mono text-code" title={run} onOpen={(e) => onOpenWorkflow(workflowId, run, e)}>
        {shortRun(run)}
      </LinkButton>
    );
  const childExtra = (c: WorkflowRelations["children"][number]): string => {
    if (c.failure) return c.failure;
    const n = byId.get(c.workflowId);
    if (c.status === "Running" && c.startTime) return `running for ${spanText(now - Date.parse(c.startTime))}`;
    if (n?.durationMs !== undefined) return formatDuration(n.durationMs);
    return c.status === "Unspecified" ? "not started yet" : "";
  };
  const signalText = (s: RelationSignal) => [s.kind === "cancel" ? "cancel" : s.signalName ?? "signal", `event ${s.eventId}`, s.outcome ?? ""].filter(Boolean).join(" · ");
  const received = data.signals.filter((s) => s.direction === "received");
  const sent = data.signals.filter((s) => s.direction === "sent");
  const parentNode = data.parent ? byId.get(data.parent.workflowId) : undefined;
  const runs = data.runs;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="group" aria-label="Relations" className="flex shrink-0 flex-wrap items-center gap-inline-md border-b border-border-subtle px-inset-lg py-stack-sm">
        <ToggleGroup aria-label="Scope" size="small" value={[effectiveScope]} onValueChange={(v) => v[0] && setScope(v[0] as RelationScope)}>
          {family.supported ? (
            <ToggleGroupItem value="family">Whole family</ToggleGroupItem>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<ToggleGroupItem value="family" disabled />}>Whole family</TooltipTrigger>
              <TooltipContent>The server cannot list the family: {family.reason ?? "no RootWorkflowId"}</TooltipContent>
            </Tooltip>
          )}
          <ToggleGroupItem value="direct">Direct only</ToggleGroupItem>
        </ToggleGroup>
        <Field orientation="horizontal" className="shrink-0">
          <Checkbox checked={signals} onCheckedChange={(v) => setSignals(v === true)} />
          <FieldLabel className="whitespace-nowrap">Signals and cancels between workflows</FieldLabel>
        </Field>
        <span className="flex-1" />
        <span className="text-body-1 text-fg-muted" aria-live="polite">
          {loading ? "Loading…" : summaryOf(data)}
        </span>
        <Button size="small" appearance="subtle" disabled={!family.query} onClick={() => family.query && onListWorkflows(family.query)}>
          <Icon icon={List} /> List them in Workflows
        </Button>
      </div>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {!family.supported && family.reason ? <p className="shrink-0 px-inset-lg pt-stack-sm text-caption-1 text-fg-muted">Direct only: the server cannot list the whole family ({family.reason}).</p> : null}
      <Resizable orientation="horizontal" className="min-h-0 flex-1" aria-label="The graph and the related workflows">
        <ResizablePanel defaultSize={64} minSize={35} className="flex min-h-0 min-w-0 flex-col gap-stack-sm px-inset-lg py-inset-md">
          <GraphView
            nodes={graph.nodes}
            edges={graph.edges}
            direction="LR"
            selectedId={selected}
            onNodeSelect={(id) => setSelected(id === selected ? null : id)}
            onNodeOpen={(id) => open(id)}
            aria-label={`Relations of ${workflowId}`}
            className="min-h-panel-xs flex-1"
          />
          <p className="shrink-0 text-caption-1 text-fg-muted">Solid arrows: parent to child. Dashed: a signal or cancel between this workflow and another. Click a box to see it on the right; double-click opens it in a tab.</p>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={36} minSize={22} className="flex min-h-0 min-w-0 flex-col">
        <aside aria-label="Related workflows" className="flex min-h-0 min-w-0 flex-1 flex-col gap-stack-md overflow-y-auto px-inset-lg py-inset-md">
          {picked && !picked.current ? (
            <section aria-label="Selected workflow" className="flex flex-col gap-stack-sm">
              <h3 className="flex items-center gap-inline-xs text-body-1-strong text-fg">
                <span className="truncate font-mono">{picked.workflowId}</span>
                <CopyButton value={picked.workflowId} what="workflow ID" />
                <StatusBadge status={picked.status} missing={picked.missing} />
              </h3>
              <DescriptionList layout="aligned">
                <Item term="Type">{picked.workflowType || "—"}</Item>
                <Item term="Started">{formatTime(picked.startTime) || "—"}</Item>
                {picked.closeTime ? <Item term="Closed">{formatTime(picked.closeTime)}</Item> : null}
                {picked.durationMs !== undefined ? <Item term="Duration">{formatDuration(picked.durationMs)}</Item> : null}
                {picked.failure ? <Item term="Failure">{picked.failure}</Item> : null}
                {picked.runId ? <Item term="Run ID">{<span className="font-mono text-code">{picked.runId}</span>}</Item> : null}
              </DescriptionList>
              {!picked.missing ? (
                <Button size="small" appearance="secondary" className="self-start" onClick={() => open(picked.workflowId, picked.runId)}>
                  Open workflow
                </Button>
              ) : null}
            </section>
          ) : null}
          <section aria-label="Parent" className="flex flex-col gap-stack-sm">
            <SideHead title="Parent" />
            {data.parent ? (
              <RelRow link={workflowLink(data.parent.workflowId, data.parent.runId)} status={parentNode?.status ?? "Unspecified"} missing={parentNode?.missing} extra={[parentNode?.workflowType, data.parent.parentClosePolicy ? CLOSE_POLICY[data.parent.parentClosePolicy] ?? data.parent.parentClosePolicy : ""].filter(Boolean).join(" · ")} />
            ) : (
              <p className="text-body-1 text-fg-muted">None: this is a top-level workflow</p>
            )}
          </section>
          <section aria-label="Children" className="flex flex-col gap-stack-sm">
            <SideHead title="Children" count={data.children.length} />
            {data.children.length === 0 ? <p className="text-body-1 text-fg-muted">None</p> : null}
            {data.children.map((c) => (
              <RelRow key={c.initiatedEventId} link={workflowLink(c.workflowId, c.runId)} status={c.status} extra={[c.workflowType, childExtra(c)].filter(Boolean).join(" · ")} />
            ))}
          </section>
          <section aria-label="Signals and cancels" className="flex flex-col gap-stack-sm">
            <SideHead title="Signals and cancels" />
            <DescriptionList layout="aligned">
              <Item term="Received">
                {received.length === 0 ? (
                  <span className="text-fg-muted">None from workflows</span>
                ) : (
                  <ul className="flex flex-col gap-stack-xs">
                    {received.map((s) => (
                      <li key={s.eventId} className="flex min-w-0 flex-wrap items-center gap-x-inline-xs">
                        {workflowLink(s.workflowId, s.runId)}
                        <span className="text-fg-muted">· {signalText(s)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Item>
              <Item term="Sent">
                {sent.length === 0 ? (
                  <span className="text-fg-muted">None</span>
                ) : (
                  <ul className="flex flex-col gap-stack-xs">
                    {sent.map((s) => (
                      <li key={s.eventId} className="flex min-w-0 flex-wrap items-center gap-x-inline-xs">
                        {workflowLink(s.workflowId, s.runId)}
                        <span className="text-fg-muted">· {signalText(s)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Item>
            </DescriptionList>
          </section>
          <section aria-label="Runs" className="flex flex-col gap-stack-sm">
            <SideHead title="Runs" />
            <DescriptionList layout="aligned">
              <Item term="This run">
                {runs.continuedFrom ? (
                  <span className="flex items-center gap-inline-xs">
                    continued from {runLink(runs.continuedFrom.runId)}
                    {runs.continuedFrom.initiator ? <span className="text-fg-muted">· {initiatorText(runs.continuedFrom.initiator)}</span> : null}
                  </span>
                ) : runs.resetFrom ? (
                  "made by a reset"
                ) : (
                  "first run"
                )}
                {runs.continuedAs ? (
                  <span className="flex items-center gap-inline-xs">
                    continued as {runLink(runs.continuedAs.runId)}
                    {runs.continuedAs.initiator ? <span className="text-fg-muted">· {initiatorText(runs.continuedAs.initiator)}</span> : null}
                  </span>
                ) : (
                  <span className="block text-fg-muted">not continued as new</span>
                )}
              </Item>
              {runs.firstRunId ? <Item term="First run">{runLink(runs.firstRunId)}</Item> : null}
              <Item term="Reset from">{runs.resetFrom ? runLink(runs.resetFrom) : <span className="text-fg-muted">None</span>}</Item>
              <Item term="Reset to">{runs.resetTo ? runLink(runs.resetTo) : <span className="text-fg-muted">None</span>}</Item>
            </DescriptionList>
          </section>
        </aside>
        </ResizablePanel>
      </Resizable>
    </div>
  );
}

function initiatorText(initiator: string): string {
  return initiator === "Workflow" ? "continue-as-new" : initiator === "Retry" ? "retry" : initiator === "CronSchedule" ? "cron" : initiator;
}

function Item({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails className="min-w-0">{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

function RelRow({ link, status, missing, extra }: { link: React.ReactNode; status: WorkflowStatus; missing?: boolean | undefined; extra: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-inline-sm">
      {link}
      <StatusBadge status={status} missing={missing ?? false} />
      {extra ? <span className="min-w-0 text-body-1 text-fg-muted">{extra}</span> : null}
    </div>
  );
}
