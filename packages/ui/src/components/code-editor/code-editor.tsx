import { useEffect, useId, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { fieldAppearances, fieldFrame, fieldPadding, fieldSizes } from "@/lib/control";
import {
  applyTheme,
  isEditorStylesheet,
  loadMonaco,
  loadMonacoLanguage,
  MONACO_SCOPE_ATTRIBUTE,
  monacoMetrics,
  monacoTheme,
  setJsonSchema,
  tokenReader,
  type CodeLanguage,
  type Monaco,
  type MonacoEditor,
  type MonacoThemeData,
} from "@/lib/monaco";

// CodeEditor is Monaco for JSON, YAML, Protobuf and plain text (Mightyconsole spec section 12,
// TSK-80), as SqlEditor is for SQL: loaded lazily through @/lib/monaco, a plain textarea with
// the same text and keys until it has, a theme from the tokens of its region. JSON can be
// validated against a JSON Schema the app gives (completion and hovers come with it; nothing is
// fetched); `markers` underline the app's own problems by line and column; `diff` shows the
// text against an original. Base UI has no editor part, so this is a plain element.
//
// TSK-93 adds what Mightyconsole's query, JSON and jq inputs need: `singleLine` (Monaco as a
// one-line field in Fluent's input frame: no gutter, Enter submits, pasted line breaks become
// spaces), `completion` (the app's suggestions for this editor only; Ctrl+Space opens them), the
// `jq` grammar, languages an app registers with `registerCodeLanguage`, and `invalid`.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const codeEditorVariants = {
  variant: {
    outline: "rounded-lg border border-border-subtle border-b-border-control-bottom data-readonly:border-b-border-subtle",
    ghost: "",
  },
  /** The height of a `singleLine` editor, as Input's sizes. */
  size: {
    small: `${fieldSizes.small} ${fieldPadding.small}`,
    medium: `${fieldSizes.medium} ${fieldPadding.medium}`,
    large: `${fieldSizes.large} ${fieldPadding.large}`,
  },
} as const;

const base = [
  "relative flex h-panel-xs w-full min-h-0 min-w-0 flex-col overflow-hidden bg-editor text-editor-fg",
  "outline-none data-focused:outline-solid data-focused:outline-[length:var(--by-ring-width)] data-focused:outline-offset-[var(--by-ring-inner-width)] data-focused:outline-ring data-focused:ring-[length:var(--by-ring-inner-width)] data-focused:ring-ring-inner",
  "data-loading:cursor-progress",
  "data-invalid:border-danger-border data-invalid:border-b-danger-stroke",
];

// One line in Fluent's input frame: the field's fill, hairline and bottom edge, the accent
// underline on focus (not the ring), danger edges when invalid.
const singleLineBase = [
  "relative flex w-full min-w-0 overflow-hidden data-single-line:items-stretch",
  fieldFrame,
  fieldAppearances.outline,
  "text-editor-fg data-focused:shadow-focus-underline data-loading:cursor-progress",
  "data-invalid:border-danger-border data-invalid:border-b-danger-stroke",
  "data-readonly:border-b-border-subtle",
];

const fallbackClasses =
  "size-full flex-1 resize-none bg-editor p-inset-sm font-mono text-code text-editor-fg caret-editor-cursor outline-none selection:bg-editor-selection placeholder:text-editor-gutter";
const singleLineFallbackClasses =
  "w-full min-w-0 flex-1 resize-none overflow-hidden bg-transparent font-mono text-code leading-none whitespace-pre text-editor-fg caret-editor-cursor outline-none selection:bg-editor-selection placeholder:text-fg-subtle self-center";

/** What a completion item is, for its icon in the list. */
export type CodeCompletionKind = "keyword" | "field" | "operator" | "value" | "function" | "variable" | "constant" | "type" | "snippet" | "history";

/** One suggestion. */
export interface CodeCompletionItem {
  /** What the list shows, and what is inserted unless `insertText` says otherwise. */
  label: string;
  kind?: CodeCompletionKind | undefined;
  /** A short note beside the label: a type, "saved query", "seen in 3 rows". */
  detail?: string | undefined;
  /** A longer description in the details pane. */
  documentation?: string | undefined;
  insertText?: string | undefined;
  /** `insertText` is a snippet (`${1:value}` placeholders, `$0` for the cursor). */
  snippet?: boolean | undefined;
  /** Orders the list (compared as text); the label by default. */
  sortText?: string | undefined;
  /** What typing is matched against; the label by default. */
  filterText?: string | undefined;
  /** Replaces these offsets (0-based, end exclusive) instead of the word at the cursor. */
  replace?: { start: number; end: number } | undefined;
}

