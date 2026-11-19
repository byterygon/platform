// Schedules (Mightyconsole spec §9.3): `temporal.schedules { namespace }` lists them with their next
// runs and recent actions; a row opens `temporal.schedule` (ScheduleTab.tsx).
import { linkTo } from "@/app/tab-view";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Page, PageHeader, PageRegion, gutterTable, linkHandlers } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { cn } from "@/lib/cn";
import { formatCount } from "@/app/messages";
import type { ScheduleSummary } from "@/gen/api";
import { Add, ArrowClockwise } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { formatTime } from "./format";
import { ScheduleSheet } from "./ScheduleSheet";
import { useSheetRequest } from "./sheet-parts";
import { statusLabel } from "./WorkflowsTab";

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

export function SchedulesTab({ tab, profile, connId, client, active, useTabActions, note, openTab, go: goProp }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });

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
            <Button appearance="primary" onClick={() => setCreating(true)}>
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
        suggestions={{ types: [...new Set(rows.map((s) => s.workflowType).filter(Boolean))] }}
        note={note}
        onSaved={(scheduleId) => {
          void load();
          go({ kind: "temporal.schedule", params: { namespace, scheduleId }, title: scheduleId });
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
                      <Button size="small" appearance="subtle" {...linkHandlers((e) => go({ kind: "temporal.schedule", params: { namespace, scheduleId: s.scheduleId }, title: s.scheduleId }, e))}>
                        {s.scheduleId}
                      </Button>
                    </TableCell>
                    <TableCell>{s.workflowType}</TableCell>
                    <TableCell>{s.spec}</TableCell>
                    <TableCell>
                      <Badge appearance="tint" variant={s.paused ? "warning" : "success"}>{s.paused ? "Paused" : "Active"}</Badge>
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
