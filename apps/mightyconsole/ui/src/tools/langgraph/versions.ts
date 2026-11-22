// An assistant's versions compared (DOC-21 §11.2.1, the mockup's langgraph-assistant-versions,
// TSK-96): what changed in a line ("model gpt-4.1 → claude-sonnet-5-5, temperature 0.2"), the
// diff of config, context and metadata, and the same diff side by side.
import { type DiffLine, diffLines, stableJson } from "@/lib/diff";
import type * as api from "@/gen/api";

type Values = Record<string, unknown>;
const isObject = (v: unknown): v is Values => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The settings of a version by name: `configurable`'s keys and the config's other keys bare,
 * the context's bare, the metadata's as `metadata.<key>` (the server writes its own there).
 */
export function settingsOf(a: api.Assistant): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const config = isObject(a.config) ? a.config : {};
  for (const [k, v] of Object.entries(config)) {
    if (k === "configurable" && isObject(v)) for (const [ck, cv] of Object.entries(v)) out.set(ck, cv);
    else out.set(k, v);
  }
  if (isObject(a.context)) for (const [k, v] of Object.entries(a.context)) out.set(k, v);
  if (isObject(a.metadata)) for (const [k, v] of Object.entries(a.metadata)) out.set(`metadata.${k}`, v);
  return out;
}

/** A setting's value in a line: a string as it is, others as JSON, cut at 32 characters. */
function short(v: unknown): string {
  const text = typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : JSON.stringify(v);
  return text.length > 32 ? `${text.slice(0, 31)}…` : text;
}

/** What a version changed from the one before, in a line; "created" for the first. */
export function versionChange(previous: api.Assistant | undefined, current: api.Assistant): string {
  if (!previous) return "created";
  if (current.cuts.length > 0 || previous.cuts.length > 0) return "settings too big to compare here";
  const before = settingsOf(previous);
  const after = settingsOf(current);
  const parts: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(key);
    const b = after.get(key);
    if (stableJson(a) === stableJson(b)) continue;
    if (!before.has(key)) parts.push(`${key} ${short(b)}`);
    else if (!after.has(key)) parts.push(`${key} removed`);
    else parts.push(`${key} ${short(a)} → ${short(b)}`);
  }
  if (current.name !== previous.name) parts.unshift(`renamed to ${current.name}`);
  if (parts.length === 0) return "no change to the settings";
  return parts.length > 4 ? `${parts.slice(0, 4).join(", ")} and ${parts.length - 4} more` : parts.join(", ");
}

/** The diff of config, context and metadata between two versions. */
export function versionDiff(previous: api.Assistant, current: api.Assistant): DiffLine[] {
  const pick = (a: api.Assistant) => ({ config: a.config, context: a.context, metadata: a.metadata });
  return diffLines(stableJson(pick(previous)), stableJson(pick(current)));
}

/** A diff as rows of two columns: removed lines on the left beside the added lines they became. */
export type SideRow = { left: DiffLine | null; right: DiffLine | null };

export function sideBySide(lines: readonly DiffLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "same") {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    // A run of removed lines, then the added ones that follow, side by side.
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "removed") removed.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === "added") added.push(lines[i++]!);
    for (let n = 0; n < Math.max(removed.length, added.length); n++) rows.push({ left: removed[n] ?? null, right: added[n] ?? null });
  }
  return rows;
}
