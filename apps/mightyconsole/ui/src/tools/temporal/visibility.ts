// The `temporal-visibility` language of the Workflows query (TSK-93, DOC-21 Open question 45 (m)):
// Monarch highlighting for Temporal's SQL-like list filter, a completion source fed by the
// namespace's search attributes (temporal.namespaces.searchAttributes), the operators that fit
// an attribute's type, AND/OR, values seen in the loaded rows and recent and saved queries, and
// the server's error turned into a marker on the part it names.
import type { CodeCompletion, CodeCompletionItem, CodeMarker } from "@/components/ui/code-editor";
import type { SearchAttribute, SearchAttributeType, WorkflowRow } from "@/gen/api";
import { registerCodeLanguage, type Monaco } from "@/lib/monaco";
import { STATUS_CHIPS } from "./query";

export const VISIBILITY_LANGUAGE = "temporal-visibility";

const KEYWORDS = ["AND", "OR", "NOT", "IN", "BETWEEN", "IS", "NULL", "ORDER", "BY", "ASC", "DESC", "STARTS_WITH", "LIKE"];

/** The Monarch grammar (`monaco.languages.IMonarchLanguage`). */
export const VISIBILITY_GRAMMAR: Parameters<Monaco["languages"]["setMonarchTokensProvider"]>[1] = {
  ignoreCase: true,
  defaultToken: "",
  keywords: KEYWORDS,
  constants: ["true", "false"],
  tokenizer: {
    root: [
      [/"([^"\\]|\\.)*"/, "string"],
      [/'([^'\\]|\\.)*'/, "string"],
      [/"([^"\\]|\\.)*$/, "string"],
      [/'([^'\\]|\\.)*$/, "string"],
      [/`[^`]*`?/, "identifier"],
      [/-?\d+(?:\.\d+)?/, "number"],
      [/[A-Za-z_][\w]*/, { cases: { "@keywords": "keyword", "@constants": "constant", "@default": "identifier" } }],
      [/!=|>=|<=|=|>|</, "operator"],
      [/[(),]/, "delimiter"],
    ],
  },
};

const VISIBILITY_CONFIGURATION: Parameters<Monaco["languages"]["setLanguageConfiguration"]>[1] = {
  brackets: [["(", ")"]],
  autoClosingPairs: [
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  wordPattern: /[A-Za-z_][\w]*|-?\d+(?:\.\d+)?/,
};

/** Registers the language once; CodeEditor sets it up the first time a query editor mounts. */
export function registerVisibilityLanguage(): void {
  registerCodeLanguage(VISIBILITY_LANGUAGE, (monaco: Monaco) => {
    monaco.languages.setMonarchTokensProvider(VISIBILITY_LANGUAGE, VISIBILITY_GRAMMAR);
    monaco.languages.setLanguageConfiguration(VISIBILITY_LANGUAGE, VISIBILITY_CONFIGURATION);
  });
}

/** The operators that make sense after an attribute of each type. */
const OPERATORS: Record<SearchAttributeType, readonly string[]> = {
  Keyword: ["=", "!=", "IN", "STARTS_WITH", "IS NULL", "IS NOT NULL"],
  KeywordList: ["=", "!=", "IN", "IS NULL", "IS NOT NULL"],
  Text: ["=", "!="],
  Int: ["=", "!=", ">", ">=", "<", "<=", "BETWEEN"],
  Double: ["=", "!=", ">", ">=", "<", "<=", "BETWEEN"],
  Datetime: ["=", "!=", ">", ">=", "<", "<=", "BETWEEN"],
  Bool: ["=", "!="],
  Unspecified: ["=", "!="],
};

const TYPE_WORDS: Record<SearchAttributeType, string> = {
  Keyword: "Keyword",
  KeywordList: "Keyword list",
  Text: "Text",
  Int: "Int",
  Double: "Double",
  Datetime: "Datetime",
  Bool: "Bool",
  Unspecified: "Unknown type",
};

/** What the completion knows: the namespace's attributes, values seen, recent and saved queries. */
export interface VisibilitySources {
  attributes: readonly SearchAttribute[];
  values: ReadonlyMap<string, ReadonlySet<string>>;
  recent: readonly string[];
  saved: readonly { name: string; query: string }[];
  /** "Now", for the Datetime examples (tests pin it). */
  now?: () => Date;
}

/** The values of the loaded rows by the attribute that holds them, added to `into` (at most 50 each). */
export function collectValues(rows: readonly WorkflowRow[], into: Map<string, Set<string>> = new Map()): Map<string, Set<string>> {
  const add = (name: string, value: string | undefined | null) => {
    if (!value) return;
    const set = into.get(name) ?? new Set<string>();
    if (set.size < 50) set.add(value);
    into.set(name, set);
  };
  for (const row of rows) {
    add("WorkflowType", row.workflowType);
    add("TaskQueue", row.taskQueue);
    add("WorkflowId", row.workflowId);
    add("RunId", row.runId);
    if (row.status !== "Unspecified") add("ExecutionStatus", row.status);
  }
  return into;
}

type Token = { kind: "word" | "string" | "number" | "operator" | "open" | "close" | "comma"; text: string; start: number; closed?: boolean };

/** Splits a query into tokens; an unterminated string is the last token with `closed: false`. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      const closed = j < text.length;
      tokens.push({ kind: "string", text: text.slice(i, closed ? j + 1 : text.length), start: i, closed });
      i = closed ? j + 1 : text.length;
    } else if (c === "`") {
      const j = text.indexOf("`", i + 1);
      const end = j === -1 ? text.length : j + 1;
      tokens.push({ kind: "word", text: text.slice(i, end), start: i });
      i = end;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w]*/.exec(text.slice(i))!;
      tokens.push({ kind: "word", text: m[0], start: i });
      i += m[0].length;
    } else if (/[-\d]/.test(c) && /^-?\d/.test(text.slice(i))) {
      const m = /^-?\d+(?:\.\d+)?/.exec(text.slice(i))!;
      tokens.push({ kind: "number", text: m[0], start: i });
      i += m[0].length;
    } else if (/[!<>=]/.test(c)) {
      const m = /^(?:!=|>=|<=|=|>|<|!)/.exec(text.slice(i))!;
      tokens.push({ kind: "operator", text: m[0], start: i });
      i += m[0].length;
    } else {
      tokens.push({ kind: c === "(" ? "open" : c === ")" ? "close" : "comma", text: c, start: i });
      i += 1;
    }
  }
  return tokens;
}

