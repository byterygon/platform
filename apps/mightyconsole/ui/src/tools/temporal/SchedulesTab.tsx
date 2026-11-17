// Schedules (Mightyconsole spec §9.3): `temporal.schedules { namespace }` lists them with their next
// runs and recent actions; `temporal.schedule { namespace, scheduleId }` shows one with Pause or
// Resume, Run now and Delete (the typed id), each behind its confirmation.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { JsonViewer } from "@/components/ui/json-viewer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { ScheduleDetail, ScheduleSummary } from "@/gen/api";
import { ArrowClockwise, Delete, Pause, Play } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { DeleteScheduleDialog, PauseDialog, TriggerDialog, useAction } from "./ActionDialogs";
import { formatTime } from "./format";
import { statusLabel } from "./WorkflowsTab";

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

export function SchedulesTab({ tab, profile, connId, client, useTabActions, note, openTab }: TabProps) {
  const namespace = text(tab.params["namespace"]) || "default";
  const [rows, setRows] = useState<ScheduleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const list = await client.temporal.schedules.list({ connId, namespace, query: null });
      if (mine === generation.current) setRows(list);
    } catch (e) {
      if (mine === generation.current) {
        setRows([]);
        setError(note(e));
      }
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, namespace, note]);

  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({ refresh: () => void load() });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label="Schedule list actions">
        <ToolbarGroup>
          <Button size="small" onClick={() => void load()}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        </ToolbarGroup>
        <Badge variant="neutral">
          {formatCount(rows.length)} {rows.length === 1 ? "schedule" : "schedules"} · {namespace} · {profile.name}
        </Badge>
      </Toolbar>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {loading && rows.length === 0 ? (
        <LoadingRows label="Loading schedules" />
      ) : rows.length === 0 && !error ? (
        <EmptyLine>No schedules in {namespace}.</EmptyLine>
      ) : rows.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col p-inset-sm">
          <Table aria-label="Schedules" className="min-h-0 flex-1">
            <TableHeader>
              <TableRow>
                <TableHead>Schedule ID</TableHead>
                <TableHead>Workflow type</TableHead>
                <TableHead>Spec</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const last = s.recentActions[s.recentActions.length - 1];
                return (
                  <TableRow key={s.scheduleId}>
                    <TableCell>
                      <Button size="small" appearance="subtle" onClick={() => openTab({ kind: "temporal.schedule", params: { namespace, scheduleId: s.scheduleId }, title: s.scheduleId })}>
                        {s.scheduleId}
                      </Button>
                    </TableCell>
                    <TableCell>{s.workflowType}</TableCell>
                    <TableCell>{s.spec}</TableCell>
                    <TableCell>
                      <Badge variant={s.paused ? "warning" : "success"}>{s.paused ? "Paused" : "Active"}</Badge>
                    </TableCell>
                    <TableCell>{formatTime(s.nextRuns[0])}</TableCell>
                    <TableCell>{last ? `${formatTime(last.actualTime ?? last.scheduledTime)} ${last.status ? statusLabel(last.status as never) : ""}`.trim() : ""}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

type Dialog = "pause" | "resume" | "trigger" | "delete" | null;

export function ScheduleTab({ tab, connId, client, useTabActions, note, openTab }: TabProps) {
  const namespace = text(tab.params["namespace"]) || "default";
  const scheduleId = text(tab.params["scheduleId"]);
  const [detail, setDetail] = useState<ScheduleDetail | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleted, setDeleted] = useState(false);
  const action = useAction(note);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const d = await client.temporal.schedules.describe({ connId, namespace, scheduleId });
      if (mine === generation.current) setDetail(d);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, namespace, scheduleId, note]);

  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({ refresh: () => void load() });

  const close = () => {
    setDialog(null);
    action.clear();
  };
  const done = () => {
    close();
    void load();
  };
  const ref = { connId: connId ?? "", namespace, scheduleId };

  if (deleted) return <EmptyLine>{scheduleId} was deleted. Close this tab.</EmptyLine>;
  const s = detail?.summary;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label="Schedule actions">
        <ToolbarGroup>
          <Button size="small" onClick={() => void load()}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
          {s?.paused ? (
            <Button size="small" onClick={() => setDialog("resume")}>
              <Icon icon={Play} /> Resume
            </Button>
          ) : (
            <Button size="small" disabled={s === undefined} onClick={() => setDialog("pause")}>
              <Icon icon={Pause} /> Pause
            </Button>
          )}
          <Button size="small" disabled={s === undefined} onClick={() => setDialog("trigger")}>
            <Icon icon={Play} /> Run now
          </Button>
          <Button size="small" disabled={s === undefined} onClick={() => setDialog("delete")}>
            <Icon icon={Delete} /> Delete
          </Button>
        </ToolbarGroup>
      </Toolbar>
      {error ? <ErrorState error={error} onRetry={() => void load()} onRefresh={() => void load()} /> : null}
      {loading && detail === null ? <LoadingRows label="Loading the schedule" /> : null}
      {detail && s ? (
        <div className="min-h-0 flex-1 overflow-auto p-inset-md">
          <header className="flex flex-wrap items-center gap-x-inline-md gap-y-stack-xs pb-inset-md">
            <h2 className="text-subtitle-2 text-fg">{s.scheduleId}</h2>
            <Badge variant={s.paused ? "warning" : "success"}>{s.paused ? "Paused" : "Active"}</Badge>
            <span className="text-body-1 text-fg-muted">{s.workflowType}</span>
            <span className="text-body-1 text-fg-muted">{s.spec}</span>
            {s.notes ? <span className="text-body-1 text-fg-muted">“{s.notes}”</span> : null}
          </header>
          <div className="flex flex-col gap-stack-md">
            <section className="flex flex-col gap-stack-xs">
              <h3 className="text-body-1-strong text-fg">Upcoming runs</h3>
              {s.nextRuns.length === 0 ? (
                <EmptyLine>{s.paused ? "Paused: no run is planned." : "No run is planned."}</EmptyLine>
              ) : (
                <ul aria-label="Upcoming runs" className="text-body-1 text-fg">
                  {s.nextRuns.map((t) => (
                    <li key={t}>{formatTime(t)}</li>
                  ))}
                </ul>
              )}
            </section>
            <section className="flex flex-col gap-stack-xs">
              <h3 className="text-body-1-strong text-fg">Recent runs</h3>
              {s.recentActions.length === 0 ? (
                <EmptyLine>It has not run yet.</EmptyLine>
              ) : (
                <Table aria-label="Recent runs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Scheduled</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Workflow ID</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...s.recentActions].reverse().map((a) => (
                      <TableRow key={`${a.workflowId}/${a.runId}`}>
                        <TableCell>{formatTime(a.scheduledTime)}</TableCell>
                        <TableCell>{formatTime(a.actualTime)}</TableCell>
                        <TableCell>
                          <Button size="small" appearance="subtle" onClick={() => openTab({ kind: "temporal.workflow", params: { namespace, workflowId: a.workflowId, runId: a.runId }, title: a.workflowId })}>
                            {a.workflowId}
                          </Button>
                        </TableCell>
                        <TableCell>{a.status}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
            <section className="flex flex-col gap-stack-xs">
              <h3 className="text-body-1-strong text-fg">Details</h3>
              <DescriptionList divided>
                <DescriptionListItem>
                  <DescriptionListTerm>Actions taken</DescriptionListTerm>
                  <DescriptionListDetails>{text(detail.info["actionCount"]) || "0"}</DescriptionListDetails>
                </DescriptionListItem>
                <DescriptionListItem>
                  <DescriptionListTerm>Overlap policy</DescriptionListTerm>
                  <DescriptionListDetails>{text(detail.policies["overlapPolicy"]).replace("SCHEDULE_OVERLAP_POLICY_", "") || "Skip"}</DescriptionListDetails>
                </DescriptionListItem>
                <DescriptionListItem>
                  <DescriptionListTerm>Created</DescriptionListTerm>
                  <DescriptionListDetails>{formatTime(text(detail.info["createTime"]))}</DescriptionListDetails>
                </DescriptionListItem>
              </DescriptionList>
              <JsonViewer value={{ spec: detail.spec, action: detail.action, policies: detail.policies, state: detail.state }} defaultExpandDepth={2} aria-label="Schedule definition" className="max-h-panel-md" />
            </section>
          </div>
        </div>
      ) : null}
      <PauseDialog
        open={dialog === "pause" || dialog === "resume"}
        onOpenChange={(o) => !o && close()}
        scheduleId={scheduleId}
        pausing={dialog !== "resume"}
        busy={action.busy}
        error={action.error}
        onConfirm={(n) => void action.run(() => (dialog === "resume" ? client.temporal.schedules.unpause({ ...ref, note: n || null, overlap: null }) : client.temporal.schedules.pause({ ...ref, note: n || null, overlap: null })).then(() => undefined), done)}
      />
      <TriggerDialog
        open={dialog === "trigger"}
        onOpenChange={(o) => !o && close()}
        scheduleId={scheduleId}
        busy={action.busy}
        error={action.error}
        onConfirm={(overlap) => void action.run(() => client.temporal.schedules.trigger({ ...ref, note: null, overlap }).then(() => undefined), done)}
      />
      <DeleteScheduleDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && close()}
        scheduleId={scheduleId}
        busy={action.busy}
        error={action.error}
        onDelete={() =>
          void action.run(
            () => client.temporal.schedules.delete({ connId: connId ?? "", namespace, scheduleId }).then(() => undefined),
            () => {
              close();
              setDeleted(true);
            },
          )
        }
      />
    </div>
  );
}
