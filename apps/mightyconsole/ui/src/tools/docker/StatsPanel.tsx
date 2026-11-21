// A container's Stats (Mightyconsole spec §10.4, TSK-81 mockup frame docker-stats): stat tiles
// (CPU, memory used and limit, network in and out, block I/O, PIDs) and charts of the last
// 5 minutes from `docker.containers.stats`, one sample a second kept in the tab. One axis per
// chart; two series get a legend and the chart palette's first two slots; the Chart's tooltip and
// keyboard read the values at a time; Table lists the samples. A stopped container says "Not
// running". The stream is push-only: the server drops samples a paused reader did not take, and
// the count shows in the status bar. Beside them, the container's Processes (`docker top`, batch 4).
import { useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "@/components/ui/chart";
import { Stat, StatDescription, StatLabel, StatValue } from "@/components/ui/stat";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleButton } from "@/components/ui/toggle-button";
import { liveTimeout } from "@/app/client";
import { PageBar, chipClass, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LiveBadge } from "@/app/states";
import * as api from "@/gen/api";
import type { ContainerOverview } from "@/gen/api";
import { cn } from "@/lib/cn";
import type { DescribedError, LiveState, TabProps } from "../types";
import { type StatsPoint, type StatsSample, formatBytes, formatMiB, formatRate, parseLines, withRates } from "./format";
import { ProcessesPanel } from "./ProcessesPanel";

/** Samples kept: 5 minutes at one a second. */
export const STATS_WINDOW = 300;

/** Rows of the Table view: the last minute. */
const TABLE_ROWS = 60;

