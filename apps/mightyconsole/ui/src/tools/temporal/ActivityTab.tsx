// `temporal.activity { namespace, activityId, runId? }` (Mightyconsole spec §9.3 "Activities",
// TSK-92): one standalone activity. The header names it with its status and, while it runs, Cancel
// (seen by the worker at its next heartbeat) and Terminate (reason required). Below: what it is
// (type, queue, attempt, timeouts, retry policy, heartbeat, last worker), then its input and its
// result or failure, decoded as everywhere else (External Storage, the profile's codec). Described
// again every 2 seconds while it runs and the tab is shown.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { JsonViewer } from "@/components/ui/json-viewer";
import { CopyButton, LinkButton, Page, PageHeader, PageRegion } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { linkTo } from "@/app/tab-view";
import type { ActivityDetail } from "@/gen/api";
import { ArrowClockwise, Dismiss, Stop } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { CancelDialog, TerminateDialog, useAction } from "./ActionDialogs";
import { activityStatusLabel } from "./ActivitiesTab";
import { STATUS_TONE, formatDuration, formatTime } from "./format";
import { failureChain } from "./history";
import { namespaceOf } from "./profile";

/** How often a running activity is described again while its tab is shown. */
export const ACTIVITY_REFRESH_MS = 2_000;

const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A protobuf JSON duration ("30s", "0.250s") as people read it ("30s", "250ms"); "" for none. */
export function protoDuration(v: unknown): string {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(text(v));
  if (!m) return "";
  const ms = Math.round(Number(m[1]) * 1000);
  return ms > 0 ? formatDuration(ms) : "";
}

/** "initial 1s, ×2, up to 1m40s, 3 attempts" for a retry policy as protobuf JSON. */
export function retryPolicyText(v: unknown): string {
  const p = obj(v);
  if (Object.keys(p).length === 0) return "Server default";
  const attempts = typeof p["maximumAttempts"] === "number" ? p["maximumAttempts"] : 0;
  const types = Array.isArray(p["nonRetryableErrorTypes"]) ? p["nonRetryableErrorTypes"].map(String) : [];
  return [
    protoDuration(p["initialInterval"]) && `initial ${protoDuration(p["initialInterval"])}`,
    typeof p["backoffCoefficient"] === "number" && `×${p["backoffCoefficient"]}`,
    protoDuration(p["maximumInterval"]) && `up to ${protoDuration(p["maximumInterval"])}`,
    attempts > 0 ? `${attempts} ${attempts === 1 ? "attempt" : "attempts"}` : "unlimited attempts",
    types.length > 0 && `not retried: ${types.join(", ")}`,
  ]
    .filter(Boolean)
    .join(", ");
}

