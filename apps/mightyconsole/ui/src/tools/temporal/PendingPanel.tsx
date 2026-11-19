// The Pending view of a workflow (Mightyconsole spec §9.3, the TSK-91 mockup frame
// `temporal-workflow`): the pending activities as a table (state, attempt, last failure, next
// attempt), the chosen one's attempts, heartbeat, last worker and failure chain in a split pane
// with Copy failure; pending child workflows and the pending workflow task below.
import { useContext, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { JsonViewer } from "@/components/ui/json-viewer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton, LinkButton, NoticeContext, gutterTable } from "@/app/page";
import { cn } from "@/lib/cn";
import type { WorkflowDetail } from "@/gen/api";
import { ArrowClockwise, Copy } from "@/lib/icons";
import { clockText, durationMs, failureChain, spanText } from "./history";

type Attributes = Record<string, unknown>;
const obj = (value: unknown): Attributes => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Attributes) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const ms = (iso: unknown): number | null => {
  const t = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? null : t;
};

/** `PENDING_ACTIVITY_STATE_STARTED` as "Started". */
function stateLabel(value: unknown): string {
  const s = text(value).replace(/^[A-Z_]*STATE_/, "").toLowerCase().replace(/_/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** A pending activity read for the view. */
export interface PendingActivity {
  activityId: string;
  type: string;
  /** "Retrying" past its first attempt or after a failure, else the server's state ("Scheduled", "Started"). */
  state: string;
  retrying: boolean;
  attempt: number;
  maximumAttempts: number;
  /** "CardDeclined: issuer did not answer in 10s". */
  failure: string;
  /** The failure chain as a stack: "ApplicationError: CardDeclined\n  at …\ncaused by: …". */
  stack: string;
  /** When the next attempt starts, epoch ms, or null. */
  nextAttempt: number | null;
  scheduled: number | null;
  lastStarted: number | null;
  taskQueue: string;
  /** "backoff 2 × from 1 s". */
  backoff: string;
  heartbeat: unknown;
  lastWorker: string;
}

/** Reads `PendingActivityInfo` (protobuf JSON) for the view. */
export function readPendingActivity(a: Attributes): PendingActivity {
  const failure = obj(a["lastFailure"]);
  const chain = failureChain(Object.keys(failure).length > 0 ? failure : undefined);
  const head = chain[0];
  const attempt = num(a["attempt"]) ?? 1;
  const options = obj(a["activityOptions"]);
  const retry = obj(options["retryPolicy"]);
  const coefficient = num(retry["backoffCoefficient"]);
  const initial = durationMs(retry["initialInterval"]);
  const stack = chain
    .map((f, i) => {
      const title = `${i > 0 ? "caused by: " : ""}${f.type ? `ApplicationError: ${f.type}` : f.message}`;
      const lines = (f.stackTrace ?? "").split("\n").filter(Boolean).map((l) => `  ${l.trim()}`);
      return [title, ...(f.type ? [`  ${f.message}`] : []), ...lines].join("\n");
    })
    .join("\n");
  return {
    activityId: text(a["activityId"]),
    type: text(obj(a["activityType"])["name"]),
    state: attempt > 1 || head ? "Retrying" : stateLabel(a["state"]),
    retrying: attempt > 1 || head !== undefined,
    attempt,
    maximumAttempts: num(a["maximumAttempts"]) ?? 0,
    failure: head ? `${head.type ? `${head.type}: ` : ""}${head.message}` : "",
    stack,
    nextAttempt: ms(a["nextAttemptScheduleTime"]),
    scheduled: ms(a["scheduledTime"]),
    lastStarted: ms(a["lastStartedTime"]),
    taskQueue: text(obj(options["taskQueue"])["name"]),
    backoff: coefficient && initial !== null ? `backoff ${coefficient} × from ${spanText(initial)}` : "",
    heartbeat: a["heartbeatDetails"],
    lastWorker: text(a["lastWorkerIdentity"]),
  };
}

/** "in 4 s", "now", or "" when unknown. */
export function nextAttemptText(at: number | null, now: number): string {
  if (at === null) return "";
  const left = at - now;
  return left <= 0 ? "now" : `in ${spanText(Math.ceil(left / 1000) * 1000)}`;
}

export function PendingPanel({ detail, now, onRefresh, onOpenWorkflow }: { detail: WorkflowDetail; now: number; onRefresh(): void; onOpenWorkflow(workflowId: string, runId: string): void }) {
  const notify = useContext(NoticeContext);
  const activities = detail.pendingActivities.map(readPendingActivity);
  const { pendingChildren: children, pendingWorkflowTask: task } = detail;
  const [chosen, setChosen] = useState<string | null>(null);
  const picked = activities.find((a) => a.activityId === chosen) ?? activities[0];
  const copyFailure = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify({ title: "Copied the failure", description: value.length > 64 ? `${value.slice(0, 61)}…` : value, type: "success" });
    } catch {
      notify({ title: "Could not copy the failure", description: "The browser refused the clipboard. Select the text instead.", type: "warning" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <div className="flex shrink-0 items-center gap-inline-sm border-b border-border-subtle px-inset-lg py-stack-sm">
          <h3 className="text-body-1-strong text-fg">Activities</h3>
          <span className="text-body-1 text-fg-muted">{activities.length === 0 ? "None pending" : `${activities.length} pending`}</span>
          <Button size="small" appearance="subtle" className="ms-auto" onClick={onRefresh}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        </div>
        {activities.length > 0 ? (
          <Table aria-label="Pending activities" className={cn("shrink-0", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Activity</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>State</TableHead>
                <TableHead align="end">Attempt</TableHead>
                <TableHead>Last failure</TableHead>
                <TableHead>Next attempt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activities.map((a) => (
                <TableRow key={a.activityId} selected={a === picked} aria-selected={a === picked} onClick={() => setChosen(a.activityId)}>
                  <TableCell>
                    <span className="flex items-center gap-inline-xs">
                      {a.activityId}
                      <CopyButton value={a.activityId} what="activity ID" />
                    </span>
                  </TableCell>
                  <TableCell>{a.type}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" variant={a.retrying ? "warning" : "info"}>{a.state}</Badge>
                  </TableCell>
                  <TableCell align="end" className="whitespace-nowrap">
                    {a.attempt}
                    {a.maximumAttempts > 0 ? ` of ${a.maximumAttempts}` : ""}
                  </TableCell>
                  <TableCell className="w-full max-w-0">
                    <span className="block truncate">{a.failure}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{nextAttemptText(a.nextAttempt, now)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        <div className="flex shrink-0 items-center gap-inline-sm border-b border-border-subtle px-inset-lg py-stack-sm">
          <h3 className="text-body-1-strong text-fg">Child workflows</h3>
          <span className="text-body-1 text-fg-muted">{children.length === 0 ? "None pending" : `${children.length} pending`}</span>
        </div>
        {children.length > 0 ? (
          <Table aria-label="Pending child workflows" className={cn("shrink-0", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Run ID</TableHead>
                <TableHead>Parent close policy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {children.map((c, i) => (
                <TableRow key={text(c["workflowId"]) || i}>
                  <TableCell>
                    <LinkButton onClick={() => onOpenWorkflow(text(c["workflowId"]), text(c["runId"]))}>
                      {text(c["workflowId"])}
                    </LinkButton>
                  </TableCell>
                  <TableCell>{text(c["workflowTypeName"])}</TableCell>
                  <TableCell className="font-mono text-code">{text(c["runId"]).slice(0, 8)}</TableCell>
                  <TableCell>{stateLabel(c["parentClosePolicy"])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        <div className="flex shrink-0 items-center gap-inline-sm border-b border-border-subtle px-inset-lg py-stack-sm">
          <h3 className="text-body-1-strong text-fg">Workflow task</h3>
          <span className="text-body-1 text-fg-muted">{task ? stateLabel(obj(task)["state"]) || "Pending" : "None pending"}</span>
        </div>
        {task ? <JsonViewer value={task} defaultExpandDepth={1} aria-label="Pending workflow task" className="max-h-panel-sm shrink-0 px-inset-lg" /> : null}
      </div>
      {picked ? (
        <aside aria-label="Pending activity" className="flex w-1/3 min-w-0 flex-col gap-stack-md overflow-auto border-s border-border-subtle px-inset-lg py-inset-md">
          <div className="flex flex-col gap-stack-xs">
            <h3 className="flex items-center gap-inline-xs text-body-1-strong text-fg">
              {picked.type} · activity {picked.activityId}
              <CopyButton value={picked.type} what="activity type" />
            </h3>
            <p className="text-body-1 text-fg-muted">
              {[picked.scheduled !== null ? `Scheduled ${clockText(picked.scheduled)}` : "", picked.lastStarted !== null ? `last started ${clockText(picked.lastStarted)}` : "", picked.taskQueue ? `task queue ${picked.taskQueue}` : ""].filter(Boolean).join(" · ")}
            </p>
          </div>
          <DescriptionList layout="inline">
            <DescriptionListItem>
              <DescriptionListTerm>Attempt</DescriptionListTerm>
              <DescriptionListDetails>
                {picked.attempt}
                {picked.maximumAttempts > 0 ? ` of ${picked.maximumAttempts}` : " (no limit)"}
                {picked.backoff ? ` · ${picked.backoff}` : ""}
              </DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Next attempt</DescriptionListTerm>
              <DescriptionListDetails>{nextAttemptText(picked.nextAttempt, now) || "—"}</DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Heartbeat</DescriptionListTerm>
              <DescriptionListDetails>{picked.heartbeat === undefined || picked.heartbeat === null ? "No heartbeat details" : <span className="block truncate font-mono text-code">{JSON.stringify(picked.heartbeat)}</span>}</DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Last worker</DescriptionListTerm>
              <DescriptionListDetails className="flex items-center gap-inline-xs">
                {picked.lastWorker ? (
                  <>
                    <span className="truncate font-mono text-code">{picked.lastWorker}</span>
                    <CopyButton value={picked.lastWorker} what="worker identity" />
                  </>
                ) : (
                  "—"
                )}
              </DescriptionListDetails>
            </DescriptionListItem>
          </DescriptionList>
          {picked.failure ? (
            <div className="flex flex-col gap-stack-sm">
              <div className="flex flex-col gap-stack-xs">
                <h4 className="text-body-1-strong text-fg">Last failure</h4>
                <p className="text-body-1 text-fg-muted">{picked.failure}</p>
              </div>
              <CodeBlock code={picked.stack} language="text" aria-label="Failure chain" />
              <Button size="small" appearance="subtle" className="self-start" onClick={() => void copyFailure(picked.stack || picked.failure)}>
                <Icon icon={Copy} /> Copy failure
              </Button>
            </div>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
