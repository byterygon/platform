import { Input as InputPrimitive } from "@base-ui/react/input";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Annotation, Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/cn";

// CodeInput is CodeMirror 6 (spec section 7) for small code fields: one-line expressions and
// filters, short SQL, JSON values, and a read-only pretty viewer. CodeMirror is themed through the
// token CSS variables directly, so Light/Dark, density and presets apply with no JavaScript. A
// visually hidden Base UI Input (Field.Control) carries the value for forms and takes a Field's
// label, description and validity; CodeMirror's text area mirrors its ARIA attributes.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const codeInputVariants = {
  size: {
    sm: "h-control-sm px-inset-sm data-multiline:py-inline-xs",
    md: "h-control-md px-control-x data-multiline:py-inline-sm",
    lg: "h-control-lg px-inset-lg data-multiline:py-inline-md",
  },
} as const;

const base = [
  "relative flex w-full min-w-0 items-center overflow-hidden rounded-md border border-border-strong bg-surface text-editor-fg",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "outline-none data-focused:outline-solid data-focused:outline-[length:var(--by-ring-width)] data-focused:outline-offset-[var(--by-ring-offset)] data-focused:outline-ring",
  "data-multiline:h-auto data-multiline:items-start data-multiline:overflow-auto",
  "data-readonly:bg-inset",
  "data-invalid:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
];

/**
 * CodeMirror's look, from the token variables only: the editor.* roles for text, caret and
 * selection, text.code.* for the font (density-aware), syntax.* for highlighting.
 */
const tokenTheme = EditorView.theme({
  "&": {
    flex: "1 1 auto",
    minWidth: "0",
    color: "var(--by-editor-fg)",
    backgroundColor: "transparent",
    fontFamily: "var(--by-text-code-family)",
    fontSize: "var(--by-text-code-size)",
    lineHeight: "var(--by-text-code-leading)",
    letterSpacing: "var(--by-text-code-tracking)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit" },
  ".cm-content": { padding: "0", caretColor: "var(--by-editor-cursor)" },
  ".cm-line": { padding: "0" },
  ".cm-content ::selection": { backgroundColor: "var(--by-editor-selection)" },
  ".cm-placeholder": { color: "var(--by-color-fg-subtle)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--by-editor-match)", outline: "none" },
  "&.cm-focused .cm-nonmatchingBracket": { color: "var(--by-syntax-error)" },
});

const tokenHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--by-syntax-keyword)" },
  { tag: [t.string, t.regexp], color: "var(--by-syntax-string)" },
  { tag: [t.number, t.integer, t.float], color: "var(--by-syntax-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--by-syntax-comment)" },
  { tag: [t.function(t.variableName), t.standard(t.name)], color: "var(--by-syntax-function)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--by-syntax-operator)" },
  { tag: [t.typeName, t.propertyName], color: "var(--by-syntax-type)" },
  { tag: [t.name, t.variableName, t.special(t.name), t.special(t.string)], color: "var(--by-syntax-identifier)" },
  { tag: [t.bool, t.null, t.atom, t.constant(t.name)], color: "var(--by-syntax-constant)" },
  { tag: t.invalid, color: "var(--by-syntax-error)" },
]);

/** Languages CodeInput highlights. */
export type CodeInputLanguage = "text" | "sql" | "json";

const languageExtension = (language: CodeInputLanguage): Extension => (language === "sql" ? sql({ dialect: PostgreSQL }) : language === "json" ? json() : []);