const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2");

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-stack-xs pb-inset-md">
      <h3 className="text-body-1-strong text-fg">{title}</h3>
      {children}
    </section>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails>{children === "" || children === null || children === undefined ? <span className="text-fg-muted">—</span> : children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

function Failure({ failure }: { failure: Record<string, unknown> | undefined }) {
  const chain = failureChain(failure);
  return (
    <ol className="flex flex-col gap-stack-sm">
      {chain.map((f, i) => (
        <li key={i} className="flex flex-col gap-stack-xs">
          <p className="text-body-1 text-fg">
            {i > 0 ? <span className="text-fg-muted">Caused by: </span> : null}
            {f.type ? <Badge appearance="tint" variant="danger">{f.type}</Badge> : null} {f.message}
          </p>
          {f.stackTrace ? <CodeBlock code={f.stackTrace} language="text" copyable aria-label={`Stack of failure ${i + 1}`} className="max-h-panel-sm" /> : null}
        </li>
      ))}
    </ol>
  );
}

export function ActivityTab(props: TabProps) {
  const { tab, profile, connId, client, active, useTabActions, note } = props;
  const go = linkTo(props);
  const namespace = typeof tab.params["namespace"] === "string" ? tab.params["namespace"] : namespaceOf(profile);
  const activityId = typeof tab.params["activityId"] === "string" ? tab.params["activityId"] : "";
  const runId = typeof tab.params["runId"] === "string" && tab.params["runId"] !== "" ? tab.params["runId"] : null;
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<"cancel" | "terminate" | null>(null);
  const action = useAction(note);

  const load = useCallback(async () => {
    if (connId === null || activityId === "") return;
    setLoading(true);
    try {
      setDetail(await client.temporal.activities.describe({ connId, namespace, activityId, runId }));
      setError(null);
    } catch (e) {
      setError(note(e));
    } finally {
      setLoading(false);
    }
  }, [client, connId, namespace, activityId, runId, note]);

  useEffect(() => {
    void load();
  }, [load]);
  const runningNow = detail?.activity.status === "Running";
  useEffect(() => {
    if (!active || !runningNow) return undefined;
    const timer = setInterval(() => void load(), ACTIVITY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, runningNow, load]);
  useTabActions({ refresh: () => void load() });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const a = detail?.activity;
  const info = detail?.info ?? {};
  const ref = { connId, namespace, activityId, runId: a?.runId ?? runId };
  const done = () => {
    setDialog(null);
    void load();
  };
  const heartbeat = info["heartbeatDetails"];
  const lastFailure = obj(info["lastFailure"]);

  return (
    <Page>
      <PageHeader
        title={activityId}
        adornment={
          <>
            <CopyButton value={activityId} what="activity ID" />
            {a ? <Badge appearance="tint" variant={STATUS_TONE[a.status]}>{activityStatusLabel(a.status)}</Badge> : null}
          </>
        }
        subtitle={
          <>
            {a ? `${a.activityType} · ` : ""}standalone activity · namespace <span className="text-body-1-strong text-fg">{namespace}</span> · {profile.name}
          </>
        }
        actions={
          <>
            <Button appearance="subtle" onClick={() => void load()} loading={loading && detail !== null}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            {runningNow ? (
              <>
                <Button appearance="secondary" onClick={() => setDialog("cancel")}>
                  <Icon icon={Dismiss} /> Request cancellation
                </Button>
                <Button appearance="secondary" onClick={() => setDialog("terminate")}>
                  <Icon icon={Stop} /> Terminate…
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <CancelDialog
        open={dialog === "cancel"}
        onOpenChange={(open) => !open && setDialog(null)}
        workflowId={activityId}
        description="The activity is asked to cancel. Its worker sees the request at its next heartbeat and may clean up, finish anyway or never heartbeat at all. To end it at once, terminate it."
        busy={action.busy}
        error={action.error}
        onCancelWorkflow={(reason) => void action.run(() => client.temporal.activities.cancel({ ...ref, reason: reason || null }).then(() => undefined), done)}
      />
      <TerminateDialog
        open={dialog === "terminate"}
        onOpenChange={(open) => !open && setDialog(null)}
        workflowId={activityId}
        description="The activity ends at once: its worker is not told and its result, if it still sends one, is dropped. This cannot be undone."
        reasonNote="It is kept with the activity."
        busy={action.busy}
        error={action.error}
        onTerminate={(reason) => void action.run(() => client.temporal.activities.terminate({ ...ref, reason }).then(() => undefined), done)}
      />
      <PageRegion className="overflow-auto px-inset-lg py-inset-md">
        {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
        {!detail && !error ? <LoadingRows label="Loading the activity" /> : null}
        {detail && a ? (
          <div className="flex flex-col gap-stack-md">
            <Section title="Overview">
              <DescriptionList layout="aligned">
                <Row term="Activity type">{a.activityType}</Row>
                <Row term="Task queue">
                  <LinkButton onOpen={(e) => go({ kind: "temporal.taskQueue", params: { namespace, name: a.taskQueue }, title: `Task queue ${a.taskQueue}` }, e)}>{a.taskQueue}</LinkButton>
                </Row>
                <Row term="Run ID">
                  <span className="flex items-center gap-inline-xs">
                    <span className="font-mono text-code">{a.runId}</span>
                    <CopyButton value={a.runId} what="run ID" />
                  </span>
                </Row>
                <Row term="Status">
                  {activityStatusLabel(a.status)}
                  {detail.runState ? ` · ${words(detail.runState).toLowerCase()}` : ""}
                  {detail.retryState && detail.retryState !== "InProgress" ? ` · ${words(detail.retryState).toLowerCase()}` : ""}
                </Row>
                <Row term="Attempt">{detail.attempt > 0 ? String(detail.attempt) : ""}</Row>
                <Row term="Scheduled">{formatTime(a.startTime)}</Row>
                <Row term="Closed">{a.closeTime ? formatTime(a.closeTime) : ""}</Row>
                <Row term="Duration">{a.durationMs === undefined ? "" : formatDuration(a.durationMs)}</Row>
                <Row term="Timeouts">
                  {[
                    protoDuration(info["startToCloseTimeout"]) && `start to close ${protoDuration(info["startToCloseTimeout"])}`,
                    protoDuration(info["scheduleToCloseTimeout"]) && `schedule to close ${protoDuration(info["scheduleToCloseTimeout"])}`,
                    protoDuration(info["scheduleToStartTimeout"]) && `schedule to start ${protoDuration(info["scheduleToStartTimeout"])}`,
                    protoDuration(info["heartbeatTimeout"]) && `heartbeat ${protoDuration(info["heartbeatTimeout"])}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Row>
                <Row term="Retry policy">{retryPolicyText(info["retryPolicy"])}</Row>
                <Row term="Last heartbeat">{info["lastHeartbeatTime"] ? formatTime(text(info["lastHeartbeatTime"])) : ""}</Row>
                <Row term="Last worker">{text(info["lastWorkerIdentity"])}</Row>
                {text(info["canceledReason"]) ? <Row term="Cancel reason">{text(info["canceledReason"])}</Row> : null}
                {info["nextAttemptScheduleTime"] ? <Row term="Next attempt">{formatTime(text(info["nextAttemptScheduleTime"]))}</Row> : null}
              </DescriptionList>
            </Section>
            <Section title="Input">
              <JsonViewer value={detail.input} defaultExpandDepth={3} aria-label="Activity input" className="max-h-panel-sm" />
            </Section>
            {detail.failure ? (
              <Section title="Failure">
                <Failure failure={detail.failure} />
              </Section>
            ) : detail.result ? (
              <Section title="Result">
                <JsonViewer value={detail.result} defaultExpandDepth={3} aria-label="Activity result" className="max-h-panel-sm" />
              </Section>
            ) : (
              <Section title="Result">
                <EmptyLine>{runningNow ? "The activity is still running." : "No result."}</EmptyLine>
              </Section>
            )}
            {runningNow && Object.keys(lastFailure).length > 0 ? (
              <Section title="Last failure">
                <Failure failure={lastFailure} />
              </Section>
            ) : null}
            {heartbeat !== undefined ? (
              <Section title="Heartbeat details">
                <JsonViewer value={heartbeat} defaultExpandDepth={2} aria-label="Heartbeat details" className="max-h-panel-sm" />
              </Section>
            ) : null}
            <Section title="All fields">
              <JsonViewer value={info} defaultExpandDepth={1} aria-label="Activity fields" className="max-h-panel-md" />
            </Section>
          </div>
        ) : null}
        {detail === null && error === null && activityId === "" ? <EmptyLine>No activity named.</EmptyLine> : null}
      </PageRegion>
    </Page>
  );
}
