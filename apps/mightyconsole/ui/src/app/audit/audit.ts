// The audit viewer, the logic (DOC-25 §3.5, TSK-135 §6): what the screen's filters mean to
// `audit.list`, how a row reads, the verification verdict in words, and an export of the filtered
// view as CSV (the screen pages through `audit.list`; there is no export stream, OQ 30 (h)).
import type { AuditFilter, AuditRow, AuditStatusOutput, AuditVerifyOutput } from "@/gen/api";
import { procedures } from "@/gen/api";

export type Period = "hour" | "day" | "week" | "month" | "all";

export const PERIODS: ReadonlyArray<{ id: Period; label: string; ms: number | null }> = [
  { id: "hour", label: "Last hour", ms: 3_600_000 },
  { id: "day", label: "Last 24 hours", ms: 86_400_000 },
  { id: "week", label: "Last 7 days", ms: 7 * 86_400_000 },
  { id: "month", label: "Last 30 days", ms: 30 * 86_400_000 },
  { id: "all", label: "All time", ms: null },
];

/** What the person typed and picked. */
export interface Filters {
  who: string;
  /** A tool name (`nats`), or "any". */
  tool: string;
  risk: "any" | "Read" | "Write" | "Destructive";
  outcome: "any" | "allowed" | "refused" | "failed";
  period: Period;
  sensitiveOnly: boolean;
}

export const NO_FILTERS: Filters = { who: "", tool: "any", risk: "any", outcome: "any", period: "week", sensitiveOnly: false };

/** The tools the log can name: the first word of every procedure (the generated table is grouped by it), and the sign-in events. */
export function auditTools(names: readonly string[] = Object.keys(procedures)): string[] {
  const tools = new Set<string>(["auth"]);
  for (const name of names) {
    const dot = name.indexOf(".");
    tools.add(dot > 0 ? name.slice(0, dot) : name);
  }
  return [...tools].sort();
}

/** The filter `audit.list` takes; `now` is when the period is counted from. */
export function filterOf(f: Filters, now: number): AuditFilter {
  const span = PERIODS.find((p) => p.id === f.period)?.ms ?? null;
  return {
    fromMs: span === null ? null : now - span,
    toMs: null,
    principal: f.who.trim() || null,
    action: f.tool === "any" ? null : `${f.tool}.`,
    risk: f.risk === "any" ? null : f.risk,
    outcome: f.outcome === "any" ? null : f.outcome,
    sensitiveOnly: f.sensitiveOnly || null,
    includeStarted: null,
  };
}

/** Whether any filter narrows the view beyond the default period. */
export function isFiltered(f: Filters): boolean {
  return f.who.trim() !== "" || f.tool !== "any" || f.risk !== "any" || f.outcome !== "any" || f.sensitiveOnly || f.period !== NO_FILTERS.period;
}

export const RISK_TEXT: Record<string, string> = { Read: "Read", Write: "Write", Destructive: "Destroy" };

export function riskText(risk: string): string {
  return RISK_TEXT[risk] ?? risk;
}

export const OUTCOME_TEXT: Record<string, string> = { allowed: "Allowed", refused: "Refused", failed: "Failed" };

export function outcomeText(outcome: string): string {
  return OUTCOME_TEXT[outcome] ?? outcome;
}

/** "26 Nov 2026, 08:14:03" in the browser's zone: an audit time is exact. */
export function timeText(ms: number): string {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const clock = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${day}, ${clock}`;
}

/** A call's length: "12 ms", "1.4 s". */
export function durationText(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function bytesText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

/** The first 12 characters of a digest, for a table; the full text is in the detail. */
export const shortHash = (hash: string): string => (hash.length > 12 ? `${hash.slice(0, 12)}…` : hash);

/** What the chain check found, in one line and a tone. */
export function verdict(v: AuditVerifyOutput): { tone: "success" | "danger" | "warning"; title: string; detail: string } {
  if (v.broken) {
    return {
      tone: "danger",
      title: `The chain breaks at record ${v.broken.seq ?? "?"}`,
      detail: `${v.broken.kind} in ${v.broken.file}, line ${v.broken.line}: ${v.broken.message}`,
    };
  }
  const checkpoint =
    v.checkpoint === "intact"
      ? "The checkpoint matches."
      : v.checkpoint === "not checked"
        ? "The checkpoint was not checked: its key is not loaded."
        : v.checkpoint === "absent"
          ? "No checkpoint has been written yet."
          : "This server keeps no checkpoint key.";
  const counts = `${v.records.toLocaleString("en-GB")} records in ${v.segments} ${v.segments === 1 ? "file" : "files"}`;
  if (v.unfinished.length > 0) {
    return { tone: "warning", title: "The chain is intact, but some calls have no completion", detail: `${counts}. ${v.unfinished.length} call${v.unfinished.length === 1 ? "" : "s"} started and never finished (the server stopped, or a write was lost). ${checkpoint}` };
  }
  return { tone: v.checkpoint === "not checked" ? "warning" : "success", title: "The chain is intact", detail: `${counts}. ${checkpoint}` };
}

/** The status line above the table. */
export function statusText(s: AuditStatusOutput): string {
  const parts = [`${s.records.toLocaleString("en-GB")} records`, `${s.segments} ${s.segments === 1 ? "file" : "files"}`, `${bytesText(s.bytes)} of ${bytesText(s.maxBytes)}`];
  if (s.oldestTimeMs !== null) parts.push(`since ${new Date(s.oldestTimeMs).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
  return parts.join(" · ");
}

const COLUMNS: ReadonlyArray<[string, (r: AuditRow) => string | number]> = [
  ["seq", (r) => r.seq],
  ["time", (r) => new Date(r.timeMs).toISOString()],
  ["user", (r) => r.user],
  ["session", (r) => r.session],
  ["action", (r) => r.action],
  ["permission", (r) => r.perm],
  ["target", (r) => r.target ?? ""],
  ["risk", (r) => r.risk],
  ["sensitive", (r) => (r.sensitive ? "yes" : "")],
  ["outcome", (r) => r.outcome],
  ["error", (r) => r.errorCode ?? ""],
  ["duration_ms", (r) => r.durationMs ?? ""],
  ["correlation", (r) => r.correlationId],
];

/** One CSV field: quoted when it needs it, and a leading `=`, `+`, `-` or `@` defused for spreadsheets. */
export function csvField(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === "string") text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The rows as CSV text, oldest last as the screen shows them. */
export function toCsv(rows: readonly AuditRow[]): string {
  const lines = [COLUMNS.map(([name]) => name).join(",")];
  for (const row of rows) lines.push(COLUMNS.map(([, get]) => csvField(get(row))).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** The most rows one export reads before it stops and says so. */
export const EXPORT_LIMIT = 50_000;
