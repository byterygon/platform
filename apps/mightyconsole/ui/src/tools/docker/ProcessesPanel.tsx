// A running container's processes beside its Stats (TSK-81 mockup frame docker-stats, DOC-21 Open
// question 45 q): `docker.containers.top` every 5 seconds while the page is visible, a table of
// PID, user, CPU and command. The host's `ps` decides the columns (`ps -ef`: UID and C, the CPU
// share; BusyBox: USER and no CPU), so a column the host does not print is left out.
import { useEffect, useRef, useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyLine, ErrorState } from "@/app/states";
import type { ContainerTop } from "@/gen/api";
import { cn } from "@/lib/cn";
import type { DescribedError, TabProps } from "../types";
import { processColumns } from "./format";

/** How often the processes are asked for. */
export const TOP_INTERVAL_MS = 5000;

const mono = "font-mono text-code";

export interface ProcessesPanelProps extends Pick<TabProps, "client" | "connId" | "note" | "active"> {
  container: string;
}

export function ProcessesPanel({ client, connId, note, container, active }: ProcessesPanelProps) {
  const [top, setTop] = useState<ContainerTop | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [retry, setRetry] = useState(0);
  const noteRef = useRef(note);
  noteRef.current = note;

  useEffect(() => {
    // The tab in the background does not ask (TSK-107); shown again, it asks at once.
    if (connId === null || !active) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const ask = async () => {
      timer = null;
      if (stopped || !visible()) return;
      try {
        const next = await client.docker.containers.top({ connId, id: container });
        if (stopped) return;
        setTop(next);
        setError(null);
      } catch (e) {
        if (stopped) return;
        setError(noteRef.current(e));
        // A refusal (gone, stopped) is not asked again until Retry.
        return;
      }
      timer = setTimeout(() => void ask(), TOP_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (visible() && timer === null) void ask();
      else if (!visible() && timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    void ask();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, connId, container, retry, active]);

  const cols = top ? processColumns(top.titles) : null;
  const cell = (row: readonly string[], i: number) => (i < 0 ? "" : (row[i] ?? ""));
  return (
    <aside aria-label="Processes" className="flex w-panel-sm max-w-1/2 min-w-0 shrink-0 flex-col gap-stack-sm overflow-auto border-s border-border-subtle py-inset-md">
      <div className="flex flex-col gap-stack-xs px-inset-md">
        <h3 className="text-body-1-strong text-fg">
          Processes {top ? <span className="text-body-1 text-fg-muted">{top.processes.length}</span> : null}
        </h3>
        <p className="text-caption-1 text-fg-muted">
          <span className={mono}>docker top</span> every 5 s while this page is visible
        </p>
      </div>
      {error ? (
        <div className="px-inset-md">
          <ErrorState error={error} onRetry={() => setRetry((n) => n + 1)} />
        </div>
      ) : null}
      {top && cols ? (
        top.processes.length === 0 ? (
          <EmptyLine>No processes.</EmptyLine>
        ) : (
          <Table aria-label="Processes" size="small" className="[&_td:first-child]:ps-inset-md [&_td:last-child]:pe-inset-md [&_th:first-child]:ps-inset-md [&_th:last-child]:pe-inset-md">
            <TableHeader>
              <TableRow>
                <TableHead align="end">PID</TableHead>
                {cols.user >= 0 ? <TableHead>User</TableHead> : null}
                {cols.cpu >= 0 ? <TableHead align="end">CPU %</TableHead> : null}
                <TableHead>Command</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.processes.map((row, i) => (
                <TableRow key={`${cell(row, cols.pid)}-${i}`}>
                  <TableCell align="end" className={cn(mono, "tabular-nums")}>
                    {cell(row, cols.pid)}
                  </TableCell>
                  {cols.user >= 0 ? <TableCell className="max-w-panel-xs truncate">{cell(row, cols.user)}</TableCell> : null}
                  {cols.cpu >= 0 ? (
                    <TableCell align="end" className="tabular-nums">
                      {cell(row, cols.cpu)}
                    </TableCell>
                  ) : null}
                  <TableCell className={cn(mono, "w-full max-w-0 truncate text-fg-muted")} title={cell(row, cols.command)}>
                    {cell(row, cols.command)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}
    </aside>
  );
}
