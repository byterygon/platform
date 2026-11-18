import { useEffect, useId, useRef, type KeyboardEvent, type Ref } from "react";
import { Button } from "@/components/button/button";
import { Icon } from "@/components/icon/icon";
import { IconButton } from "@/components/icon-button/icon-button";
import { Input } from "@/components/input/input";
import { Select, SelectItem } from "@/components/select/select";
import { cn } from "@/lib/cn";
import { Add, Delete } from "@/lib/icons";

// Edit a list of key and value pairs (Mightyconsole spec section 12, TSK-80): message headers in
// the Composer, labels, environment variables. Each row is a key Input, a value Input, an
// optional encoding Select (text or base64) and a remove button; Enter in a value adds a row
// below, Mod+Backspace removes the row, focus follows. Duplicate keys (when not allowed) and
// values that are not base64 are marked invalid with a message. Read-only display is
// DescriptionList. Built on Input, Select, IconButton and Button; Base UI has no list part.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const keyValueEditorVariants = {} as const;

const classes = {
  root: "flex w-full min-w-0 flex-col gap-stack-xs",
  row: "flex min-w-0 items-start gap-inline-sm",
  cell: "flex min-w-0 flex-1 flex-col gap-stack-xs",
  encoding: "w-auto shrink-0",
  message: "font-sans text-caption-1 text-danger-fg",
  header: "flex min-w-0 gap-inline-sm font-sans text-caption-1-strong text-fg-muted",
  headerCell: "min-w-0 flex-1",
  empty: "font-sans text-body-1 text-fg-muted",
  footer: "flex",
} as const;

export type KeyValueEncoding = "text" | "base64";

