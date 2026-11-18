// The filter bar of a message view (Mightyconsole spec §5.4, §5.6): quick fields (key or subject,
// a header, text, a time range, a position range) and a jq program, checked by the server as you
// type (messaging.filter.check) and applied with Enter or Apply. The filter runs on the server.
// The jq program is a one-line Monaco editor (TSK-93): jq highlighting, the message's fields and
// jq's builtins as suggestions (Ctrl+Space), and the checker's error marked where it points.
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CodeEditor, type CodeCompletion, type CodeCompletionItem, type CodeMarker } from "@/components/ui/code-editor";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Filter, FilterCheckOutput } from "@/gen/api";
import { JQ_BUILTINS } from "@/lib/monaco";
import type { MessageSystem } from "./columns";

/** The fields as typed; empty strings are left out of the filter. */
export interface FilterDraft {
  key: string;
  subject: string;
  header: string;
  text: string;
  from: string;
  to: string;
  positionFrom: string;
  positionTo: string;
  jq: string;
}

export const EMPTY_DRAFT: FilterDraft = { key: "", subject: "", header: "", text: "", from: "", to: "", positionFrom: "", positionTo: "", jq: "" };

/** The draft as the API's Filter: a key contains, `name=value` header, ranges, jq. */
export function toFilter(d: FilterDraft): Filter {
  const f: Filter = {};
  if (d.key.trim()) f.key = { op: "contains", value: d.key.trim(), caseSensitive: false };
  if (d.subject.trim()) f.subject = d.subject.trim();
  if (d.header.trim()) {
    const [name, ...rest] = d.header.split("=");
    const value = rest.join("=");
    f.headers = [{ name: name!.trim(), ...(rest.length ? { match: { op: "equals" as const, value } } : {}) }];
  }
  if (d.text.trim()) f.text = d.text.trim();
  if (d.from.trim() || d.to.trim()) f.time = { from: d.from.trim() || null, to: d.to.trim() || null };
  if (d.positionFrom.trim() || d.positionTo.trim()) f.position = { from: d.positionFrom.trim() || null, to: d.positionTo.trim() || null };
  if (d.jq.trim()) f.jq = d.jq;
  return f;
}

/** The fields of the message object jq runs on (spec §5.4), with what they hold. */
const MESSAGE_FIELDS: readonly [string, string][] = [
  ["value", "the decoded payload (JSON, or a string)"],
  ["key", "the decoded key (Kafka)"],
  ["headers", "the headers, by name"],
  ["subject", "the subject (NATS)"],
  ["source", "the topic, stream or bucket"],
  ["partition", "the partition (Kafka)"],
  ["offset", "the offset (Kafka)"],
  ["sequence", "the sequence (JetStream)"],
  ["timestamp", "the timestamp, RFC 3339"],
];

const JQ_KEYWORDS = ["and", "or", "not", "if", "then", "elif", "else", "end", "as", "reduce", "foreach", "try", "catch", "def"];

