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
import { CopyButton, Page, PageHeader, PageRegion, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { cn } from "@/lib/cn";
import { formatCount } from "@/app/messages";
import type { ScheduleDetail, ScheduleSummary } from "@/gen/api";
import { Add, ArrowClockwise, Delete, Edit, Pause, Play } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { DeleteScheduleDialog, PauseDialog, TriggerDialog, useAction } from "./ActionDialogs";
import { formatTime } from "./format";
import { ScheduleSheet } from "./ScheduleSheet";
import { useSheetRequest } from "./sheet-parts";
import { statusLabel } from "./WorkflowsTab";

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

export function SchedulesTab({ tab, profile, connId, client, active, useTabActions, note, openTab }: TabProps) {
  const namespace = text(tab.params["namespace"]) || "default";
  const [creating, setCreating] = useState(false);
  // "Create schedule" from the palette opens this tab and asks it for the sheet.
  const request = useSheetRequest(profile.id, "createSchedule");
  useEffect(() => {
    if (request.waiting && active && connId !== null) {
      request.take();
      setCreating(true);
    }
  }, [request, active, connId]);
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
    <Page>
      <PageHeader
        title="Schedules"
        subtitle={`${profile.name} · namespace ${namespace} · ${formatCount(rows.length)} ${rows.length === 1 ? "schedule" : "schedules"}`}
        actions={
          <>
            <Button appearance="subtle" onClick={() => void load()}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="secondary" onClick={() => setCreating(true)}>
              <Icon icon={Add} /> Create schedule
            </Button>
          </>
        }
      />
      <ScheduleSheet
        open={creating}
        onOpenChange={setCreating}
        client={client}
        connId={connId}
        profile={profile}
        namespace={namespace}
        mode={{ kind: "create" }}
        note={note}
        onSaved={(scheduleId) => {
          void load();
          openTab({ kind: "temporal.schedule", params: { namespace, scheduleId }, title: scheduleId });
        }}
      />
      <PageRegion>
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {loading && rows.length === 0 ? (
        <LoadingRows label="Loading schedules" />
      ) : rows.length === 0 && !error ? (
        <EmptyLine>No schedules in {namespace}.</EmptyLine>
      ) : rows.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Table aria-label="Schedules" className={cn("min-h-0 flex-1", gutterTable)}>
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
      </PageRegion>
    </Page>
  );
}

type Dialog = "pause" | "resume" | "trigger" | "delete" | "edit" | null;

export function ScheduleTab({ tab, profile, connId, client, useTabActions, note, openTab }: TabProps) {
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
      <PageHeader
        title={scheduleId}
        adornment={
          <>
            <CopyButton value={scheduleId} what="schedule ID" />
            {s ? <Badge variant={s.paused ? "warning" : "success"}>{s.paused ? "Paused" : "Active"}</Badge> : null}
          </>
        }
        subtitle={s ? [s.workflowType, s.spec, s.notes ? `“${s.notes}”` : ""].filter(Boolean).join(" · ") : `${namespace} · ${profile.name}`}
        actions={
          <>
          <Button appearance="subtle" onClick={() => void load()}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
          {s?.paused ? (
            <Button appearance="secondary" onClick={() => setDialog("resume")}>
              <Icon icon={Play} /> Resume
            </Button>
          ) : (
            <Button appearance="secondary" disabled={s === undefined} onClick={() => setDialog("pause")}>
              <Icon icon={Pause} /> Pause
            </Button>
          )}
          <Button appearance="secondary" disabled={s === undefined} onClick={() => setDialog("trigger")}>
            <Icon icon={Play} /> Run now
          </Button>
          <Button appearance="secondary" disabled={detail === null} onClick={() => setDialog("edit")}>
            <Icon icon={Edit} /> Edit
          </Button>
          <Button appearance="secondary" disabled={s === undefined} onClick={() => setDialog("delete")}>
            <Icon icon={Delete} /> Delete
          </Button>
          </>
        }
      />
      {error ? <ErrorState error={error} onRetry={() => void load()} onRefresh={() => void load()} /> : null}
      {loading && detail === null ? <LoadingRows label="Loading the schedule" /> : null}
      {detail && s ? (
        <div className="mt-stack-md min-h-0 flex-1 overflow-auto border-t border-border-subtle px-inset-lg py-inset-md">
          <div className="flex flex-col gap-stack-lg">
            <section className="flex flex-col gap-stack-xs">
              <h3 className="text-body-1-strong text-fg">Upcoming runs</h3>
              {s.nextRuns.length === 0 ? (
                <EmptyLine>{s.paused ? "Paused: no run is planned." : "No run is planned."}</EmptyLine>
              ) : (
                <ul aria-label="Upcoming runs" className="text-body-1 text-fg">
                  {s.nextRuns.map((t) => (
                    <li key={t} data-at={t}>
                      {formatTime(t)}
                    </li>
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
      {detail ? (
        <ScheduleSheet
          open={dialog === "edit"}
          onOpenChange={(o) => !o && close()}
          client={client}
          connId={connId}
          profile={profile}
          namespace={namespace}
          mode={{ kind: "edit", scheduleId, form: detail.form, conflictToken: detail.conflictToken }}
          note={note}
          onSaved={() => void load()}
          onReload={async () => {
            if (connId === null) return null;
            const fresh = await client.temporal.schedules.describe({ connId, namespace, scheduleId });
            setDetail(fresh);
            return { form: fresh.form, conflictToken: fresh.conflictToken };
          }}
        />
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