const upper = (t: Token | undefined) => (t?.kind === "word" ? t.text.toUpperCase() : "");
const unquote = (name: string) => name.replace(/^`|`$/g, "");
const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Where the cursor is in the grammar, from the tokens before it. */
type Place =
  | { kind: "attribute"; start: boolean }
  | { kind: "operator"; attribute: string }
  | { kind: "value"; attribute: string }
  | { kind: "in" }
  | { kind: "is" }
  | { kind: "order" }
  | { kind: "after-value" };

function placeOf(tokens: readonly Token[]): Place {
  if (tokens.length === 0) return { kind: "attribute", start: true };
  const last = tokens[tokens.length - 1]!;
  const w = upper(last);
  const ordering = tokens.some((t, i) => upper(t) === "BY" && upper(tokens[i - 1]) === "ORDER");
  if ((last.kind === "open" || last.kind === "comma") && insideIn(tokens)) return { kind: "value", attribute: attributeBefore(tokens, tokens.length - 1) };
  if (last.kind === "open" || (last.kind === "comma" && !ordering)) return { kind: "attribute", start: false };
  if (last.kind === "comma" || w === "BY") return { kind: "attribute", start: false };
  if (w === "AND" && upper(tokens[tokens.length - 3]) === "BETWEEN") return { kind: "value", attribute: attributeBefore(tokens, tokens.length - 4) };
  if (w === "NOT" && upper(tokens[tokens.length - 2]) === "IS") return { kind: "is" };
  if (w === "AND" || w === "OR" || w === "NOT") return { kind: "attribute", start: false };
  if (w === "IS") return { kind: "is" };
  if (w === "IN") return { kind: "in" };
  if (last.kind === "operator" || w === "STARTS_WITH" || w === "LIKE" || w === "BETWEEN") return { kind: "value", attribute: attributeBefore(tokens, tokens.length - 1) };
  if (last.kind === "word" && !KEYWORDS.includes(w)) return ordering ? { kind: "order" } : { kind: "operator", attribute: unquote(last.text) };
  return { kind: "after-value" };
}

