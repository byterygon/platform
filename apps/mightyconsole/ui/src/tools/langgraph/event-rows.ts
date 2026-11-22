// A run's events as the Events table shows them (DOC-21 §11.2.1, the TSK-91 mockup's
// langgraph-run-events, TSK-96): one row per event with its time since the run started, its
// stream mode, its node and a summary; message tokens folded into one row per message (with the
// assembled text, the model and the token counts); the interrupt marked. Pure, so tested alone.
import { type RunEvent, contentText, eventName } from "./run-events";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The modes the chips count, in the mockup's order; `errors` counts `error` events. */
export const CHIP_MODES = ["values", "updates", "messages", "custom", "debug", "errors"] as const;
export type ChipMode = (typeof CHIP_MODES)[number];

export interface EventRow {
  /** The first event's number in the run (1-based). */
  index: number;
  /** Milliseconds since the run's first event, when the events were timed. */
  at?: number;
  mode: string;
  node: string;
  summary: string;
  /** The `__interrupt__` update: the run stops here. */
  interrupt: boolean;
  error: boolean;
  /** The events the row stands for (message chunks folded into one row). */
  events: RunEvent[];
  /** A message row: what its chunks assembled into. */
  message?: { text: string; model?: string; tokensIn?: number; tokensOut?: number; lastAt?: number };
}

/** `messages 1, customer_id`: the keys of a value, arrays with their length; `8 keys` past three. */
function keysSummary(value: unknown, prefix = ""): string {
  if (!isObject(value)) return value === undefined ? "" : JSON.stringify(value).slice(0, 80);
  const keys = Object.keys(value);
  if (keys.length > 3) return `${keys.length} keys`;
  return keys
    .map((k) => {
      const v = value[k];
      if (Array.isArray(v)) return `${k} ${prefix}${v.length}`;
      if (typeof v === "string" && v.length <= 24) return `${k}: ${v}`;
      return k;
    })
    .join(", ");
}

/** The interrupt's question, or its value in short. */
function interruptText(value: unknown): string {
  const list = Array.isArray(value) ? value : [value];
  const first = isObject(list[0]) && "value" in list[0] ? list[0]["value"] : list[0];
  if (typeof first === "string") return first;
  if (isObject(first)) for (const k of ["question", "message", "prompt"]) if (typeof first[k] === "string") return first[k] as string;
  return JSON.stringify(first ?? null).slice(0, 80);
}

const words = (text: string, n = 32) => (text.length > n ? `"${text.slice(0, n - 1)}…"` : `"${text}"`);

/** The rows; `fold` folds message chunks with the same message id into one row. */
export function eventRows(events: readonly RunEvent[], fold = true): EventRow[] {
  const rows: EventRow[] = [];
  const messageRow = new Map<string, EventRow>();
  const start = events.find((e) => e.at !== undefined)?.at;
  events.forEach((e, i) => {
    const { mode } = eventName(e.event);
    const at = e.at !== undefined && start !== undefined ? e.at - start : undefined;
    const base = { index: i + 1, ...(at !== undefined ? { at } : {}), mode, events: [e], interrupt: false, error: mode === "error" };
    const data = e.data;
    if (mode === "messages" && Array.isArray(data)) {
      const msg = isObject(data[0]) ? data[0] : {};
      const meta = isObject(data[1]) ? data[1] : {};
      const id = typeof msg["id"] === "string" ? msg["id"] : `#${i}`;
      const node = typeof meta["langgraph_node"] === "string" ? meta["langgraph_node"] : "";
      const text = contentText(msg["content"]);
      const usage = isObject(msg["usage_metadata"]) ? msg["usage_metadata"] : {};
      const response = isObject(msg["response_metadata"]) ? msg["response_metadata"] : {};
      const model = typeof response["model_name"] === "string" ? response["model_name"] : typeof meta["ls_model_name"] === "string" ? meta["ls_model_name"] : undefined;
      const known = fold ? messageRow.get(id) : undefined;
      if (known) {
        const chunk = typeof msg["type"] === "string" && msg["type"].endsWith("Chunk");
        known.events.push(e);
        known.message!.text = chunk ? known.message!.text + text : text;
        if (model) known.message!.model = model;
        if (typeof usage["input_tokens"] === "number") known.message!.tokensIn = usage["input_tokens"];
        if (typeof usage["output_tokens"] === "number") known.message!.tokensOut = usage["output_tokens"];
        if (at !== undefined) known.message!.lastAt = at;
        known.summary = `${known.events.length} tokens · ${words(known.message!.text)}`;
        return;
      }
      const row: EventRow = {
        ...base,
        node,
        summary: `1 token · ${words(text)}`,
        message: { text, ...(model ? { model } : {}), ...(typeof usage["input_tokens"] === "number" ? { tokensIn: usage["input_tokens"] } : {}), ...(typeof usage["output_tokens"] === "number" ? { tokensOut: usage["output_tokens"] } : {}), ...(at !== undefined ? { lastAt: at } : {}) },
      };
      if (fold) messageRow.set(id, row);
      rows.push(row);
      return;
    }
    if (mode === "updates" && isObject(data)) {
      const [node = "", value] = Object.entries(data)[0] ?? [];
      if (node === "__interrupt__") {
        rows.push({ ...base, node, interrupt: true, summary: interruptText(value) });
        return;
      }
      rows.push({ ...base, node, summary: keysSummary(value, isObject(value) && Array.isArray(value["messages"]) ? "+" : "") });
      return;
    }
    if (mode === "metadata" && isObject(data)) {
      rows.push({ ...base, node: "", summary: typeof data["run_id"] === "string" ? `run ${data["run_id"].slice(0, 8)}` : keysSummary(data) });
      return;
    }
    if (mode === "values") {
      rows.push({ ...base, node: "", summary: keysSummary(data) });
      return;
    }
    if (mode === "error") {
      rows.push({ ...base, node: "", summary: isObject(data) ? String(data["message"] ?? data["error"] ?? "") : String(data) });
      return;
    }
    if (mode === "tasks" && isObject(data)) {
      const ended = "result" in data || "error" in data || "interrupts" in data;
      rows.push({ ...base, node: String(data["name"] ?? ""), summary: ended ? (data["error"] ? `failed: ${String(data["error"])}` : "done") : "started" });
      return;
    }
    const node = isObject(data) && typeof data["langgraph_node"] === "string" ? data["langgraph_node"] : "";
    rows.push({ ...base, node, summary: data === undefined ? "" : JSON.stringify(data).slice(0, 80) });
  });
  return rows;
}

/** How many events of each chip's mode came (message chunks counted one by one). */
export function modeCounts(events: readonly RunEvent[]): Record<ChipMode, number> {
  const counts: Record<ChipMode, number> = { values: 0, updates: 0, messages: 0, custom: 0, debug: 0, errors: 0 };
  for (const e of events) {
    const { mode } = eventName(e.event);
    if (mode === "error") counts.errors += 1;
    else if (mode in counts) counts[mode as ChipMode] += 1;
  }
  return counts;
}

/** Whether a row belongs to a chip's mode. */
export const rowInMode = (row: EventRow, mode: ChipMode | "all") => mode === "all" || (mode === "errors" ? row.error : row.mode === mode);

/** "+0 ms", "+840 ms", "+1.1 s", "+2 min 4 s". */
export function sinceStart(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `+${Math.round(ms)} ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return `+${m} min ${Math.round((ms - m * 60_000) / 1000)} s`;
}