/** Where the suggestions are asked for. Offsets are 0-based into `text`. */
export interface CodeCompletionContext {
  text: string;
  offset: number;
  /** 1-based line and column of the cursor. */
  line: number;
  column: number;
  /** The word at the cursor up to it (`text.slice(word.start, offset)`). */
  word: { text: string; start: number; end: number };
  /** Typed (`invoke`: Ctrl+Space or the list reopening) or a trigger character (`trigger`). */
  reason: "invoke" | "trigger";
}

/** The app's suggestions for one editor (they never reach another editor of the language). */
export interface CodeCompletion {
  /** Characters that open the list as they are typed (`.`, `"`, a space). */
  triggerCharacters?: readonly string[] | undefined;
  provide(context: CodeCompletionContext): readonly CodeCompletionItem[] | Promise<readonly CodeCompletionItem[]>;
}

/** A problem to underline, by 1-based line and column (a codec's or a parser's error position). */
export interface CodeMarker {
  line: number;
  column: number;
  /** Exclusive end; without it, the rest of the word at the start (or one character). */
  endLine?: number;
  endColumn?: number;
  message: string;
  severity?: "error" | "warning" | "info";
}

/** A problem the language service found (JSON syntax, schema violations), by line and column. */
export interface CodeDiagnostic {
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface CodeEditorProps extends Omit<ComponentProps<"div">, "className" | "children" | "defaultValue" | "onChange" | "onSubmit"> {
  /** `outline`: a bordered field. `ghost`: no border, to fill a pane. */
  variant?: keyof typeof codeEditorVariants.variant | undefined;
  /** The grammar: JSON (with validation), YAML, Protobuf, jq, plain text, or an id an app registered with `registerCodeLanguage`. */
  language?: CodeLanguage | (string & {}) | undefined;
  /** One line in Fluent's input frame: no gutter or scrollbars, Enter submits, line breaks become spaces. */
  singleLine?: boolean | undefined;
  /** `singleLine` only: the field's height, as Input's (small, medium, large). */
  size?: keyof typeof codeEditorVariants.size | undefined;
  /** Danger edges on the frame (say why in a FieldError); sets data-invalid. */
  invalid?: boolean | undefined;
  /** The app's suggestions (search attributes, saved queries, fields), in Monaco's list; Ctrl+Space opens it. */
  completion?: CodeCompletion | undefined;
  /** The text, when controlled. */
  value?: string | undefined;
  /** The initial text, when uncontrolled. */
  defaultValue?: string | undefined;
  /** Called with the whole text after every change. */
  onValueChange?: ((value: string) => void) | undefined;
  /** Mod+Enter (Ctrl+Enter, Cmd+Enter on macOS), and Enter when `singleLine`, with the text: Send, Apply, Run. */
  onSubmit?: ((value: string) => void) | undefined;
  /** JSON only: the JSON Schema the text is validated against (completion and hovers too). */
  jsonSchema?: object | undefined;
  /** The app's problems to underline (a hover shows the message; F8 moves to the next one). */
  markers?: readonly CodeMarker[] | undefined;
  /** Called when the language service's problems change (JSON syntax and schema), for a status line. */
  onDiagnosticsChange?: ((diagnostics: CodeDiagnostic[]) => void) | undefined;
  /** Shows the text against `original` side by side (inline when narrow); the text stays editable unless readOnly. */
  diff?: { original: string } | undefined;
  /** Text can be selected and copied but not changed. */
  readOnly?: boolean | undefined;
  /** Shown while the editor is empty. */
  placeholder?: string | undefined;
  /** Line numbers in the gutter. */
  lineNumbers?: boolean | undefined;
  /** Tab moves focus instead of indenting (Ctrl+M toggles it at any time). */
  tabMovesFocus?: boolean | undefined;
  /** Accessible name of the text area; use it, or aria-labelledby on a visible label. */
  "aria-label"?: string | undefined;
  /** Called once Monaco has mounted, with the editor and the Monaco API. */
  onEditorReady?: ((editor: MonacoEditor, monaco: Monaco) => void) | undefined;
  /** Extra classes, merged after the component's own so they win; set the height here. */
  className?: string | undefined;
}

const SEVERITY = { error: 8, warning: 4, info: 2 } as const;
const FROM_SEVERITY = (n: number): CodeDiagnostic["severity"] => (n >= 8 ? "error" : n >= 4 ? "warning" : "info");
const MONACO_LANGUAGES: Record<CodeLanguage, string> = { json: "json", yaml: "yaml", protobuf: "proto", plaintext: "plaintext", jq: "jq" };
const LABELS: Record<CodeLanguage, string> = { json: "JSON editor", yaml: "YAML editor", protobuf: "Protobuf editor", plaintext: "Text editor", jq: "jq editor" };
const monacoLanguage = (language: string) => (MONACO_LANGUAGES as Record<string, string>)[language] ?? language;
const defaultLabel = (language: string) => (LABELS as Record<string, string>)[language] ?? "Code editor";
const COMPLETION_KIND: Record<CodeCompletionKind, string> = {
  keyword: "Keyword",
  field: "Field",
  operator: "Operator",
  value: "Value",
  function: "Function",
  variable: "Variable",
  constant: "Constant",
  type: "TypeParameter",
  snippet: "Snippet",
  history: "Reference",
};
/** Line breaks in a one-line editor (typed, pasted or set) become spaces. */
const oneLine = (text: string) => text.replace(/\r\n|\r|\n/g, " ");

/** Monaco's options for a one-line field: no gutter, rulers, scrollbars or line highlight. */
const SINGLE_LINE_OPTIONS = {
  lineNumbers: "off" as const,
  glyphMargin: false,
  folding: false,
  lineDecorationsWidth: 0,
  lineNumbersMinChars: 0,
  renderLineHighlight: "none" as const,
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  scrollbar: { vertical: "hidden" as const, horizontal: "hidden" as const, alwaysConsumeMouseWheel: false, useShadows: false },
  wordWrap: "off" as const,
  scrollBeyondLastColumn: 0,
  occurrencesHighlight: "off" as const,
  renderWhitespace: "none" as const,
  guides: { indentation: false },
  find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: "never" as const },
  suggest: { showStatusBar: false },
};