/** jq suggestions: the message's fields after a leading dot, else builtins, keywords and fields. */
export const jqCompletion: CodeCompletion = {
  triggerCharacters: ["."],
  provide({ text, word }) {
    const before = text.slice(0, word.start);
    const fields = MESSAGE_FIELDS.map(([name, detail]): CodeCompletionItem => ({ label: name, kind: "field", detail, sortText: `0${name}` }));
    // Right after a dot at the start of a path (".", "| .", "(.") the top-level fields; deeper
    // paths (".value.") have no schema here, so nothing is offered.
    if (before.endsWith(".")) return /(^|[\s|(,=<>!+\-*/])\.$/.test(before) ? fields : [];
    return [
      ...fields.map((f) => ({ ...f, insertText: `.${f.label}`, label: `.${f.label}` })),
      ...JQ_BUILTINS.map((name): CodeCompletionItem => ({ label: name, kind: "function", sortText: `1${name}` })),
      ...JQ_KEYWORDS.map((name): CodeCompletionItem => ({ label: name, kind: "keyword", sortText: `2${name}` })),
    ];
  },
};

export interface FilterBarProps {
  system: MessageSystem;
  /** The filter in use (the stream's). */
  applied: Filter;
  onApply(filter: Filter): void;
  /** `messaging.filter.check`. */
  check(filter: Filter): Promise<FilterCheckOutput>;
  /** How long to wait after typing before checking. */
  debounceMs?: number;
}

/** Quick fields and jq; errors under the field they are about. */
export function FilterBar({ system, applied, onApply, check, debounceMs = 300 }: FilterBarProps) {
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [jqMarkers, setJqMarkers] = useState<CodeMarker[]>([]);
  const filter = useMemo(() => toFilter(draft), [draft]);
  const subjectSystem = system === "nats" || system === "jetstream";
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      check(filter).then(
        (out) => {
          if (stale) return;
          const next: Record<string, string> = {};
          const markers: CodeMarker[] = [];
          for (const e of out.errors) {
            const field = e.part.split(".")[0]!;
            next[field] = `${e.message}${e.line ? ` (line ${e.line}, column ${e.column})` : ""}`;
            if (field === "jq" && e.line && e.column) markers.push({ line: e.line, column: e.column, message: e.message, severity: "error" });
          }
          setErrors(next);
          setJqMarkers(markers);
        },
        () => {},
      );
    }, debounceMs);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [filter, check, debounceMs]);
  const set = (k: keyof FilterDraft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const ok = Object.keys(errors).length === 0;
  const changed = JSON.stringify(filter) !== JSON.stringify(applied);
  const apply = () => {
    if (ok) onApply(filter);
  };
  const jqLabel = useId();
  const field = (name: keyof FilterDraft, label: string, error: string | undefined, placeholder?: string) => (
    <Field invalid={error !== undefined} className="min-w-0 flex-1">
      <FieldLabel>{label}</FieldLabel>
      <Input
        size="small"
        value={draft[name]}
        {...(placeholder ? { placeholder } : {})}
        onValueChange={set(name)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
        }}
        spellCheck={false}
        autoComplete="off"
      />
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
  return (
    <form
      data-slot="filter-bar"
      aria-label="Filter"
      className="flex flex-wrap items-start gap-inline-sm border-b border-border-subtle px-inset-sm py-inset-xs"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      {subjectSystem ? field("subject", "Subject", errors["subject"], "orders.*.created") : field("key", "Key contains", errors["key"])}
      {field("header", "Header", errors["headers"], "name or name=value")}
      {field("text", "Text in value", errors["text"])}
      {field("from", "From", errors["time"], "2026-11-18T00:00:00Z")}
      {field("to", "To", errors["time"])}
      {field("positionFrom", system === "kafka" ? "Offset from" : "Sequence from", errors["position"])}
      {field("positionTo", system === "kafka" ? "Offset to" : "Sequence to", errors["position"])}
      <Field invalid={errors["jq"] !== undefined} className="min-w-panel-sm flex-1">
        <FieldLabel id={jqLabel}>jq</FieldLabel>
        <CodeEditor
          singleLine
          size="small"
          language="jq"
          aria-labelledby={jqLabel}
          value={draft.jq}
          onValueChange={set("jq")}
          onSubmit={apply}
          completion={jqCompletion}
          markers={jqMarkers}
          invalid={errors["jq"] !== undefined}
          placeholder=".value.total > 100"
        />
        {errors["jq"] ? <FieldError match>{errors["jq"]}</FieldError> : null}
      </Field>
      <div className="flex items-end gap-inline-sm self-end">
        <Button type="submit" size="small" appearance={changed ? "primary" : "secondary"} disabled={!ok}>
          Apply
        </Button>
        <Button
          type="button"
          size="small"
          appearance="subtle"
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            onApply({});
          }}
        >
          Reset
        </Button>
      </div>
    </form>
  );
}