/** One row. */
export interface KeyValueEntry {
  key: string;
  value: string;
  /** How the value is written; text when absent. */
  encoding?: KeyValueEncoding;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `text` is base64 (standard alphabet; padding optional; whitespace ignored). */
export function isBase64(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  return t.length % 4 !== 1 && BASE64.test(t);
}

/** The problems of each row: a duplicate key, an empty key with a value, a value that is not base64. */
export function keyValueProblems(entries: readonly KeyValueEntry[], allowDuplicates: boolean): { key: string | undefined; value: string | undefined }[] {
  const seen = new Map<string, number>();
  for (const e of entries) if (e.key !== "") seen.set(e.key, (seen.get(e.key) ?? 0) + 1);
  return entries.map((e) => ({
    key: e.key === "" && e.value !== "" ? "A key is needed" : !allowDuplicates && e.key !== "" && (seen.get(e.key) ?? 0) > 1 ? "Duplicate key" : undefined,
    value: e.encoding === "base64" && !isBase64(e.value) ? "Not valid base64" : undefined,
  }));
}

export interface KeyValueEditorProps {
  /** The rows. */
  value?: readonly KeyValueEntry[] | undefined;
  /** Called with the new rows after every edit. */
  onChange?: ((value: KeyValueEntry[]) => void) | undefined;
  /** Keys offered while typing a key (a datalist). */
  keySuggestions?: readonly string[] | undefined;
  /** Whether the same key may appear twice (headers may); a repeated key is invalid otherwise. */
  allowDuplicates?: boolean | undefined;
  /** Encodings a value may take; with more than one, each row has a Select. */
  valueEncodings?: readonly KeyValueEncoding[] | undefined;
  /** Column names: "Key" and "Value" by default ("Name" and "Value" for headers). */
  keyLabel?: string | undefined;
  valueLabel?: string | undefined;
  /** The add button's text. */
  addLabel?: string | undefined;
  /** Rows can be read and copied but not changed, added or removed. */
  readOnly?: boolean | undefined;
  /** Fluent's size for the inputs and buttons. */
  size?: "small" | "medium" | "large" | undefined;
  /** Accessible name of the group. */
  "aria-label"?: string | undefined;
  /** Extra classes, merged after the component's own so they win. */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
}

const ENCODING_LABELS: Record<KeyValueEncoding, string> = { text: "Text", base64: "Base64" };

const NONE: readonly KeyValueEntry[] = [];
const ignore = () => {};

/** A list of key and value inputs with add, remove and keyboard row editing (role="group"). */
export function KeyValueEditor({
  value = NONE,
  onChange = ignore,
  keySuggestions,
  allowDuplicates = true,
  valueEncodings,
  keyLabel = "Key",
  valueLabel = "Value",
  addLabel = "Add",
  readOnly = false,
  size = "medium",
  "aria-label": label = "Key and value pairs",
  className,
  ref,
}: KeyValueEditorProps) {
  const id = useId();
  const listId = `${id}-keys`;
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = useRef<string | null>(null);
  const problems = keyValueProblems(value, allowDuplicates);
  const encodings = valueEncodings && valueEncodings.length > 1 ? valueEncodings : null;

  useEffect(() => {
    if (!pendingFocus.current) return;
    inputs.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  const update = (index: number, patch: Partial<KeyValueEntry>) => onChange(value.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  const add = (at: number) => {
    const next = [...value];
    next.splice(at, 0, { key: "", value: "", ...(encodings ? { encoding: encodings[0]! } : {}) });
    pendingFocus.current = `${at}-key`;
    onChange(next);
  };
  const remove = (index: number) => {
    pendingFocus.current = value.length > 1 ? `${Math.max(0, index - 1)}-key` : "add";
    onChange(value.filter((_, i) => i !== index));
  };
  const onRowKeyDown = (index: number, part: "key" | "value") => (event: KeyboardEvent<HTMLInputElement>) => {
    if (readOnly) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (part === "key") inputs.current.get(`${index}-value`)?.focus();
      else add(index + 1);
    } else if (event.key === "Backspace" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      remove(index);
    }
  };
  const bind = (name: string) => (node: HTMLInputElement | null) => {
    if (node) inputs.current.set(name, node);
    else inputs.current.delete(name);
  };

  return (
    <div data-slot="key-value-editor" role="group" aria-label={label} ref={ref} className={cn(classes.root, className)}>
      {value.length > 0 ? (
        <div className={classes.header} aria-hidden>
          <span className={classes.headerCell}>{keyLabel}</span>
          <span className={classes.headerCell}>{valueLabel}</span>
        </div>
      ) : (
        <p className={classes.empty}>None</p>
      )}
      {keySuggestions?.length ? (
        <datalist id={listId}>
          {keySuggestions.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      ) : null}
      {value.map((entry, index) => {
        const n = index + 1;
        const problem = problems[index]!;
        const keyMessage = `${id}-${index}-key-message`;
        const valueMessage = `${id}-${index}-value-message`;
        return (
          <div key={index} data-slot="key-value-editor-row" data-invalid={problem.key || problem.value ? "" : undefined} className={classes.row}>
            <div className={classes.cell}>
              <Input
                ref={bind(`${index}-key`)}
                size={size}
                value={entry.key}
                readOnly={readOnly}
                list={keySuggestions?.length ? listId : undefined}
                aria-label={`${keyLabel} ${n}`}
                aria-invalid={problem.key ? true : undefined}
                aria-describedby={problem.key ? keyMessage : undefined}
                spellCheck={false}
                autoComplete="off"
                onValueChange={(next: string) => update(index, { key: next })}
                onKeyDown={onRowKeyDown(index, "key")}
              />
              {problem.key ? (
                <span id={keyMessage} className={classes.message}>
                  {problem.key}
                </span>
              ) : null}
            </div>
            <div className={classes.cell}>
              <Input
                ref={bind(`${index}-value`)}
                size={size}
                value={entry.value}
                readOnly={readOnly}
                aria-label={`${valueLabel} ${n}`}
                aria-invalid={problem.value ? true : undefined}
                aria-describedby={problem.value ? valueMessage : undefined}
                spellCheck={false}
                autoComplete="off"
                onValueChange={(next: string) => update(index, { value: next })}
                onKeyDown={onRowKeyDown(index, "value")}
              />
              {problem.value ? (
                <span id={valueMessage} className={classes.message}>
                  {problem.value}
                </span>
              ) : null}
            </div>
            {encodings ? (
              <Select<KeyValueEncoding>
                size={size}
                className={classes.encoding}
                aria-label={`Encoding of ${valueLabel.toLowerCase()} ${n}`}
                items={encodings.map((e) => ({ value: e, label: ENCODING_LABELS[e] }))}
                value={entry.encoding ?? "text"}
                disabled={readOnly}
                onValueChange={(next) => update(index, { encoding: (next ?? "text") as KeyValueEncoding })}
              >
                {encodings.map((e) => (
                  <SelectItem key={e} value={e}>
                    {ENCODING_LABELS[e]}
                  </SelectItem>
                ))}
              </Select>
            ) : null}
            {readOnly ? null : (
              <IconButton size={size} aria-label={`Remove row ${n}`} aria-keyshortcuts="Control+Backspace" onClick={() => remove(index)}>
                <Icon icon={Delete} />
              </IconButton>
            )}
          </div>
        );
      })}
      {readOnly ? null : (
        <div className={classes.footer}>
          <Button
            ref={(node: HTMLButtonElement | null) => {
              if (node) inputs.current.set("add", node as unknown as HTMLInputElement);
            }}
            appearance="subtle"
            size={size === "large" ? "medium" : "small"}
            onClick={() => add(value.length)}
          >
            <Icon icon={Add} />
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