/** Whether the cursor is in the list of an `IN (…)`. */
function insideIn(tokens: readonly Token[]): boolean {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i]!;
    if (t.kind === "close") return false;
    if (t.kind === "open") return upper(tokens[i - 1]) === "IN";
  }
  return false;
}

/** The attribute a value belongs to: the last word before `index` that is not a keyword. */
function attributeBefore(tokens: readonly Token[], index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const t = tokens[i]!;
    if (t.kind === "word" && !KEYWORDS.includes(upper(t))) return unquote(t.text);
  }
  return "";
}

/** Datetime examples: the start of today, and 24 hours ago, as RFC 3339 UTC. */
function datetimeExamples(now: Date): { label: string; detail: string }[] {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return [
    { label: quote(iso(midnight)), detail: "today, 00:00 UTC" },
    { label: quote(iso(new Date(now.getTime() - 24 * 3600 * 1000))), detail: "24 hours ago" },
  ];
}

/** The completion source of the Workflows query editor. `sources()` is read each time it is asked. */
export function visibilityCompletion(sources: () => VisibilitySources): CodeCompletion {
  return {
    triggerCharacters: [" ", "(", '"', "'", ","],
    provide({ text, offset, word }) {
      const s = sources();
      const typeOf = (name: string): SearchAttributeType => s.attributes.find((a) => a.name.toLowerCase() === name.toLowerCase())?.valueType ?? "Unspecified";
      const before = text.slice(0, offset);
      const tokens = tokenize(before);
      const open = tokens.at(-1)?.kind === "string" && tokens.at(-1)!.closed === false ? tokens.at(-1)! : null;

      // Inside a string: the values of its attribute, replacing what was typed after the quote.
      if (open) {
        const attribute = attributeBefore(tokens, tokens.length - 2);
        const closing = text[offset] === open.text[0] ? "" : open.text[0];
        return valuesOf(attribute, typeOf(attribute), s).map((v) => {
          const inner = v.label.startsWith('"') ? JSON.parse(v.label) as string : v.label;
          return { ...v, label: inner, insertText: `${inner}${closing}`, replace: { start: open.start + 1, end: offset } };
        });
      }

      const prior = word.text === "" ? tokens : tokens.slice(0, -1);
      const place = placeOf(prior);
      const items: CodeCompletionItem[] = [];
      if (place.kind === "attribute") {
        for (const a of s.attributes) {
          items.push({
            label: a.name,
            kind: "field",
            detail: `${TYPE_WORDS[a.valueType]}${a.custom ? " · custom" : ""}`,
            insertText: /^[A-Za-z_][\w]*$/.test(a.name) ? a.name : `\`${a.name}\``,
            sortText: `${a.custom ? "1" : "2"}${a.name}`,
          });
        }
        items.push({ label: "NOT", kind: "keyword", sortText: "3" }, { label: "(", kind: "operator", sortText: "3" });
        if (place.start) {
          // At the start of an empty or one-word query: whole queries, replacing the text.
          s.saved.forEach((q, i) => items.push({ label: q.query, kind: "history", detail: `saved: ${q.name}`, sortText: `0a${i}`, filterText: `${q.name} ${q.query}`, replace: { start: 0, end: text.length } }));
          s.recent.forEach((q, i) => items.push({ label: q, kind: "history", detail: "recent", sortText: `0b${String(i).padStart(2, "0")}`, replace: { start: 0, end: text.length } }));
        }
      } else if (place.kind === "operator") {
        OPERATORS[typeOf(place.attribute)].forEach((op, i) => items.push({ label: op, kind: "operator", sortText: String(i).padStart(2, "0") }));
      } else if (place.kind === "value") {
        items.push(...valuesOf(place.attribute, typeOf(place.attribute), s));
      } else if (place.kind === "in") {
        items.push({ label: "(…)", kind: "snippet", insertText: '("$1")', snippet: true, detail: "a list of values" });
      } else if (place.kind === "is") {
        for (const k of ["NULL", "NOT NULL"]) items.push({ label: k, kind: "keyword" });
      } else if (place.kind === "order") {
        for (const k of ["ASC", "DESC"]) items.push({ label: k, kind: "keyword" });
      } else {
        for (const k of ["AND", "OR", "ORDER BY"]) items.push({ label: k, kind: "keyword" });
      }
      return items;
    },
  };
}

