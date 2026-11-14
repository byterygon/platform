import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { applyTheme, isEditorStylesheet, loadMonaco, MONACO_SCOPE_ATTRIBUTE, monacoMetrics, monacoTheme, tokenReader, type Monaco, type MonacoEditor, type MonacoThemeData } from "@/lib/monaco";

// SqlEditor is Monaco (spec section 7; Uy Son, 2026-11-13), loaded lazily through @/lib/monaco.
// Until Monaco has loaded, a plain textarea with the same value, colours and keys stands in, so
// the first keystroke never waits for the editor bundle; Monaco then takes over the text, the
// selection and the focus. Base UI has no editor part, so this is a plain element.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const sqlEditorVariants = {
  variant: {
    outline: "rounded-md border border-border-strong data-readonly:border-border",
    ghost: "",
  },
} as const;

const base = [
  "relative flex h-panel-xs w-full min-h-0 min-w-0 flex-col overflow-hidden bg-editor text-editor-fg",
  "outline-none data-focused:outline-solid data-focused:outline-[length:var(--by-ring-width)] data-focused:outline-offset-[var(--by-ring-offset)] data-focused:outline-ring",
  "data-loading:cursor-progress",
];

const fallbackClasses =
  "block size-full flex-1 resize-none bg-editor p-inset-sm font-mono text-code text-editor-fg caret-editor-cursor outline-none selection:bg-editor-selection placeholder:text-editor-gutter";

/** A statement in the editor's text: offsets (UTF-16, end exclusive, no `;`) and its text. */
export interface SqlStatement {
  start: number;
  end: number;
  text: string;
}

/** What Ctrl/Cmd+Enter asks to run. */
export interface SqlRun extends SqlStatement {
  /** "selection" when text was selected, else the statement under the cursor. */
  source: "selection" | "statement";
  /** The statements inside `text` (one for "statement"; any number for a selection). */
  statements: SqlStatement[];
}

/** A problem to underline, by offsets in the text (a PostgreSQL error position minus one). */
export interface SqlMarker {
  start: number;
  /** Exclusive end; without it, the word at `start` (or one character) is marked. */
  end?: number;
  message: string;
  severity?: "error" | "warning" | "info";
}

const WORD = /[\p{L}\p{N}_$]/u;

/**
 * Splits SQL on top-level semicolons, the way PostgreSQL reads it: quotes ('' escapes), E'' strings
 * (backslash escapes), "identifiers", $tag$ dollar quotes, -- line comments and nested block
 * comments hide their semicolons. Returns every non-blank statement, trimmed of whitespace.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  return segments(sql).filter((s) => !s.blank).map(({ start, end }) => ({ start, end, text: sql.slice(start, end) }));
}

interface Segment {
  start: number;
  end: number;
  /** The offset just past the `;` (or the end of the text). */
  limit: number;
  blank: boolean;
}

function segments(sql: string): Segment[] {
  const out: Segment[] = [];
  let segmentStart = 0;
  let firstCode = -1;
  let lastCode = -1;
  const code = (from: number, to: number) => {
    if (firstCode < 0) firstCode = from;
    lastCode = to;
  };
  const close = (end: number, limit: number) => {
    out.push(firstCode < 0 ? { start: segmentStart, end: segmentStart, limit, blank: true } : { start: firstCode, end: trimEnd(sql, firstCode, Math.max(lastCode, end)), limit, blank: false });
    segmentStart = limit;
    firstCode = -1;
    lastCode = -1;
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") (depth += 1), (j += 2);
        else if (sql[j] === "*" && sql[j + 1] === "/") (depth -= 1), (j += 2);
        else j += 1;
      }
      i = j;
      continue;
    }
    if (ch === "'") {
      const escapes = (sql[i - 1] === "E" || sql[i - 1] === "e") && !WORD.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      code(escapes ? i - 1 : i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j += 1;
      }
      code(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }
    if (ch === "$" && !WORD.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const endTag = sql.indexOf(tag[0], i + tag[0].length);
        const stop = endTag < 0 ? sql.length : endTag + tag[0].length;
        code(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      close(i, i + 1);
      i += 1;
      continue;
    }
    if (!/\s/.test(ch)) code(i, i + 1);
    i += 1;
  }
  if (segmentStart < sql.length || out.length === 0) close(sql.length, sql.length);
  return out;
}

