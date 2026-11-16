import { jsonLanguage } from "@codemirror/lang-json";
import { PostgreSQL } from "@codemirror/lang-sql";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/cn";

// Read-only code: a statement in the history, the DDL of a table, a plugin's manifest, the About
// diagnostics. A <pre><code> in editor.* and syntax.* colours (the same roles as SqlEditor and
// CodeInput), highlighted without an editor: the CodeMirror grammars parse the text once and
// @lezer/highlight colours only the lines on screen. Line numbers, highlighted lines, a title bar
// and a copy button are optional. More than `virtualizeAfter` lines (1,000) are virtualized: only
// the lines in view are in the DOM, between two spacers, so a megabyte of SQL stays fast; lines
// then keep to one line each (`wrap` is ignored). Copy always copies the whole text.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const codeBlockVariants = {} as const;

/** Languages CodeBlock highlights. */
export type CodeBlockLanguage = "text" | "sql" | "json";

const classes = {
  root: "flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-editor font-mono text-code text-editor-fg",
  header: "flex h-control-sm shrink-0 items-center gap-inline-sm border-b border-border ps-inset-sm pe-inline-xs font-sans text-label text-fg-muted",
  title: "min-w-0 flex-1 truncate",
  scroller: [
    "relative min-h-0 flex-1 overflow-auto overscroll-contain py-inset-xs",
    "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:-outline-offset-[var(--by-ring-width)] focus-visible:outline-ring",
  ],
  pre: "m-0 min-w-full w-max font-mono text-code data-wrap:w-full",
  line: "flex min-w-full whitespace-pre data-highlighted:bg-editor-line data-wrap:whitespace-pre-wrap data-wrap:wrap-break-word data-wrap:w-full",
  gutter: "sticky inset-s-0 shrink-0 select-none bg-editor pe-inset-sm ps-inset-sm text-end text-editor-gutter tabular-nums",
  content: "min-w-0 flex-1 pe-inset-sm in-data-[numbers=false]:ps-inset-sm",
  copy: "shrink-0",
  status: "sr-only",
} as const;

/** Lezer highlight tags to the syntax.* text colours, written out for Tailwind. */
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], class: "text-syntax-keyword" },
  { tag: [t.string, t.regexp, t.special(t.string)], class: "text-syntax-string" },
  { tag: [t.number, t.integer, t.float], class: "text-syntax-number" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "text-syntax-comment" },
  { tag: [t.function(t.variableName), t.standard(t.name)], class: "text-syntax-function" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], class: "text-syntax-operator" },
  { tag: [t.typeName, t.propertyName], class: "text-syntax-type" },
  { tag: [t.name, t.variableName, t.special(t.name)], class: "text-syntax-identifier" },
  { tag: [t.bool, t.null, t.atom, t.constant(t.name)], class: "text-syntax-constant" },
  { tag: t.invalid, class: "text-syntax-error" },
]);

const parserFor = (language: CodeBlockLanguage) => (language === "sql" ? PostgreSQL.language.parser : language === "json" ? jsonLanguage.parser : null);

/** The offset where each line starts, and the length of the longest line. */
function lineIndex(code: string): { starts: number[]; longest: number } {
  const starts = [0];
  let longest = 0;
  let last = 0;
  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) {
    longest = Math.max(longest, i - last);
    starts.push(i + 1);
    last = i + 1;
  }
  longest = Math.max(longest, code.length - last);
  return { starts, longest };
}

const CopyIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
);
const CheckIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);

export interface CodeBlockProps {
  /** The text to show. */
  code: string;
  /** Grammar for highlighting: sql (PostgreSQL), json, or text (none). */
  language?: CodeBlockLanguage;
  /** Shows line numbers in a gutter; on by default for more than one line. */
  lineNumbers?: boolean;
  /** The number of the first line (a statement taken from line 40 of a file). */
  startLine?: number;
  /** 1-based line numbers to highlight (an error's line). */
  highlightLines?: readonly number[];
  /** Wraps long lines instead of scrolling sideways (ignored when virtualized). */
  wrap?: boolean;
  /** A title bar above the code (a file name, "Statement 2"). */
  title?: ReactNode;
  /** Shows a copy button (in the title bar, or floating when there is no title). */
  copyable?: boolean;
  /** Called after the text was copied. */
  onCopy?: (code: string) => void;
  /** Virtualize above this many lines. */
  virtualizeAfter?: number;
  /** Names the code region (focusable, so keyboard users can scroll it). */
  "aria-label"?: string;
  /** Extra classes on the frame (give it a height or a max-h-* class to scroll), merged after the component's own. */
  className?: string;
  /** Reaches the frame. */
  ref?: Ref<HTMLDivElement>;
}

