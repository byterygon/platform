// Visibility queries and the quick status chips of the Workflows screen (spec §9.3). The query
// text is the source of truth; a chip only rewrites its `ExecutionStatus` clause.
import type { WorkflowStatus } from "@/gen/api";

/** The chips, in the order of the spec: every status a query can name. */
export const STATUS_CHIPS: readonly Exclude<WorkflowStatus, "Unspecified" | "Paused">[] = ["Running", "Completed", "Failed", "Canceled", "Terminated", "ContinuedAsNew", "TimedOut"];

const CLAUSE = /\s*\bExecutionStatus\s*=\s*(?:"([A-Za-z]+)"|'([A-Za-z]+)')/i;

/** The status a query selects with a single `ExecutionStatus = "…"` clause, else null. */
export function statusOf(query: string): WorkflowStatus | null {
  const match = CLAUSE.exec(query);
  const name = match?.[1] ?? match?.[2];
  if (!name) return null;
  const known = [...STATUS_CHIPS].find((s) => s.toLowerCase() === name.toLowerCase());
  return known ?? null;
}

/** Strips `AND` / `OR` left dangling where a clause was removed. */
function tidy(query: string): string {
  return query
    .replace(/^\s*(?:AND|OR)\s+/i, "")
    .replace(/\s+(?:AND|OR)\s*$/i, "")
    .replace(/\(\s*\)/g, "")
    .trim();
}

/** The query with its status clause set to `status`, or removed when `status` is null. */
export function withStatus(query: string, status: WorkflowStatus | null): string {
  const rest = tidy(query.replace(CLAUSE, ""));
  if (status === null) return rest;
  const clause = `ExecutionStatus = "${status}"`;
  return rest === "" ? clause : `${clause} AND ${rest}`;
}
