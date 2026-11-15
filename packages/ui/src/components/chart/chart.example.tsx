import { useMemo } from "react";
import { Chart, ChartLegend, ChartSparkline, ChartTooltip } from "@/components/chart/chart";

const hours = ["00", "03", "06", "09", "12", "15", "18", "21"].map((hour, i) => ({ hour: `${hour}:00`, reads: [120, 80, 95, 410, 520, 480, 300, 190][i]!, writes: [20, 12, 18, 140, 160, 150, 90, 40][i]! }));

/** The smallest useful Chart: one bar series. */
export function ChartMinimal() {
  return <Chart aria-label="Reads per 3 hours" data={hours} x="hour" series={[{ key: "reads", label: "Reads" }]} className="max-w-panel-md" />;
}

/** A dashboard: grouped bars with the tooltip shown, a stacked area, 20,000 points of latency as a line (decimated), sparklines, and an empty chart. */
export function ChartRealistic() {
  const latency = useMemo(() => Array.from({ length: 20_000 }, (_, i) => ({ t: i, p50: 4 + Math.sin(i / 300) * 2 + ((i * 7919) % 13) / 10, p99: 18 + Math.sin(i / 250) * 6 + ((i * 104729) % 37) / 4 })), []);
  return (
    <div className="flex w-full min-w-0 max-w-panel-xl flex-col gap-stack-lg">
      <Chart
        aria-label="Statements per 3 hours, reads and writes"
        data={hours}
        x="hour"
        series={[
          { key: "reads", label: "Reads" },
          { key: "writes", label: "Writes" },
        ]}
        defaultActiveIndex={4}
      />
      <Chart
        type="area"
        stacked
        aria-label="Connections by state, stacked"
        data={hours.map((h, i) => ({ hour: h.hour, active: [3, 2, 2, 9, 12, 11, 7, 4][i]!, idle: [10, 9, 9, 14, 16, 15, 13, 11][i]!, waiting: [0, 0, 1, 2, 4, 3, 1, 0][i]! }))}
        x="hour"
        series={[
          { key: "active", label: "Active" },
          { key: "idle", label: "Idle" },
          { key: "waiting", label: "Waiting on a lock" },
        ]}
      />
      <Chart
        type="line"
        aria-label="Statement latency in ms, last 20,000 statements"
        data={latency}
        x="t"
        valueFormat={(v) => `${v.toFixed(0)} ms`}
        series={[
          { key: "p50", label: "p50", color: 1 },
          { key: "p99", label: "p99", color: 2 },
        ]}
      />
      <div className="flex flex-wrap items-center gap-inline-lg text-body text-fg">
        <span className="flex items-center gap-inline-sm">
          orders <ChartSparkline aria-label="Inserts per minute" values={[3, 5, 4, 8, 12, 9, 14, 13, 18]} area />
        </span>
        <span className="flex items-center gap-inline-sm">
          events <ChartSparkline aria-label="Inserts per minute" values={[40, 38, 41, 30, 22, 25, 18]} color={2} />
        </span>
      </div>
      <Chart
        stacked
        aria-label="Statements by kind per 3 hours, stacked"
        data={hours.map((h, i) => ({ hour: h.hour, select: 40 + i * 5, insert: 12 + i, update: 9 + (i % 3), delete: 2 + (i % 2), ddl: i % 4 === 0 ? 1 : 0, copy: i % 3, vacuum: 1, other: 3 }))}
        x="hour"
        series={["select", "insert", "update", "delete", "ddl", "copy", "vacuum", "other"].map((key) => ({ key, label: key.toUpperCase() }))}
      />
      <div className="flex flex-wrap items-center gap-inline-md">
        {([1, 2, 3, 4, 5, 6, 7, 8] as const).map((color) => (
          <ChartSparkline key={color} color={color} area aria-label={`Series ${color}`} values={[2, 4, 3, 6, 5, 8].map((v) => v + color)} className="w-control-lg" />
        ))}
      </div>
      <Chart aria-label="Locks held" data={[]} x="t" series={[{ key: "locks", label: "Locks" }]} />
      <div className="flex flex-wrap items-start gap-gap-lg">
        <ChartLegend>
          <li>Legend part, standalone</li>
        </ChartLegend>
        <div className="relative h-control-lg w-panel-xs">
          <ChartTooltip title="Tooltip part, standalone">value</ChartTooltip>
        </div>
      </div>
    </div>
  );
}