const trimEnd = (sql: string, start: number, end: number) => {
  let e = end;
  while (e > start && /\s/.test(sql[e - 1]!)) e -= 1;
  return e;
};

/**
 * The statement at a cursor offset: the one whose text, or the gap up to its `;`, holds the
 * cursor. A cursor in blank space or comments between statements takes the statement before it,
 * else the next one; null when the text has no statement.
 */
export function sqlStatementAt(sql: string, offset: number): SqlStatement | null {
  const all = segments(sql);
  const index = all.findIndex((s, i) => offset <= s.limit || i === all.length - 1);
  const at = all[index];
  if (!at) return null;
  const pick = (s: Segment | undefined) => (s && !s.blank ? { start: s.start, end: s.end, text: sql.slice(s.start, s.end) } : null);
  if (!at.blank && offset >= (all[index - 1]?.limit ?? 0)) {
    // In a segment's leading blank space, before its first token: the previous statement wins
    // when the cursor sits on the line it ended on.
    const previous = all.slice(0, index).reverse().find((s) => !s.blank);
    if (previous && offset < at.start && !sql.slice(previous.limit, offset).includes("\n")) return pick(previous);
    return pick(at);
  }
  for (let i = index - 1; i >= 0; i -= 1) if (!all[i]!.blank) return pick(all[i]);
  for (let i = index + 1; i < all.length; i += 1) if (!all[i]!.blank) return pick(all[i]);
  return null;
}

/** What to run for a selection (start === end: none) and cursor, or null when there is nothing. */
export function sqlRunFor(sql: string, selectionStart: number, selectionEnd: number): SqlRun | null {
  if (selectionEnd > selectionStart) {
    const text = sql.slice(selectionStart, selectionEnd);
    if (text.trim() === "") return null;
    const statements = splitSqlStatements(text).map((s) => ({ start: s.start + selectionStart, end: s.end + selectionStart, text: s.text }));
    if (statements.length === 0) return null;
    return { start: selectionStart, end: selectionEnd, text, source: "selection", statements };
  }
  const statement = sqlStatementAt(sql, selectionStart);
  return statement ? { ...statement, source: "statement", statements: [statement] } : null;
}

export interface SqlEditorProps extends Omit<ComponentProps<"div">, "className" | "children" | "defaultValue" | "onChange"> {
  /** `outline`: a bordered field. `ghost`: no border, to fill a pane (a query tab). */
  variant?: keyof typeof sqlEditorVariants.variant;
  /** The text, when controlled. */
  value?: string;
  /** The initial text, when uncontrolled. */
  defaultValue?: string;
  /** Called with the whole text after every change. */
  onValueChange?: (value: string) => void;
  /** Ctrl+Enter (Cmd+Enter on macOS): the selection, or the statement under the cursor. */
  onRun?: (run: SqlRun) => void;
  /** Problems to underline (a hover shows the message; F8 moves to the next one). */
  markers?: readonly SqlMarker[];
  /** Text can be selected and copied but not changed. */
  readOnly?: boolean;
  /** Monaco grammar: PostgreSQL (default) or generic SQL. */
  language?: "pgsql" | "sql";
  /** Shown while the editor is empty. */
  placeholder?: string;
  /** Line numbers in the gutter. */
  lineNumbers?: boolean;
  /** Tab moves focus instead of indenting (Ctrl+M toggles it at any time). */
  tabMovesFocus?: boolean;
  /** Tells Monaco a screen reader is in use (its optimised mode); off means "detect". */
  screenReaderOptimized?: boolean;
  /** Accessible name of the text area; use it, or aria-labelledby on a visible label. */
  "aria-label"?: string;
  /** Called once Monaco has mounted, with the editor and the Monaco API, for features beyond these props. */
  onEditorReady?: (editor: MonacoEditor, monaco: Monaco) => void;
  /** Extra classes, merged after the component's own so they win; set the height here. */
  className?: string;
}

const SEVERITY = { error: 8, warning: 4, info: 2 } as const;