/** JSON pretty-printed with two spaces; anything that is not JSON comes back unchanged. */
export function prettyCode(value: string, language: CodeInputLanguage): string {
  if (language !== "json") return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/** One line: pasted or typed line breaks become spaces. */
const singleLine = EditorState.transactionFilter.of((tr) =>
  tr.docChanged && tr.newDoc.lines > 1 ? [tr, { changes: { from: 0, to: tr.newDoc.length, insert: tr.newDoc.sliceString(0, undefined, " ") }, sequential: true }] : tr,
);

/** Marks a change made to follow the `value` prop, which must not be echoed to onValueChange. */
const fromProp = Annotation.define<boolean>();

export interface CodeInputProps extends Omit<ComponentProps<"div">, "className" | "children" | "defaultValue" | "onChange" | "onSubmit"> {
  /** Height of a one-line field, from `size.control.*`; padding of a multi-line one. */
  size?: keyof typeof codeInputVariants.size;
  /** The text, when controlled. */
  value?: string;
  /** The initial text, when uncontrolled. */
  defaultValue?: string;
  /** Called with the whole text after every change. */
  onValueChange?: (value: string) => void;
  /** Highlighting: none, PostgreSQL, or JSON. */
  language?: CodeInputLanguage;
  /** Several lines (Enter inserts a line break) instead of one. */
  multiline?: boolean;
  /** Minimum visible lines of a multi-line field. */
  rows?: number;
  /** Read-only viewer: multi-line, and JSON pretty-printed. */
  pretty?: boolean;
  /** Text can be selected and copied but not changed. */
  readOnly?: boolean;
  /** Ignores interaction and leaves the tab order. */
  disabled?: boolean;
  /** Shown while the field is empty. */
  placeholder?: string;
  /** Enter in a one-line field (the text is not changed). */
  onSubmit?: (value: string) => void;
  /** Form field name of the hidden control that carries the value. */
  name?: string;
  /** The value may not be empty (validated by the Field or form). */
  required?: boolean;
  /** Accessible name; inside a Field the FieldLabel names it instead. */
  "aria-label"?: string;
  /** Marks the value invalid outside a Field. */
  "aria-invalid"?: boolean | "true" | "false";
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

const MIRRORED = ["aria-labelledby", "aria-describedby", "aria-invalid", "data-invalid", "data-disabled", "required"] as const;

/**
 * A small code field on CodeMirror: one line by default (Enter submits), or several with
 * `multiline`; SQL or JSON highlighting in the syntax.* colours; a read-only pretty viewer. Works
 * inside a Field like Input. The ref reaches the root element.
 */
export function CodeInput({
  size = "md",
  value,
  defaultValue = "",
  onValueChange,
  language = "text",
  multiline: multilineProp = false,
  rows = 3,
  pretty = false,
  readOnly: readOnlyProp = false,
  disabled = false,
  placeholder,
  onSubmit,
  name,
  required,
  id,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  className,
  ref,
  ...props
}: CodeInputProps) {
  const multiline = multilineProp || pretty;
  const readOnly = readOnlyProp || pretty;
  const shown = (text: string) => (pretty ? prettyCode(text, language) : text);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [text, setText] = useState(() => shown(value ?? defaultValue));
  const [focused, setFocused] = useState(false);
  const latest = useRef({ onValueChange, onSubmit, value });
  latest.current = { onValueChange, onSubmit, value };
  const compartments = useRef({ language: new Compartment(), lines: new Compartment(), edit: new Compartment(), placeholder: new Compartment(), attributes: new Compartment(), rows: new Compartment() });

  const linesExtension = (isMultiline: boolean): Extension =>
    isMultiline
      ? EditorView.lineWrapping
      : [singleLine, Prec.highest(keymap.of([{ key: "Enter", run: (view) => (latest.current.onSubmit?.(view.state.doc.toString()), true) }]))];
  const editExtension = (isReadOnly: boolean, isDisabled: boolean): Extension => [EditorState.readOnly.of(isReadOnly || isDisabled), EditorView.editable.of(!isDisabled)];
  const rowsExtension = (isMultiline: boolean, count: number): Extension =>
    isMultiline ? EditorView.theme({ ".cm-content": { minHeight: `calc(${count} * var(--by-text-code-size) * var(--by-text-code-leading))` } }) : [];
  const propsRef = useRef({ ariaLabel, ariaInvalid, readOnly, disabled, required, multiline });
  propsRef.current = { ariaLabel, ariaInvalid, readOnly, disabled, required, multiline };
  const appliedKey = useRef("");

  /**
   * The text area's ARIA attributes and the root's data-invalid and data-disabled, from the props
   * and from what Base UI's Field set on the hidden control (label, description, validity). Written
   * straight to the DOM and to CodeMirror: the Field updates its control without re-rendering us.
   */
  const applyMirror = () => {
    const control = controlRef.current;
    const root = rootRef.current;
    const view = viewRef.current;
    if (!control || !root) return;
    const p = propsRef.current;
    const read = (name: (typeof MIRRORED)[number]) => control.getAttribute(name);
    const invalid = p.ariaInvalid === true || p.ariaInvalid === "true" || read("aria-invalid") === "true" || read("data-invalid") !== null;
    root.toggleAttribute("data-invalid", invalid);
    root.toggleAttribute("data-disabled", p.disabled || read("data-disabled") !== null);
    const out: Record<string, string> = { "aria-multiline": p.multiline ? "true" : "false", spellcheck: "false", autocapitalize: "off", autocorrect: "off" };
    const labelledBy = read("aria-labelledby");
    const describedBy = read("aria-describedby");
    if (labelledBy) out["aria-labelledby"] = labelledBy;
    else if (p.ariaLabel) out["aria-label"] = p.ariaLabel;
    if (describedBy) out["aria-describedby"] = describedBy;
    if (invalid) out["aria-invalid"] = "true";
    if (p.readOnly) out["aria-readonly"] = "true";
    if (p.disabled) out["aria-disabled"] = "true";
    if (p.required || read("required") !== null) out["aria-required"] = "true";
    const key = JSON.stringify(out);
    if (!view || key === appliedKey.current) return;
    appliedKey.current = key;
    view.dispatch({ effects: compartments.current.attributes.reconfigure(EditorView.contentAttributes.of(out)) });
  };

  // Mount CodeMirror once; the effects below reconfigure it.
  useEffect(() => {
    const parent = mountRef.current;
    if (!parent) return;
    const c = compartments.current;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          bracketMatching(),
          tokenTheme,
          syntaxHighlighting(tokenHighlight),
          c.language.of(languageExtension(language)),
          c.lines.of(linesExtension(multiline)),
          c.edit.of(editExtension(readOnly, disabled)),
          c.placeholder.of(placeholder ? placeholderExtension(placeholder) : []),
          c.rows.of(rowsExtension(multiline, rows)),
          c.attributes.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const next = update.state.doc.toString();
              setText(next);
              if (!update.transactions.some((tr) => tr.annotation(fromProp))) latest.current.onValueChange?.(next);
            }
            if (update.focusChanged) {
              const hasFocus = update.view.hasFocus;
              setFocused(hasFocus);
              // Tell the Field (through its control) about focus and blur: focused, touched, validation on blur.
              controlRef.current?.dispatchEvent(new FocusEvent(hasFocus ? "focusin" : "focusout", { bubbles: true }));
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    // A FieldLabel click focuses the hidden control: move focus to the editor without the Field
    // seeing a blur in between.
    const control = controlRef.current;
    const redirect = () => view.focus();
    const keep = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && view.dom.contains(event.relatedTarget)) event.stopPropagation();
    };
    control?.addEventListener("focus", redirect);
    control?.addEventListener("focusout", keep);
    applyMirror();
    const observer = new MutationObserver(applyMirror);
    if (control) observer.observe(control, { attributes: true, attributeFilter: [...MIRRORED] });
    return () => {
      observer.disconnect();
      control?.removeEventListener("focus", redirect);
      control?.removeEventListener("focusout", keep);
      view.destroy();
      viewRef.current = null;
    };
    // Mounted once; later prop changes are applied by the effects below.
  }, []);

  const reconfigure = (compartment: Compartment, extension: Extension) => viewRef.current?.dispatch({ effects: compartment.reconfigure(extension) });
  useEffect(() => reconfigure(compartments.current.language, languageExtension(language)), [language]);
  useEffect(() => reconfigure(compartments.current.lines, linesExtension(multiline)), [multiline]);
  useEffect(() => reconfigure(compartments.current.edit, editExtension(readOnly, disabled)), [readOnly, disabled]);
  useEffect(() => reconfigure(compartments.current.placeholder, placeholder ? placeholderExtension(placeholder) : []), [placeholder]);
  useEffect(() => reconfigure(compartments.current.rows, rowsExtension(multiline, rows)), [multiline, rows]);
  // Props may have changed the attributes; cheap when nothing did.
  useLayoutEffect(applyMirror);

  // A controlled value (pretty-printed in pretty mode) that differs from the text replaces it.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === undefined) return;
    const next = shown(value);
    const current = view.state.doc.toString();
    if (current === next) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: next }, annotations: fromProp.of(true) });
    // shown() depends on pretty and language, which are in the list.
  }, [value, pretty, language]);

  return (
    <div
      data-slot="code-input"
      data-size={size}
      data-multiline={multiline ? "" : undefined}
      data-readonly={readOnly ? "" : undefined}
      data-focused={focused ? "" : undefined}
      className={cn(base, codeInputVariants.size[size], className)}
      ref={(node) => {
        rootRef.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
      {...props}
    >
      {/* CodeMirror renders inside; its own cm-* classes are not token classes (data-foreign-dom). */}
      <div ref={mountRef} data-slot="code-input-editor" data-foreign-dom="" className="flex min-w-0 flex-1 items-center self-stretch" />
      <InputPrimitive
        ref={controlRef}
        data-slot="code-input-control"
        id={id}
        name={name}
        required={required}
        disabled={disabled}
        readOnly={readOnly}
        value={text}
        onValueChange={() => {}}
        tabIndex={-1}
        aria-hidden
        className="sr-only"
      />
    </div>
  );
}
