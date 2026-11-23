// jq on a value the UI shows (Mightyconsole spec §5.4.1 and §5.6, TSK-113): the program runs on the
// server (`messaging.query`, in a worker with a deadline and limits), never in the browser. This
// module holds what the Query bar needs around it: the snippets for the common questions, written
// for the value's own shape; the Profile view's fixed program; suggestions of the value's own
// fields; and the recent queries kept per profile.
import { useCallback, useMemo } from "react";
import { useStoreIfAny } from "@/app/store";
import type { CodeCompletion, CodeCompletionItem } from "@/components/ui/code-editor";
import type { QueryOutput } from "@/gen/api";
import { JQ_BUILTINS } from "@/lib/monaco";
import type { ProfileRecord } from "@/profiles/record";
import type { TabProps } from "@/tools/types";

/** Runs a program on a value's JSON text, and remembers the profile's recent programs. */
export interface ValueQuery {
  run(text: string, jq: string, signal: AbortSignal): Promise<QueryOutput>;
  /** The profile's recent programs, newest first. */
  recent: readonly string[];
  remember(jq: string): void;
}

/** Recent programs kept per profile. */
export const RECENT_LIMIT = 20;

/** The profile's recent programs (`extras.jqRecent`), read tolerantly. */
export function recentOf(extras: Record<string, unknown>): string[] {
  const raw = extras["jqRecent"];
  return Array.isArray(raw) ? raw.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, RECENT_LIMIT) : [];
}

/** `jq` first, without its earlier copy, at most RECENT_LIMIT. */
export function withRecent(recent: readonly string[], jq: string): string[] {
  const q = jq.trim();
  return [q, ...recent.filter((r) => r !== q)].slice(0, RECENT_LIMIT);
}

/** The ValueQuery of a tab: `messaging.query` with the user's time limit, recent programs in the profile. */
export function useValueQuery({ client, profile, updateProfile }: Pick<TabProps, "client" | "profile"> & { updateProfile: TabProps["updateProfile"] | undefined }): ValueQuery {
  const timeoutMs = useStoreIfAny()?.state.settings.jqTimeoutMs;
  const recent = useMemo(() => recentOf(profile.extras), [profile.extras]);
  const run = useCallback(
    (text: string, jq: string, signal: AbortSignal) => client.messaging.query({ text, jq, ...(timeoutMs ? { timeoutMs } : {}) }, { signal, timeoutMs: 35_000 }),
    [client, timeoutMs],
  );
  const remember = useCallback(
    (jq: string) => {
      void updateProfile?.((r: ProfileRecord) => ({ ...r, extras: { ...r.extras, jqRecent: withRecent(recentOf(r.extras), jq) } }));
    },
    [updateProfile],
  );
  return useMemo(() => ({ run, recent, remember }), [run, recent, remember]);
}

// --- The value's shape ---------------------------------------------------------------------------