/** `10:42:16`. */
export function clockText(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** `38.2 %`, `0.42 %`, `0.031 %`: small shares keep enough digits to tell the ticks apart. */
export function formatPercent(v: number): string {
  const a = Math.abs(v);
  return `${a === 0 ? "0" : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : a >= 0.1 ? v.toFixed(2) : v.toFixed(3)} %`;
}

/** CPUs the percentage is read against: the limit when there is one, else the host's. */
export function cpuBase(overview: Pick<ContainerOverview, "cpus">, sample: Pick<StatsSample, "onlineCpus">): { cpus: number; limit: boolean } {
  return overview.cpus !== undefined ? { cpus: overview.cpus, limit: true } : { cpus: sample.onlineCpus, limit: false };
}

export interface StatsPanelProps extends Pick<TabProps, "client" | "connId" | "note" | "onLive" | "useTabActions"> {
  container: string;
  overview: ContainerOverview;
}

export function StatsPanel({ client, connId, note, onLive, useTabActions, container, overview }: StatsPanelProps) {
  const [points, setPoints] = useState<StatsPoint[]>([]);
  const [error, setError] = useState<DescribedError | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [table, setTable] = useState(false);
  const [restart, setRestart] = useState(0);
  const running = overview.running;
  const last = useRef<StatsSample | undefined>(undefined);

  useEffect(() => {
    if (connId === null || !running) return undefined;
    setError(null);
    let stopped = false;
    const call = client.docker.containers.stats({ connId, id: container, streamId: crypto.randomUUID() }, liveTimeout(api.procedures.docker.containers.stats));
    const report = (next: LiveState | null) => {
      setLive(next);
      onLive(next);
    };
    report({ status: "live" });
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for await (const chunk of call.chunks()) {
          const samples = parseLines<StatsSample>(chunk, decoder);
          setPoints((list) => {
            const next = [...list];
            for (const s of samples) {
              next.push(withRates(last.current, s));
              last.current = s;
            }
            return next.slice(-STATS_WINDOW);
          });
        }
        const summary = await call.result;
        report({ status: "ended", reason: "the container stopped", dropped: summary.dropped });
      } catch (e) {
        if (stopped) return;
        const d = note(e);
        if (d.code === "Cancelled") report({ status: "ended", reason: "stopped" });
        else {
          setError(d);
          report({ status: "ended", reason: d.title });
        }
      }
    })();
    return () => {
      stopped = true;
      call.cancel();
      onLive(null);
    };
  }, [client, connId, container, note, onLive, running, restart]);

  useTabActions({ refresh: () => setRestart((n) => n + 1) });

  const now = points[points.length - 1];
  const data = useMemo(
    () =>
      points.map((p) => ({
        t: p.timeMs,
        cpu: p.cpuPercent ?? 0,
        mem: p.memoryUsed / 1024 ** 2,
        rx: p.rxRate,
        tx: p.txRate,
        read: p.readRate,
        write: p.writeRate,
      })),
    [points],
  );

  if (!running) {
    return (
      <EmptyLine>
        Not running: {container} is {overview.state}. Start it to see its stats.
      </EmptyLine>
    );
  }
  const base = now ? cpuBase(overview, now) : null;
  const time = (v: unknown) => clockText(Number(v));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar aria-label="Stats options" className="pb-stack-sm">
        <span className="text-body-1 text-fg-muted">One sample a second from docker.containers.stats; the last 5 minutes stay in the tab.</span>
        <span className="flex-1" />
        {live ? <LiveBadge live={live} unit="samples/s" /> : null}
        <ToggleButton size="small" appearance="outline" pressed={table} onPressedChange={setTable} className={chipClass}>
          Table
        </ToggleButton>
      </PageBar>
      {error ? (
        <div className="px-inset-lg pb-stack-sm">
          <ErrorState error={error} onRetry={() => setRestart((n) => n + 1)} />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 border-t border-border-subtle">
        {/* A container: the tiles and charts wrap by the room beside Processes, not by the window. */}
        <div className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-stack-md overflow-auto px-inset-lg py-inset-md">
          {!now ? (
            <EmptyLine>Waiting for the first sample…</EmptyLine>
          ) : (
            <>
              <div role="group" aria-label="Now" className="grid grid-cols-2 gap-inline-lg @xl:grid-cols-3 @3xl:grid-cols-5">
                <Stat size="sm">
                  <StatLabel>CPU</StatLabel>
                  <StatValue>{now.cpuPercent === undefined ? "—" : `${now.cpuPercent.toFixed(1)} %`}</StatValue>
                  <StatDescription>
                    of {base!.cpus} {base!.cpus === 1 ? "CPU" : "CPUs"}
                    {base!.limit ? " (limit)" : ""}
                  </StatDescription>
                </Stat>
                <Stat size="sm">
                  <StatLabel>Memory</StatLabel>
                  <StatValue>{formatMiB(now.memoryUsed)}</StatValue>
                  <StatDescription>
                    {overview.memoryLimit
                      ? `of ${formatMiB(overview.memoryLimit)} · ${Math.round((now.memoryUsed / overview.memoryLimit) * 100)} %`
                      : `no limit${now.memoryLimit ? ` · host ${formatMiB(now.memoryLimit)}` : ""}`}
                  </StatDescription>
                </Stat>
                <Stat size="sm">
                  <StatLabel>Network in</StatLabel>
                  <StatValue>{formatRate(now.rxRate)}</StatValue>
                  <StatDescription>out {formatRate(now.txRate)}</StatDescription>
                </Stat>
                <Stat size="sm">
                  <StatLabel>Block I/O</StatLabel>
                  <StatValue>{formatBytes(now.blockRead)} read</StatValue>
                  <StatDescription>{formatBytes(now.blockWrite)} written, since start</StatDescription>
                </Stat>
                <Stat size="sm">
                  <StatLabel>PIDs</StatLabel>
                  <StatValue>{now.pids}</StatValue>
                  <StatDescription>{now.pidsLimit ? `limit ${now.pidsLimit}` : "limit none"}</StatDescription>
                </Stat>
              </div>
              {table ? (
                <Table aria-label="Samples, newest first" size="small" className={cn("min-h-0", gutterTable)}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead align="end">CPU</TableHead>
                      <TableHead align="end">Memory</TableHead>
                      <TableHead align="end">Received</TableHead>
                      <TableHead align="end">Sent</TableHead>
                      <TableHead align="end">Read</TableHead>
                      <TableHead align="end">Written</TableHead>
                      <TableHead align="end">PIDs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...points]
                      .slice(-TABLE_ROWS)
                      .reverse()
                      .map((p) => (
                        <TableRow key={p.timeMs}>
                          <TableCell className="font-mono text-code">{clockText(p.timeMs)}</TableCell>
                          <TableCell align="end" className="tabular-nums">
                            {p.cpuPercent === undefined ? "—" : `${p.cpuPercent.toFixed(1)} %`}
                          </TableCell>
                          <TableCell align="end" className="tabular-nums">
                            {formatMiB(p.memoryUsed)}
                          </TableCell>
                          <TableCell align="end" className="tabular-nums">
                            {formatRate(p.rxRate)}
                          </TableCell>
                          <TableCell align="end" className="tabular-nums">
                            {formatRate(p.txRate)}
                          </TableCell>
                          <TableCell align="end" className="tabular-nums">
                            {formatRate(p.readRate)}
                          </TableCell>
                          <TableCell align="end" className="tabular-nums">
                            {formatRate(p.writeRate)}
                          </TableCell>
                          <TableCell align="end" className="tabular-nums">
                            {p.pids}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="grid grid-cols-1 gap-stack-lg @2xl:grid-cols-2">
                  <section aria-label="CPU chart" className="flex flex-col gap-stack-xs">
                    <h3 className="text-body-1-strong text-fg">
                      CPU <span className="text-caption-1 text-fg-muted">% (100 is one CPU)</span>
                    </h3>
                    <Chart type="line" aria-label="CPU, last 5 minutes" data={data} x="t" xFormat={time} series={[{ key: "cpu", label: "CPU", color: 1 }]} valueFormat={formatPercent} grid />
                  </section>
                  <section aria-label="Memory chart" className="flex flex-col gap-stack-xs">
                    <h3 className="text-body-1-strong text-fg">
                      Memory <span className="text-caption-1 text-fg-muted">MiB used{overview.memoryLimit ? `, of ${formatMiB(overview.memoryLimit)}` : ", no limit"}</span>
                    </h3>
                    <Chart type="area" aria-label="Memory, last 5 minutes" data={data} x="t" xFormat={time} series={[{ key: "mem", label: "Memory", color: 1 }]} valueFormat={(v) => `${v.toFixed(1)} MiB`} grid />
                  </section>
                  <section aria-label="Network chart" className="flex flex-col gap-stack-xs">
                    <h3 className="text-body-1-strong text-fg">
                      Network <span className="text-caption-1 text-fg-muted">per second</span>
                    </h3>
                    <Chart
                      type="line"
                      aria-label="Network, last 5 minutes"
                      data={data}
                      x="t"
                      xFormat={time}
                      series={[
                        { key: "rx", label: "Received", color: 1 },
                        { key: "tx", label: "Sent", color: 2 },
                      ]}
                      valueFormat={formatRate}
                      grid
                    />
                  </section>
                  <section aria-label="Block I/O chart" className="flex flex-col gap-stack-xs">
                    <h3 className="text-body-1-strong text-fg">
                      Block I/O <span className="text-caption-1 text-fg-muted">per second</span>
                    </h3>
                    <Chart
                      type="line"
                      aria-label="Block I/O, last 5 minutes"
                      data={data}
                      x="t"
                      xFormat={time}
                      series={[
                        { key: "read", label: "Read", color: 1 },
                        { key: "write", label: "Written", color: 2 },
                      ]}
                      valueFormat={formatRate}
                      grid
                    />
                  </section>
                </div>
              )}
            </>
          )}
        </div>
        <ProcessesPanel client={client} connId={connId} note={note} container={container} />
      </div>
    </div>
  );
}