/** Read-only, highlighted code with optional line numbers, title and copy; virtualized when long. */
export function CodeBlock({
  code,
  language = "text",
  lineNumbers,
  startLine = 1,
  highlightLines = [],
  wrap = false,
  title,
  copyable = true,
  onCopy,
  virtualizeAfter = 1000,
  "aria-label": ariaLabel,
  className,
  ref,
}: CodeBlockProps) {
  const text = code ?? "";
  const { starts, longest } = useMemo(() => lineIndex(text), [text]);
  const count = starts.length;
  const tree = useMemo(() => parserFor(language)?.parse(text) ?? null, [text, language]);
  const showNumbers = lineNumbers ?? count > 1;
  const virtual = count > virtualizeAfter;
  const wraps = wrap && !virtual;
  const highlighted = useMemo(() => new Set(highlightLines), [highlightLines]);
  const gutterChars = String(startLine + count - 1).length;
  const statusId = useId();

  const scroller = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scrollTop: 0, viewport: 0, lineHeight: 20 });
  useEffect(() => {
    const element = scroller.current;
    if (!element || !virtual) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const probe = element.querySelector<HTMLElement>('[data-slot="code-block-line"]');
      setView((previous) => {
        const next = { scrollTop: element.scrollTop, viewport: element.clientHeight, lineHeight: probe?.offsetHeight || previous.lineHeight };
        return next.scrollTop === previous.scrollTop && next.viewport === previous.viewport && next.lineHeight === previous.lineHeight ? previous : next;
      });
    };
    const schedule = () => {
      if (!frame) frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : (measure(), 0);
    };
    measure();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    };
  }, [virtual]);

  const overscan = 20;
  const viewport = view.viewport || view.lineHeight * 40;
  const first = virtual ? Math.max(0, Math.floor(view.scrollTop / view.lineHeight) - overscan) : 0;
  const last = virtual ? Math.min(count, Math.ceil((view.scrollTop + viewport) / view.lineHeight) + overscan) : count;

  const renderLine = (index: number) => {
    const from = starts[index]!;
    const to = index + 1 < count ? starts[index + 1]! - 1 : text.length;
    const pieces: ReactNode[] = [];
    if (tree) {
      let key = 0;
      highlightCode(
        text,
        tree,
        highlighter,
        (piece, cls) => {
          pieces.push(cls ? <span key={key++} className={cls}>{piece}</span> : piece);
        },
        () => {},
        from,
        to,
      );
    } else pieces.push(text.slice(from, to));
    const number = startLine + index;
    return (
      <div key={index} data-slot="code-block-line" data-highlighted={highlighted.has(number) ? "" : undefined} data-wrap={wraps ? "" : undefined} className={cn(classes.line)}>
        {showNumbers ? (
          <span aria-hidden="true" data-slot="code-block-gutter" style={{ minWidth: `${gutterChars + 2}ch` }} className={classes.gutter}>
            {number}
          </span>
        ) : null}
        <span className={classes.content}>{pieces.length ? pieces : "\n"}</span>
      </div>
    );
  };

  const lines: ReactNode[] = [];
  for (let index = first; index < last; index += 1) lines.push(renderLine(index));

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      onCopy?.(text);
    } catch {
      setCopied(false);
    }
  }, [text, onCopy]);

  const copyButton = copyable ? (
    <IconButton aria-label={copied ? "Copied" : "Copy code"} size="small" onClick={copy} className={classes.copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  ) : null;

  return (
    <div ref={ref} data-slot="code-block" data-language={language} data-virtual={virtual ? "" : undefined} className={cn(classes.root, className)}>
      {title !== undefined || copyable ? (
        <div data-slot="code-block-header" className={classes.header}>
          <span className={classes.title}>{title}</span>
          {copyButton}
        </div>
      ) : null}
      <div
        ref={scroller}
        data-slot="code-block-scroller"
        role="region"
        tabIndex={0}
        aria-label={ariaLabel ?? (typeof title === "string" ? title : "Code")}
        data-numbers={showNumbers ? "true" : "false"}
        className={cn(classes.scroller)}
      >
        <pre data-slot="code-block-pre" data-wrap={wraps ? "" : undefined} style={virtual ? { minWidth: `${longest + gutterChars + 6}ch` } : undefined} className={classes.pre}>
          <code>
            {virtual ? <div aria-hidden="true" style={{ height: first * view.lineHeight }} /> : null}
            {lines}
            {virtual ? <div aria-hidden="true" style={{ height: (count - last) * view.lineHeight }} /> : null}
          </code>
        </pre>
      </div>
      <span id={statusId} role="status" className={classes.status}>
        {copied ? "Copied to the clipboard" : ""}
      </span>
    </div>
  );
}
