// How the Workflows table writes times and durations.
import type { WorkflowStatus } from "@/gen/api";

/** A status's tone: a Badge variant and a GraphView dot. */
export const STATUS_TONE = { Running: "info", Completed: "success", Failed: "danger", Canceled: "neutral", Terminated: "danger", ContinuedAsNew: "info", TimedOut: "warning", Paused: "neutral", Unspecified: "neutral" } as const satisfies Record<WorkflowStatus, "info" | "success" | "danger" | "neutral" | "warning">;

/** "1d 4h", "3m 20s", "850 ms": the two largest units, so a row stays short. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const parts: [string, number][] = [
    ["d", Math.floor(ms / 86_400_000)],
    ["h", Math.floor(ms / 3_600_000) % 24],
    ["m", Math.floor(ms / 60_000) % 60],
    ["s", Math.floor(ms / 1000) % 60],
  ];
  const shown = parts.filter(([, n]) => n > 0).slice(0, 2);
  return shown.map(([unit, n]) => `${n}${unit}`).join(" ");
}

export { formatShortTime, formatTime } from "@/lib/time";