function valuesOf(attribute: string, type: SearchAttributeType, s: VisibilitySources): CodeCompletionItem[] {
  if (type === "Bool") return ["true", "false"].map((label) => ({ label, kind: "constant" }));
  if (type === "Datetime") return datetimeExamples((s.now ?? (() => new Date()))()).map((e) => ({ ...e, kind: "value" }));
  const seen = [...(s.values.get(attribute) ?? [])];
  const known = attribute === "ExecutionStatus" ? [...new Set([...STATUS_CHIPS, ...seen])] : seen;
  if (type === "Int" || type === "Double") return known.map((label) => ({ label, kind: "value", detail: "seen" }));
  return known.map((v) => ({ label: quote(v), kind: "value", detail: attribute === "ExecutionStatus" && !seen.includes(v) ? "status" : "seen in the list", filterText: v }));
}

/**
 * The server's message about an invalid query as a marker: on the token it quotes (`near 'x'`,
 * `'x'`, an attribute it names) when the query has it, else under the whole query.
 */
export function queryErrorMarker(message: string, query: string): CodeMarker | null {
  if (query.trim() === "") return null;
  const candidates = [...message.matchAll(/near ['"`]([^'"`]+)['"`]|['"`]([^'"`]+)['"`]|(?:search attribute|attribute|column)[:\s]+([A-Za-z_][\w]*)/gi)].map((m) => m[1] ?? m[2] ?? m[3]!).filter(Boolean);
  for (const c of candidates) {
    const at = query.indexOf(c);
    if (at !== -1) return { line: 1, column: at + 1, endLine: 1, endColumn: at + c.length + 1, message, severity: "error" };
  }
  const lead = query.length - query.trimStart().length;
  return { line: 1, column: lead + 1, endLine: 1, endColumn: query.trimEnd().length + 1, message, severity: "error" };
}

// Recent queries, per profile and namespace, for this session only (DOC-21 Open question 45 (m)):
// queries can carry workflow and customer ids, so they are not written to the browser.
const recentByScope = new Map<string, string[]>();

export function recentQueries(profileId: string, namespace: string): readonly string[] {
  return recentByScope.get(`${profileId}\u0000${namespace}`) ?? [];
}

/** Remembers a query that ran (the newest first, ten at most, no duplicates). */
export function rememberQuery(profileId: string, namespace: string, query: string): void {
  const q = query.trim();
  if (q === "") return;
  const key = `${profileId}\u0000${namespace}`;
  const list = (recentByScope.get(key) ?? []).filter((x) => x !== q);
  recentByScope.set(key, [q, ...list].slice(0, 10));
}