/**
 * A SQL editor on Monaco, themed by the design tokens of its region (Light/Dark, density, preset)
 * and loaded lazily from the app's bundle, with no network. Ctrl+Enter reports the selection or
 * the statement under the cursor; markers underline errors. The ref reaches the root element.
 */
export function SqlEditor({
  variant = "outline",
  value,
  defaultValue = "",
  onValueChange,
  onRun,
  markers,
  readOnly = false,
  language = "pgsql",
  placeholder,
  lineNumbers = true,
  tabMovesFocus = false,
  screenReaderOptimized = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  onEditorReady,
  className,
  ref,
  ...props
}: SqlEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const [editor, setEditor] = useState<{ editor: MonacoEditor; monaco: Monaco } | null>(null);
  const [focused, setFocused] = useState(false);
  const pendingFocus = useRef(false);
  const [fallbackText, setFallbackText] = useState(value ?? defaultValue);
  const latest = useRef({ onValueChange, onRun, value, onEditorReady });
  latest.current = { onValueChange, onRun, value, onEditorReady };
  const text = value ?? fallbackText;
  const textRef = useRef(text);
  textRef.current = text;
  const optionsRef = useRef({ readOnly, language, placeholder, lineNumbers, tabMovesFocus, screenReaderOptimized, ariaLabel });
  optionsRef.current = { readOnly, language, placeholder, lineNumbers, tabMovesFocus, screenReaderOptimized, ariaLabel };

  // Mount Monaco once, after the first paint; the fallback textarea serves until then.
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    loadMonaco().then(
      (monaco) => {
        const root = rootRef.current;
        const surface = surfaceRef.current;
        if (disposed || !root || !surface) return;
        const reader = tokenReader(root);
        const fallback = fallbackRef.current;
        const hadFocus = fallback !== null && fallback.ownerDocument.activeElement === fallback;
        const selection = fallback ? [fallback.selectionStart, fallback.selectionEnd] : [0, 0];
        const o = optionsRef.current;
        const doc = root.ownerDocument;
        let theme: MonacoThemeData = monacoTheme(reader);
        applyTheme(monaco, theme, doc);
        const model = monaco.editor.createModel(fallback?.value ?? textRef.current, o.language);
        const instance = monaco.editor.create(surface, {
          model,
          ...monacoMetrics(reader),
          ariaLabel: o.ariaLabel ?? "SQL editor",
          readOnly: o.readOnly,
          placeholder: o.placeholder,
          lineNumbers: o.lineNumbers ? "on" : "off",
          tabFocusMode: o.tabMovesFocus,
          accessibilitySupport: o.screenReaderOptimized ? "on" : "auto",
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderLineHighlight: "line",
          fixedOverflowWidgets: true,
          contextmenu: true,
          fontLigatures: false,
          bracketPairColorization: { enabled: false },
          guides: { indentation: false },
          overviewRulerLanes: 1,
          stickyScroll: { enabled: false },
          wordBasedSuggestions: "off",
          quickSuggestions: false,
          links: false,
        });
        // Monaco writes its stylesheet when the first editor mounts; map its colour classes now.
        applyTheme(monaco, theme, doc);
        const start = model.getPositionAt(selection[0] ?? 0);
        const end = model.getPositionAt(selection[1] ?? 0);
        instance.setSelection({ startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column });
        pendingFocus.current = hadFocus;
        if (ariaLabelledBy) instance.getDomNode()?.querySelector("textarea, [role='textbox']")?.setAttribute("aria-labelledby", ariaLabelledBy);

        const run = () => {
          const current = instance.getSelection();
          const sql = model.getValue();
          if (!current) return;
          const a = model.getOffsetAt(current.getStartPosition());
          const b = model.getOffsetAt(current.getEndPosition());
          const request = sqlRunFor(sql, a, b);
          if (request) latest.current.onRun?.(request);
        };
        instance.addAction({ id: "byterygon.sql-editor.run", label: "Run selection or statement", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run });

        const changes = model.onDidChangeContent(() => {
          const next = model.getValue();
          if (next !== latest.current.value) latest.current.onValueChange?.(next);
        });
        // Retheme when this editor's tokens may have changed: an attribute on the root or an
        // ancestor (data-theme, data-density, a class), a stylesheet added or edited (a preset),
        // or focus moving here from an editor in another region.
        let frame = 0;
        const retheme = () => {
          frame = 0;
          if (disposed) return;
          theme = monacoTheme(reader);
          applyTheme(monaco, theme, doc);
          instance.updateOptions(monacoMetrics(reader));
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

        setEditor({ editor: instance, monaco });
        latest.current.onEditorReady?.(instance, monaco);
        cleanup = () => {
          if (frame) cancelAnimationFrame(frame);
          observer.disconnect();
          changes.dispose();
          focus.dispose();
          blur.dispose();
          instance.dispose();
          model.dispose();
          reader.dispose();
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

  // The surface is hidden until Monaco is set, so focus moves over once it shows.
  useEffect(() => {
    if (!editor || !pendingFocus.current) return;
    pendingFocus.current = false;
    editor.editor.focus();
  }, [editor]);

  // Options after mount.
  useEffect(() => {
    editor?.editor.updateOptions({ readOnly, placeholder, lineNumbers: lineNumbers ? "on" : "off", tabFocusMode: tabMovesFocus, accessibilitySupport: screenReaderOptimized ? "on" : "auto", ariaLabel: ariaLabel ?? "SQL editor" });
  }, [editor, readOnly, placeholder, lineNumbers, tabMovesFocus, screenReaderOptimized, ariaLabel]);

  useEffect(() => {
    const model = editor?.editor.getModel();
    if (model && editor) editor.monaco.editor.setModelLanguage(model, language);
  }, [editor, language]);

  // A controlled value that differs from the model replaces the text as one undoable edit.
  useEffect(() => {
    const model = editor?.editor.getModel();
    if (!model || !editor || value === undefined || model.getValue() === value) return;
    editor.editor.executeEdits("byterygon.sql-editor.value", [{ range: model.getFullModelRange(), text: value, forceMoveMarkers: true }]);
  }, [editor, value]);

  useEffect(() => {
    const model = editor?.editor.getModel();
    if (!model || !editor) return;
    const sql = model.getValue();
    editor.monaco.editor.setModelMarkers(
      model,
      "byterygon",
      (markers ?? []).map((m) => {
        const startOffset = Math.max(0, Math.min(m.start, sql.length));
        let endOffset = m.end ?? startOffset;
        if (m.end === undefined) while (endOffset < sql.length && WORD.test(sql[endOffset]!)) endOffset += 1;
        if (endOffset <= startOffset) endOffset = Math.min(sql.length, startOffset + 1);
        const s = model.getPositionAt(startOffset);
        const e = model.getPositionAt(endOffset);
        return { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column, message: m.message, severity: SEVERITY[m.severity ?? "error"] };
      }),
    );
  }, [editor, markers, value]);

  const onFallbackKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const target = event.currentTarget;
    const request = sqlRunFor(target.value, target.selectionStart, target.selectionEnd);
    if (request) onRun?.(request);
  };

  return (
    <div
      data-slot="sql-editor"
      data-variant={variant}
      {...{ [MONACO_SCOPE_ATTRIBUTE]: "" }}
      data-loading={editor ? undefined : ""}
      data-readonly={readOnly ? "" : undefined}
      data-focused={focused ? "" : undefined}
      aria-busy={editor ? undefined : true}
      className={cn(base, sqlEditorVariants.variant[variant], className)}
      ref={(node) => {
        rootRef.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
      {...props}
    >
      {editor ? null : (
        <textarea
          ref={fallbackRef}
          data-slot="sql-editor-fallback"
          aria-label={ariaLabelledBy ? undefined : (ariaLabel ?? "SQL editor")}
          aria-labelledby={ariaLabelledBy}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          readOnly={readOnly}
          placeholder={placeholder}
          value={text}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (value === undefined) setFallbackText(next);
            onValueChange?.(next);
          }}
          onKeyDown={onFallbackKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={fallbackClasses}
        />
      )}
      <div ref={surfaceRef} data-slot="sql-editor-surface" hidden={!editor} className="min-h-0 flex-1" />
    </div>
  );
}