/** jq's path to a key: `.name`, or `."a b"` when it is not an identifier. */
export function keyPath(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `.${JSON.stringify(key)}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where the value keeps its records: the root when it is an array, else its largest array of objects (one level down). */
export interface Records {
  /** jq for the array: "." or ".orders". */
  path: string;
  /** The objects' fields, in first-seen order (from the first 200). */
  fields: string[];
  /** A field whose values are numbers, for Statistics. */
  numeric: string | null;
}

export function recordsOf(value: unknown): Records | null {
  const candidates: [string, unknown[]][] = [];
  if (Array.isArray(value)) candidates.push([".", value]);
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) if (Array.isArray(v)) candidates.push([keyPath(k), v]);
  const best = candidates.filter(([, a]) => a.some(isObject)).sort((a, b) => b[1].length - a[1].length)[0];
  if (!best) return null;
  const fields: string[] = [];
  let numeric: string | null = null;
  for (const item of best[1].slice(0, 200)) {
    if (!isObject(item)) continue;
    for (const [k, v] of Object.entries(item)) {
      if (!fields.includes(k)) fields.push(k);
      if (numeric === null && typeof v === "number") numeric = k;
    }
  }
  return { path: best[0], fields, numeric };
}

/** The keys found in the value (depth-first, at most `limit`), for suggestions after a dot. */
export function keysOf(value: unknown, limit = 500): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (out.size >= limit || depth > 8) return;
    if (Array.isArray(v)) for (const x of v.slice(0, 50)) walk(x, depth + 1);
    else if (isObject(v))
      for (const [k, x] of Object.entries(v)) {
        if (out.size >= limit) return;
        out.add(k);
        walk(x, depth + 1);
      }
  };
  walk(value, 0);
  return [...out];
}

/** The value at a jq path typed before the cursor (`.orders[].customer.`), as far as it can be followed. */
export function valueAt(value: unknown, path: string): unknown {
  let cur: unknown = value;
  const steps = path.match(/\.[A-Za-z_][A-Za-z0-9_]*|\.?\[\d*\]|\."(?:[^"\\]|\\.)*"/g) ?? [];
  for (const step of steps) {
    if (step.endsWith("]")) {
      if (!Array.isArray(cur)) return undefined;
      const n = step.replace(/[.[\]]/g, "");
      cur = n === "" ? cur.find(isObject) ?? cur[0] : cur[Number(n)];
    } else {
      if (!isObject(cur)) return undefined;
      const key = step.startsWith('."') ? (JSON.parse(step.slice(1)) as string) : step.slice(1);
      cur = cur[key];
    }
  }
  return cur;
}

const JQ_KEYWORDS = ["and", "or", "not", "if", "then", "elif", "else", "end", "as", "reduce", "foreach", "try", "catch", "def"];

/** Suggestions: after a dot, the fields at that path in the value (or any of its keys); else builtins and keywords. */
export function valueCompletion(value: unknown): CodeCompletion {
  const all = keysOf(value);
  return {
    triggerCharacters: ["."],
    provide({ text, word }) {
      const before = text.slice(0, word.start);
      if (before.endsWith(".")) {
        // The path that ends at this dot: ".orders[]." gives the orders' fields.
        const path = /(\.[A-Za-z0-9_[\]."]*)\.$/.exec(before)?.[1] ?? "";
        const at = path === "" ? value : valueAt(value, path);
        const keys = isObject(at) ? Object.keys(at) : Array.isArray(at) && isObject(at.find(isObject)) ? Object.keys(at.find(isObject) as object) : all;
        return keys.map((k, i): CodeCompletionItem => ({ label: k, kind: "field", sortText: `0${String(i).padStart(4, "0")}`, ...(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? {} : { insertText: JSON.stringify(k) }) }));
      }
      return [
        ...JQ_BUILTINS.map((name): CodeCompletionItem => ({ label: name, kind: "function", sortText: `1${name}` })),
        ...JQ_KEYWORDS.map((name): CodeCompletionItem => ({ label: name, kind: "keyword", sortText: `2${name}` })),
      ];
    },
  };
}

// --- Snippets ------------------------------------------------------------------------------------

/** A program for a common question, with the part to change: every occurrence of `select` is selected. */
export interface Snippet {
  id: string;
  label: string;
  description: string;
  code: string;
  /** The placeholder the cursor selects (each occurrence). */
  select: string;
}

const PATH_TEXT = 'map(if type == "number" then "[\\(.)]" else ".\\(.)" end) | join("")';

/** The snippets for this value: paths and fields from its own records when it has some. */
export function snippetsFor(value: unknown): Snippet[] {
  const r = recordsOf(value);
  const each = r ? (r.path === "." ? ".[]" : `${r.path}[]`) : ".[]";
  const arr = r ? r.path : ".";
  const field = r?.fields.find((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f)) ?? "FIELD";
  const num = r?.numeric && /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.numeric) ? r.numeric : field;
  const pipe = (path: string, rest: string) => (path === "." ? rest : `${path} | ${rest}`);
  return [
    { id: "find", label: "Find a value", description: "Every place the value appears, anywhere in the document", code: '[.. | select(. == "VALUE")]', select: "VALUE" },
    { id: "paths", label: "Paths to a value", description: "Where the value appears, as jq paths", code: `[paths(. == "VALUE")] | map(${PATH_TEXT})`, select: "VALUE" },
    { id: "key", label: "Find a key", description: "Every path that ends with this key", code: `[paths | select(.[-1] == "KEY")] | map(${PATH_TEXT})`, select: "KEY" },
    { id: "count", label: "Count", description: "How many records match a condition", code: `[${each} | select(.${field} == "VALUE")] | length`, select: "VALUE" },
    { id: "distinct", label: "Distinct values", description: "The different values of a field", code: `[${each}.${field}] | unique`, select: field },
    { id: "group", label: "Group by a field with counts", description: "How many records have each value, most first", code: pipe(arr, `group_by(.${field}) | map({${field}: .[0].${field}, count: length}) | sort_by(-.count)`), select: field },
    { id: "top", label: "Top N by a field", description: "The 10 records with the largest values", code: pipe(arr, `sort_by(.${num}) | reverse | .[:10]`), select: num },
    {
      id: "stats",
      label: "Statistics of a numeric field",
      description: "Count, min, max, sum and average",
      code: `[${each}.${num} | numbers] | {count: length, min: min, max: max, sum: add, average: (if length > 0 then add / length else null end)}`,
      select: num,
    },
  ];
}

/** The ranges (0-based offsets) of every occurrence of a snippet's placeholder, as whole words. */
export function placeholderRanges(code: string, select: string): [number, number][] {
  const out: [number, number][] = [];
  if (select === "") return out;
  const word = /^[A-Za-z_][A-Za-z0-9_]*$/.test(select);
  for (let i = code.indexOf(select); i >= 0; i = code.indexOf(select, i + select.length)) {
    const before = code[i - 1] ?? "";
    const after = code[i + select.length] ?? "";
    if (word && (/[A-Za-z0-9_]/.test(before) || /[A-Za-z0-9_]/.test(after))) continue;
    out.push([i, i + select.length]);
  }
  return out;
}

// --- Profile -------------------------------------------------------------------------------------

/** One field of an array of objects (the Profile view). */
export interface FieldProfile {
  field: string;
  present: number;
  nulls: number;
  types: { type: string; count: number }[];
  distinct: number;
  numbers: { min: number; max: number; average: number } | null;
}

export interface ProfileResult {
  objects: number;
  /** Items of the array that are not objects. */
  others: number;
  fields: FieldProfile[];
  /** Fields left out past the first 200. */
  more: number;
}

/** Fields the Profile lists at most. */
export const PROFILE_FIELDS = 200;

/** The Profile's program, run on the server like any query: fields in first-seen order. */
export const PROFILE_PROGRAM = `if type != "array" then error("Profile reads an array of objects") else . end
| [.[] | objects] as $objs
| ([$objs[] | keys_unsorted[]] | to_entries | group_by(.value) | sort_by(.[0].key) | map(.[0].value)) as $fields
| {objects: ($objs | length), others: (length - ($objs | length)), more: ([$fields[${PROFILE_FIELDS}:][]] | length), fields: [$fields[:${PROFILE_FIELDS}][] as $f
  | [$objs[] | select(has($f)) | .[$f]] as $vals
  | {field: $f, present: ($vals | length), nulls: ([$vals[] | select(. == null)] | length),
     types: ($vals | map(type) | group_by(.) | map({type: .[0], count: length})),
     distinct: ($vals | unique | length),
     numbers: ([$vals[] | numbers] | if length > 0 then {min: min, max: max, average: (add / length)} else null end)}]}`;

/** The jq path of the records a Profile reads, applied before the program. */
export function profileProgram(path: string): string {
  return path === "." ? PROFILE_PROGRAM : `${path} | ${PROFILE_PROGRAM}`;
}

/** Whether a Profile can read this value: an array with objects, at the root or one level down. */
export function canProfile(value: unknown): boolean {
  return recordsOf(value) !== null;
}