/**
 * A code editor on Monaco for JSON, YAML, Protobuf and text, themed by the design tokens of its
 * region and loaded lazily from the app's bundle, with no network. JSON validates against a JSON
 * Schema; Mod+Enter submits; markers underline problems; `diff` compares with an original.
 */
export function CodeEditor({
  variant = "outline",
  language = "json",
  singleLine = false,
  size = "medium",
  invalid = false,
  completion,
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  jsonSchema,
  markers,
  onDiagnosticsChange,
  diff,
  readOnly = false,
  placeholder,
  lineNumbers = true,
  tabMovesFocus = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  onEditorReady,
  className,
  ref,
  ...props
}: CodeEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const [editor, setEditor] = useState<{ editor: MonacoEditor; monaco: Monaco; original: { setValue: (v: string) => void } | undefined } | null>(null);
  const [focused, setFocused] = useState(false);
  const pendingFocus = useRef(false);
  const [fallbackText, setFallbackText] = useState(value ?? defaultValue);
  const latest = useRef({ onValueChange, onSubmit, onDiagnosticsChange, value, onEditorReady, completion });
  latest.current = { onValueChange, onSubmit, onDiagnosticsChange, value, onEditorReady, completion };
  const emitted = useRef<string[]>([]);
  const applying = useRef(false);
  const text = value ?? fallbackText;
  const textRef = useRef(text);
  textRef.current = text;
  const label = ariaLabel ?? defaultLabel(language);
  const showLineNumbers = lineNumbers && !singleLine;
  const optionsRef = useRef({ readOnly, language, placeholder, lineNumbers: showLineNumbers, tabMovesFocus, label, diff, singleLine });
  optionsRef.current = { readOnly, language, placeholder, lineNumbers: showLineNumbers, tabMovesFocus, label, diff, singleLine };
  // One URI per editor, so a JSON Schema applies to this model only.
  const uri = `inmemory://byterygon/code-editor/${useId().replace(/[^A-Za-z0-9]/g, "")}.json`;

  // Mount Monaco once, after the first paint; the fallback textarea serves until then.
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    Promise.all([loadMonaco(), loadMonacoLanguage(optionsRef.current.language)]).then(
      ([monaco]) => {
        const root = rootRef.current;
        const surface = surfaceRef.current;
        if (disposed || !root || !surface) return;
        const reader = tokenReader(root);
        const fallback = fallbackRef.current && !fallbackRef.current.hidden ? fallbackRef.current : null;
        const hadFocus = fallback !== null && fallback.ownerDocument.activeElement === fallback;
        const o = optionsRef.current;
        const doc = root.ownerDocument;
        let theme: MonacoThemeData = monacoTheme(reader);
        applyTheme(monaco, theme, doc);
        const initialText = fallback?.value ?? textRef.current;
        const model = monaco.editor.createModel(o.singleLine ? oneLine(initialText) : initialText, monacoLanguage(o.language), monaco.Uri.parse(uri));
        // A one-line editor centres its line in the field: padding from the frame's inner height.
        const metrics = () => {
          const m = monacoMetrics(reader);
          if (!o.singleLine) return m;
          const room = Math.max(0, root.clientHeight - m.lineHeight);
          return { ...m, padding: { top: Math.floor(room / 2), bottom: Math.ceil(room / 2) } };
        };
        const options = {
          ...metrics(),
          ariaLabel: o.label,
          readOnly: o.readOnly,
          placeholder: o.placeholder,
          lineNumbers: o.lineNumbers ? ("on" as const) : ("off" as const),
          tabFocusMode: o.tabMovesFocus,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
          fontLigatures: false,
          stickyScroll: { enabled: false },
          wordBasedSuggestions: "off" as const,
          links: false,
          ...(o.singleLine ? SINGLE_LINE_OPTIONS : {}),
        };
        let instance: MonacoEditor;
        let originalModel: ReturnType<Monaco["editor"]["createModel"]> | undefined;
        let diffEditor: ReturnType<Monaco["editor"]["createDiffEditor"]> | undefined;
        if (o.diff) {
          originalModel = monaco.editor.createModel(o.diff.original, monacoLanguage(o.language));
          diffEditor = monaco.editor.createDiffEditor(surface, { ...options, originalEditable: false, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true });
          diffEditor.setModel({ original: originalModel, modified: model });
          instance = diffEditor.getModifiedEditor();
        } else {
          instance = monaco.editor.create(surface, { ...options, model });
        }
        applyTheme(monaco, theme, doc);
        pendingFocus.current = hadFocus;
        if (ariaLabelledBy) instance.getDomNode()?.querySelector("textarea, [role='textbox']")?.setAttribute("aria-labelledby", ariaLabelledBy);

        instance.addAction({
          id: "byterygon.code-editor.submit",
          label: "Submit",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
          run: () => latest.current.onSubmit?.(model.getValue()),
        });
        if (o.singleLine) {
          // Enter submits, as in a form's field; with the suggestions open it accepts one instead.
          instance.addCommand(monaco.KeyCode.Enter, () => latest.current.onSubmit?.(model.getValue()), "!suggestWidgetVisible");
        }
        const changes = model.onDidChangeContent(() => {
          if (applying.current) return;
          const next = model.getValue();
          if (optionsRef.current.singleLine && /[\r\n]/.test(next)) {
            // A pasted line break: replaced by a space in a follow-up edit, which reports the text.
            queueMicrotask(() => {
              if (!model.isDisposed?.() && /[\r\n]/.test(model.getValue())) instance.executeEdits("byterygon.code-editor.one-line", [{ range: model.getFullModelRange(), text: oneLine(model.getValue()), forceMoveMarkers: true }]);
            });
            return;
          }
          if (latest.current.value !== undefined) {
            emitted.current.push(next);
            if (emitted.current.length > 32) emitted.current.splice(0, emitted.current.length - 32);
          }
          latest.current.onValueChange?.(next);
        });
        // The language service's problems (JSON syntax, the schema), not the app's markers.
        const report = () => {
          const found = monaco.editor
            .getModelMarkers({ resource: model.uri })
            .filter((m) => m.owner !== "byterygon")
            .map((m) => ({ line: m.startLineNumber, column: m.startColumn, message: m.message, severity: FROM_SEVERITY(m.severity) }));
          latest.current.onDiagnosticsChange?.(found);
        };
        const diagnostics = monaco.editor.onDidChangeMarkers(report);
        let frame = 0;
        const retheme = () => {
          frame = 0;
          if (disposed) return;
          theme = monacoTheme(reader);
          applyTheme(monaco, theme, doc);
          instance.updateOptions(metrics());
        };
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(retheme);
        };
        const observer = new MutationObserver((records) => {
          for (const r of records) {
            const target = r.target as Node;
            const own = (n: Node | null) => n !== null && (isEditorStylesheet(n) || (n.parentNode !== null && isEditorStylesheet(n.parentNode)));
            const sheet = (n: Node) => (n.nodeName === "STYLE" || n.nodeName === "LINK") && !isEditorStylesheet(n);
            if (own(target)) continue;
            if ((r.type === "attributes" && target.contains(root)) || doc.head.contains(target) || sheet(target) || [...r.addedNodes, ...r.removedNodes].some(sheet)) {
              schedule();
              return;
            }
          }
        });
        observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-density"], subtree: true, childList: true, characterData: true });
        const focus = instance.onDidFocusEditorWidget(() => {
          setFocused(true);
          applyTheme(monaco, theme, doc);
        });
        const blur = instance.onDidBlurEditorWidget(() => setFocused(false));
        setEditor({ editor: instance, monaco, original: originalModel });
        latest.current.onEditorReady?.(instance, monaco);
        cleanup = () => {
          if (frame) cancelAnimationFrame(frame);
          observer.disconnect();
          changes.dispose();
          diagnostics.dispose();
          focus.dispose();
          blur.dispose();
          (diffEditor ?? instance).dispose();
          model.dispose();
          originalModel?.dispose();
          reader.dispose();
          setJsonSchema(uri, undefined);
        };
      },
      () => {
        // Monaco could not load (a blocked chunk or worker): the textarea stays and keeps working.
      },
    );
    return () => {
      disposed = true;
      cleanup();
    };
    // Mounted once; later prop changes are applied by the effects below.
  }, []);

  useEffect(() => {
    if (!editor || !pendingFocus.current) return;
    pendingFocus.current = false;
    editor.editor.focus();
  }, [editor]);

  useEffect(() => {
    editor?.editor.updateOptions({ readOnly, placeholder, lineNumbers: showLineNumbers ? "on" : "off", tabFocusMode: tabMovesFocus, ariaLabel: label });
  }, [editor, readOnly, placeholder, showLineNumbers, tabMovesFocus, label]);

  useEffect(() => {
    const model = editor?.editor.getModel();
    if (!model || !editor) return;
    let stale = false;
    loadMonacoLanguage(language).then(() => {
      if (!stale) editor.monaco.editor.setModelLanguage(model, monacoLanguage(language));
    }, () => {});
    return () => {
      stale = true;
    };
  }, [editor, language]);

  // The app's suggestions: one provider per editor and language, answering for this model only.
  const hasCompletion = completion !== undefined;
  const triggers = (completion?.triggerCharacters ?? []).join("");
  useEffect(() => {
    const model = editor?.editor.getModel();
    if (!model || !editor || !hasCompletion) return;
    const { monaco } = editor;
    const kinds = monaco.languages.CompletionItemKind as unknown as Record<string, number>;
    const provider = monaco.languages.registerCompletionItemProvider(monacoLanguage(language), {
      triggerCharacters: [...triggers],
      provideCompletionItems: async (target, position, context) => {
        const source = latest.current.completion;
        if (!source || target.uri.toString() !== model.uri.toString()) return { suggestions: [] };
        const text = target.getValue();
        const offset = target.getOffsetAt(position);
        const word = target.getWordUntilPosition(position);
        const wordStart = target.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn });
        const items = await source.provide({
          text,
          offset,
          line: position.lineNumber,
          column: position.column,
          word: { text: word.word, start: wordStart, end: offset },
          reason: context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter ? "trigger" : "invoke",
        });
        const wordRange = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: position.column };
        const rangeOf = (r: { start: number; end: number }) => {
          const start = target.getPositionAt(r.start);
          const end = target.getPositionAt(r.end);
          return { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
        };
        return {
          suggestions: items.map((item) => ({
            label: item.detail ? { label: item.label, description: item.detail } : item.label,
            kind: kinds[COMPLETION_KIND[item.kind ?? "value"]] ?? 0,
            insertText: item.insertText ?? item.label,
            range: item.replace ? rangeOf(item.replace) : wordRange,
            ...(item.detail !== undefined ? { detail: item.detail } : {}),
            ...(item.documentation !== undefined ? { documentation: item.documentation } : {}),
            ...(item.snippet ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
            ...(item.sortText !== undefined ? { sortText: item.sortText } : {}),
            ...(item.filterText !== undefined ? { filterText: item.filterText } : {}),
          })),
        };
      },
    });
    return () => provider.dispose();
  }, [editor, language, hasCompletion, triggers]);

  // The schema applies while this editor is JSON.
  useEffect(() => {
    if (!editor) return;
    setJsonSchema(uri, language === "json" ? jsonSchema : undefined);
  }, [editor, uri, language, jsonSchema]);

  useEffect(() => {
    if (editor?.original && diff) editor.original.setValue(diff.original);
  }, [editor, diff?.original]);

  // A controlled value replaces the text as one undoable edit, unless the editor reported it.
  useEffect(() => {
    const model = editor?.editor.getModel();
    if (!model || !editor || value === undefined) return;
    const seen = emitted.current.indexOf(value);
    if (seen !== -1) {
      emitted.current.splice(0, seen + 1);
      return;
    }
    if (model.getValue() === value) {
      emitted.current = [];
      return;
    }
    emitted.current = [];
    const next = singleLine ? oneLine(value) : value;
    if (model.getValue() === next) return;
    applying.current = true;
    try {
      editor.editor.executeEdits("byterygon.code-editor.value", [{ range: model.getFullModelRange(), text: next, forceMoveMarkers: true }]);
    } finally {
      applying.current = false;
    }
  }, [editor, value, singleLine]);

  useEffect(() => {
    const model = editor?.editor.getModel();
    if (!model || !editor) return;
    editor.monaco.editor.setModelMarkers(
      model,
      "byterygon",
      (markers ?? []).map((m) => {
        const endLine = m.endLine ?? m.line;
        const endColumn = m.endColumn ?? m.column + 1;
        return { startLineNumber: m.line, startColumn: m.column, endLineNumber: endLine, endColumn, message: m.message, severity: SEVERITY[m.severity ?? "error"] };
      }),
    );
  }, [editor, markers, value]);

  const onFallbackKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey || singleLine)) return;
    event.preventDefault();
    onSubmit?.(event.currentTarget.value);
  };

  return (
    <div
      data-slot="code-editor"
      data-variant={variant}
      data-language={language}
      data-single-line={singleLine ? "" : undefined}
      data-size={singleLine ? size : undefined}
      data-invalid={invalid ? "" : undefined}
      {...{ [MONACO_SCOPE_ATTRIBUTE]: "" }}
      data-loading={editor ? undefined : ""}
      data-readonly={readOnly ? "" : undefined}
      data-focused={focused ? "" : undefined}
      aria-busy={editor ? undefined : true}
      className={singleLine ? cn(singleLineBase, codeEditorVariants.size[size], className) : cn(base, codeEditorVariants.variant[variant], className)}
      ref={(node) => {
        rootRef.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
      {...props}
    >
      <textarea
        ref={fallbackRef}
        data-slot="code-editor-fallback"
        hidden={editor !== null}
        aria-hidden={editor ? true : undefined}
        tabIndex={editor ? -1 : undefined}
        aria-label={ariaLabelledBy ? undefined : label}
        aria-labelledby={ariaLabelledBy}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        readOnly={readOnly || editor !== null}
        placeholder={placeholder}
        rows={singleLine ? 1 : undefined}
        aria-invalid={invalid || undefined}
        value={editor ? "" : text}
        onChange={(event) => {
          const next = singleLine ? oneLine(event.currentTarget.value) : event.currentTarget.value;
          if (value === undefined) setFallbackText(next);
          onValueChange?.(next);
        }}
        onKeyDown={onFallbackKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={singleLine ? singleLineFallbackClasses : fallbackClasses}
      />
      <div ref={surfaceRef} data-slot="code-editor-surface" hidden={!editor} className="min-h-0 min-w-0 flex-1" />
    </div>
  );
}
