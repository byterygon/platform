// A Compose project's logs merged in the browser (TSK-81 batch 4b, mockup frame
// docker-project-logs, DOC-21 Open question 45 q): one `docker.containers.logs` stream per
// container, each line labelled with its service, put in order by Docker's timestamps. Docker
// writes RFC 3339 with up to nine fraction digits and drops trailing zeros (`…:01Z`, `…:01.5Z`,
// `…:01.123456789Z`), so text order is not time order: lines are ordered by a key with the
// fraction padded. Streams deliver at their own pace, so lines wait in a short window and are
// handed over sorted; one that comes later than lines already shown is still shown, at the end.
import type { ContainerRow } from "@/gen/api";
import type { LogStreamColor } from "@/components/ui/log-viewer";
import type { DockerLogLine } from "./format";

/** A line of the merged log: its container, the label of its service, its order. */
export interface ProjectLine extends DockerLogLine {
  container: string;
  label: string;
  /** Sort key from `ts`; a cut long line's piece takes its line's. */
  key: string;
  /** Arrival order, to keep a container's lines of one instant in their order. */
  seq: number;
}

/** An RFC 3339 time as text that sorts in time order (the fraction padded to nine digits); "" stays "". */
export function timeKey(ts: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(ts);
  if (!match) return ts;
  return `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`;
}

/** Orders lines by time, then by arrival. */
export function byTime(a: ProjectLine, b: ProjectLine): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : a.seq - b.seq;
}

/**
 * The label of each container's lines: its service, or its name when the service runs more than
 * one container (replicas) or it has none.
 */
export function serviceLabels(rows: readonly Pick<ContainerRow, "name" | "service">[]): Map<string, string> {
  const per = new Map<string, number>();
  for (const r of rows) if (r.service) per.set(r.service, (per.get(r.service) ?? 0) + 1);
  return new Map(rows.map((r) => [r.name, r.service && per.get(r.service) === 1 ? r.service : r.name]));
}

/** A chart colour per label, in label order, the eight categories over again past eight. */
export function labelColors(labels: Iterable<string>): Record<string, LogStreamColor> {
  const sorted = [...new Set(labels)].sort((a, b) => a.localeCompare(b));
  return Object.fromEntries(sorted.map((l, i) => [l, `cat-${(i % 8) + 1}` as LogStreamColor]));
}

/** Lines waiting to be shown, handed over in time order. */
export class LogMerger {
  private pending: ProjectLine[] = [];
  private seq = 0;
  /** Per container: the key of its newest line (a cut piece takes it; a resumed stream skips up to it). */
  private last = new Map<string, string>();

  /** Adds a container's lines as they came; lines not newer than `after` (a resumed stream's start) are dropped. */
  push(container: string, label: string, lines: readonly DockerLogLine[], after?: string): void {
    for (const line of lines) {
      const key = line.ts === "" ? (this.last.get(container) ?? "") : timeKey(line.ts);
      if (after !== undefined && line.ts !== "" && key <= after) continue;
      this.last.set(container, key);
      this.pending.push({ ...line, container, label, key, seq: this.seq++ });
    }
  }

  /** The key of a container's newest line, to resume after it. */
  lastKey(container: string): string | undefined {
    return this.last.get(container);
  }

  /** How many lines wait. */
  get size(): number {
    return this.pending.length;
  }

  /** The waiting lines in time order; none wait after. */
  take(): ProjectLine[] {
    const out = this.pending.sort(byTime);
    this.pending = [];
    return out;
  }
}
