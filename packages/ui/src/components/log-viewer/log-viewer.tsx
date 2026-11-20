import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Button } from "@/components/button/button";
import { SearchInput } from "@/components/search-input/search-input";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { tokenPx } from "@/lib/theme-scope";

// Log lines as they arrive (Mightyconsole spec §15, TSK-81): container and pod logs, a Compose
// project's merged logs. Lines go in through `ref.append` and live in a plain array, not in React
// state, so 50,000 lines cost one render per animation frame and the rows in view only. The oldest
// lines are dropped beyond `maxLines`. ANSI SGR colours and bold, italic, underline map to the
// terminal.* roles through an own parser (other escape sequences are stripped). Rows are
// virtualized; with `wrap`, each rendered row is measured. Mod+F searches the loaded lines (next,
// previous, the count). Follow keeps the newest line in view; scrolling up stops it, scrolling back
// to the end resumes it. Base UI has no part for it, so it is plain elements.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const logViewerVariants = {} as const;

const classes = {
  root: "flex w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-terminal text-terminal-fg",
  search: "flex shrink-0 items-center gap-inline-sm border-b border-border-subtle bg-layer px-inset-sm py-inset-xs",
  searchCount: "min-w-0 shrink-0 font-sans text-caption-1 text-fg-muted tabular-nums",
  scroller: ["relative min-h-0 flex-1 overflow-auto overscroll-contain font-mono text-code-sm", focusRing],
  sizer: "relative min-w-full",
  row: [
    "absolute left-0 flex min-w-full gap-inline-md border-s-2 border-transparent px-inset-sm",
    "data-wrap:right-0 data-wrap:whitespace-pre-wrap data-wrap:break-all",
    "not-data-wrap:whitespace-pre",
    "data-current:bg-hover",
  ],
  ts: "shrink-0 select-none text-fg-muted tabular-nums",
  stream: "flex shrink-0 select-none items-center gap-inline-xs text-fg-muted",
  swatch: "size-icon-xs shrink-0 rounded-xs",
  text: "min-w-0",
  match: "rounded-xs bg-editor-match text-terminal-fg data-current:bg-terminal-selection",
  empty: "p-inset-sm font-sans text-body-1 text-fg-muted",
  footer: "flex shrink-0 items-center gap-inline-sm border-t border-border-subtle bg-layer px-inset-sm py-inset-xs font-sans text-caption-1 text-fg-muted",
  footerText: "min-w-0 flex-1 truncate tabular-nums",
} as const;

// ---------------------------------------------------------------------------------------------
// ANSI SGR

/** The sixteen ANSI colours, by their terminal.ansi.* role names. */
export type AnsiColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "bright-black"
  | "bright-red"
  | "bright-green"
  | "bright-yellow"
  | "bright-blue"
  | "bright-magenta"
  | "bright-cyan"
  | "bright-white";

const ANSI_COLORS: readonly AnsiColor[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright-black",
  "bright-red",
  "bright-green",
  "bright-yellow",
  "bright-blue",
  "bright-magenta",
  "bright-cyan",
  "bright-white",
];

/** The SGR attributes of a run of text. */
export interface AnsiStyle {
  fg?: AnsiColor | undefined;
  bg?: AnsiColor | undefined;
  bold?: boolean | undefined;
  dim?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
  inverse?: boolean | undefined;
  strike?: boolean | undefined;
}

/** A run of text with one style. */
export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const PLAIN: AnsiStyle = Object.freeze({});

// SGR (ESC [ … m), any other CSI, OSC (ended by BEL or ST), two-character escapes, and the C0
// controls other than tab.
// eslint-disable-next-line no-control-regex -- terminal escapes are control characters
const ESCAPES = /\x1b\[([0-9;:]*)m|\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -/]*[0-~]|[\x00-\x08\x0a-\x1f\x7f]/g;

/** The colour of a 256-colour index, when it is one of the sixteen; null for the cube and greys. */
const indexed = (n: number): AnsiColor | undefined => (n >= 0 && n < 16 ? ANSI_COLORS[n] : undefined);

function applySgr(params: string, style: AnsiStyle): AnsiStyle {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number.parseInt(p, 10)));
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]!;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 21 || code === 22) {
      next.bold = undefined;
      next.dim = undefined;
    } else if (code === 23) next.italic = undefined;
    else if (code === 24) next.underline = undefined;
    else if (code === 27) next.inverse = undefined;
    else if (code === 29) next.strike = undefined;
    else if (code >= 30 && code <= 37) next.fg = ANSI_COLORS[code - 30];
    else if (code === 39) next.fg = undefined;
    else if (code >= 40 && code <= 47) next.bg = ANSI_COLORS[code - 40];
    else if (code === 49) next.bg = undefined;
    else if (code >= 90 && code <= 97) next.fg = ANSI_COLORS[code - 90 + 8];
    else if (code >= 100 && code <= 107) next.bg = ANSI_COLORS[code - 100 + 8];
    else if (code === 38 || code === 48) {
      // 38;5;n and 38;2;r;g;b: an index under 16 is one of the roles; the cube, the greys and
      // true colour have no role, so the text keeps its colour (no raw colour reaches the page).
      const mode = codes[i + 1];
      if (mode === 5) {
        const color = indexed(codes[i + 2] ?? -1);
        if (color) next[code === 38 ? "fg" : "bg"] = color;
        i += 2;
      } else if (mode === 2) i += 4;
    }
  }
  return Object.values(next).some((v) => v !== undefined) ? next : PLAIN;
}

/** A line as runs of styled text, its plain text, and the style it ends with. SGR only; other escapes are dropped. */
export function parseAnsi(input: string, start: AnsiStyle = PLAIN): { segments: AnsiSegment[]; text: string; end: AnsiStyle } {
  // A progress bar redraws its line after a carriage return: keep what was drawn last.
  let line = input.endsWith("\r\n") ? input.slice(0, -2) : input.endsWith("\r") || input.endsWith("\n") ? input.slice(0, -1) : input;
  const cr = line.lastIndexOf("\r");
  if (cr >= 0) line = line.slice(cr + 1);
  const segments: AnsiSegment[] = [];
  let style = start;
  let text = "";
  let at = 0;
  const push = (chunk: string) => {
    if (chunk === "") return;
    text += chunk;
    const last = segments[segments.length - 1];
    if (last && last.style === style) last.text += chunk;
    else segments.push({ text: chunk, style });
  };
  for (const match of line.matchAll(ESCAPES)) {
    push(line.slice(at, match.index));
    if (match[1] !== undefined) style = applySgr(match[1], style);
    at = match.index + match[0].length;
  }
  push(line.slice(at));
  return { segments, text, end: style };
}

const FG: Readonly<Record<AnsiColor, string>> = {
  black: "text-terminal-ansi-black",
  red: "text-terminal-ansi-red",
  green: "text-terminal-ansi-green",
  yellow: "text-terminal-ansi-yellow",
  blue: "text-terminal-ansi-blue",
  magenta: "text-terminal-ansi-magenta",
  cyan: "text-terminal-ansi-cyan",
  white: "text-terminal-ansi-white",
  "bright-black": "text-terminal-ansi-bright-black",
  "bright-red": "text-terminal-ansi-bright-red",
  "bright-green": "text-terminal-ansi-bright-green",
  "bright-yellow": "text-terminal-ansi-bright-yellow",
  "bright-blue": "text-terminal-ansi-bright-blue",
  "bright-magenta": "text-terminal-ansi-bright-magenta",
  "bright-cyan": "text-terminal-ansi-bright-cyan",
  "bright-white": "text-terminal-ansi-bright-white",
};

const BG: Readonly<Record<AnsiColor, string>> = {
  black: "bg-terminal-ansi-black",
  red: "bg-terminal-ansi-red",
  green: "bg-terminal-ansi-green",
  yellow: "bg-terminal-ansi-yellow",
  blue: "bg-terminal-ansi-blue",
  magenta: "bg-terminal-ansi-magenta",
  cyan: "bg-terminal-ansi-cyan",
  white: "bg-terminal-ansi-white",
  "bright-black": "bg-terminal-ansi-bright-black",
  "bright-red": "bg-terminal-ansi-bright-red",
  "bright-green": "bg-terminal-ansi-bright-green",
  "bright-yellow": "bg-terminal-ansi-bright-yellow",
  "bright-blue": "bg-terminal-ansi-bright-blue",
  "bright-magenta": "bg-terminal-ansi-bright-magenta",
  "bright-cyan": "bg-terminal-ansi-bright-cyan",
  "bright-white": "bg-terminal-ansi-bright-white",
};

/** The classes of a styled run: a coloured background takes terminal.bg as its text (each pair is checked). */
export function ansiClasses(style: AnsiStyle): string {
  if (style === PLAIN) return "";
  const out: string[] = [];
  const fg = style.inverse ? style.bg : style.fg;
  const bg = style.inverse ? (style.fg ?? "default") : style.bg;
  if (bg === "default") out.push("bg-terminal-fg text-terminal");
  else if (bg) out.push(BG[bg], "text-terminal");
  else if (fg) out.push(FG[fg]);
  else if (style.dim) out.push("text-fg-muted");
  if (style.bold) out.push("font-[var(--by-font-weight-bold)]");
  if (style.italic) out.push("italic");
  if (style.underline) out.push("underline");
  if (style.strike) out.push("line-through");
  return out.join(" ");
}

// ---------------------------------------------------------------------------------------------
// Lines

/** One log line. `text` may carry ANSI escapes. */
export interface LogLine {
  /** When it was written: RFC 3339 text (Docker's, Kubernetes') or milliseconds since the epoch. */
  ts?: string | number | undefined;
  /** Its stream or source: `stdout`, `stderr`, a Compose service. */
  stream?: string | undefined;
  text: string;
}

/** The colour that marks a stream: a status, or a chart category (a project's services). */
export type LogStreamColor = "neutral" | "danger" | "warning" | "success" | "info" | "cat-1" | "cat-2" | "cat-3" | "cat-4" | "cat-5" | "cat-6" | "cat-7" | "cat-8";

const STREAM_MARK: Readonly<Record<LogStreamColor, string>> = {
  neutral: "border-border-strong",
  danger: "border-danger-stroke",
  warning: "border-warning-border",
  success: "border-success-border",
  info: "border-info-border",
  "cat-1": "border-chart-1",
  "cat-2": "border-chart-2",
  "cat-3": "border-chart-3",
  "cat-4": "border-chart-4",
  "cat-5": "border-chart-5",
  "cat-6": "border-chart-6",
  "cat-7": "border-chart-7",
  "cat-8": "border-chart-8",
};

const STREAM_SWATCH: Readonly<Record<LogStreamColor, string>> = {
  neutral: "bg-border-strong",
  danger: "bg-danger",
  warning: "bg-warning",
  success: "bg-success",
  info: "bg-info",
  "cat-1": "bg-chart-1",
  "cat-2": "bg-chart-2",
  "cat-3": "bg-chart-3",
  "cat-4": "bg-chart-4",
  "cat-5": "bg-chart-5",
  "cat-6": "bg-chart-6",
  "cat-7": "bg-chart-7",
  "cat-8": "bg-chart-8",
};

/** `2026-11-20T01:02:03.123456789Z` as `2026-11-20 01:02:03.123` (UTC, as Docker writes it). */
export function formatLogTimestamp(ts: string | number): string {
  const text = typeof ts === "number" ? new Date(ts).toISOString() : ts;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,3})?\d*(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!match) return text;
  return `${match[1]} ${match[2]}${match[3] ?? ""}`;
}

interface Entry {
  line: LogLine;
  segments: AnsiSegment[];
  plain: string;
}

/** What `ref` gives. Lines never go through props: append them as they arrive. */
export interface LogViewerHandle {
  /** Adds lines at the end; the oldest are dropped beyond `maxLines`. */
  append: (lines: readonly LogLine[]) => void;
  /** Removes every line. */
  clear: () => void;
  /** The loaded lines, oldest first. */
  lines: () => readonly LogLine[];
  /** The loaded lines as text, one per line, timestamp and stream first when shown. */
  text: () => string;
  /** Opens the search bar (as Mod+F does). */
  openSearch: () => void;
  /** Scrolls to the newest line and turns follow on. */
  scrollToEnd: () => void;
}

export interface LogViewerProps {
  /** At most this many lines are kept; older ones are dropped. */
  maxLines?: number | undefined;
  /** Keep the newest line in view (controlled). Scrolling up turns it off through onFollowChange. */
  follow?: boolean | undefined;
  /** Follow at first (uncontrolled). */
  defaultFollow?: boolean | undefined;
  onFollowChange?: ((follow: boolean) => void) | undefined;
  /** Long lines wrap instead of scrolling sideways. */
  wrap?: boolean | undefined;
  /** Shows each line's `ts` in a column. */
  timestamps?: boolean | undefined;
  /** How a timestamp is shown; formatLogTimestamp by default. */
  formatTimestamp?: ((ts: string | number) => string) | undefined;
  /** The colour that marks each stream at the start of its rows; `{ stderr: "danger" }` by default. */
  streamColors?: Readonly<Record<string, LogStreamColor>> | undefined;
  /** Shows each line's `stream` in a column with its colour's swatch (a project's services). */
  streamColumn?: boolean | undefined;
  /** Shows a Download button in the footer; called with the loaded lines as text. */
  onDownload?: ((text: string) => void) | undefined;
  /** What an empty viewer says. */
  emptyText?: ReactNode;
  /** Accessible name of the log. */
  "aria-label"?: string | undefined;
  /** Rows rendered beyond the viewport on each side. */
  overscan?: number | undefined;
  /** Extra classes, merged after the component's own so they win; set the height here. */
  className?: string | undefined;
  ref?: Ref<LogViewerHandle> | undefined;
}

const DEFAULT_STREAM_COLORS: Readonly<Record<string, LogStreamColor>> = { stderr: "danger" };

interface Match {
  index: number;
  start: number;
}

/** Splits a row's runs at the search matches in it. */
function highlighted(segments: readonly AnsiSegment[], matches: readonly Match[], length: number, current: Match | undefined): ReactNode[] {
  const out: ReactNode[] = [];
  let offset = 0;
  let m = 0;
  segments.forEach((segment, s) => {
    const end = offset + segment.text.length;
    let at = offset;
    while (at < end) {
      const match = matches[m];
      const inMatch = match !== undefined && at >= match.start && at < match.start + length;
      const stop = match === undefined ? end : inMatch ? Math.min(end, match.start + length) : Math.min(end, Math.max(at, match.start));
      const text = segment.text.slice(at - offset, stop - offset);
      const style = ansiClasses(segment.style);
      if (inMatch) {
        out.push(
          <mark key={`${s}-${at}`} data-current={match === current ? "" : undefined} className={cn(classes.match, style)}>
            {text}
          </mark>,
        );
        if (stop === match.start + length) m += 1;
      } else if (text !== "") {
        out.push(style ? <span key={`${s}-${at}`} className={style}>{text}</span> : text);
      }
      at = stop === at ? end : stop;
    }
    offset = end;
  });
  return out;
}

/** Log lines as they arrive: virtualized rows, ANSI colours from the tokens, follow, wrap, timestamps, search. */
export function LogViewer({
  maxLines = 50_000,
  follow,
  defaultFollow = true,
  onFollowChange,
  wrap = false,
  timestamps = true,
  formatTimestamp = formatLogTimestamp,
  streamColors = DEFAULT_STREAM_COLORS,
  streamColumn = false,
  onDownload,
  emptyText = "No log lines yet.",
  "aria-label": label = "Log",
  overscan = 12,
  className,
  ref,
}: LogViewerProps) {
  const entries = useRef<Entry[]>([]);
  const dropped = useRef(0);
  const heights = useRef<number[]>([]);
  const offsets = useRef<number[] | null>(null);
  const [version, setVersion] = useState(0);
  // At most one render per frame: the first batch after a quiet frame renders at once, a burst
  // waits for the next animation frame.
  const frame = useRef(0);
  const lastRender = useRef(0);
  const bump = useCallback(() => {
    if (frame.current) return;
    const run = () => {
      frame.current = 0;
      lastRender.current = performance.now();
      setVersion((v) => v + 1);
    };
    if (performance.now() - lastRender.current > 16 || typeof requestAnimationFrame === "undefined") {
      frame.current = -1;
      queueMicrotask(run);
    } else frame.current = requestAnimationFrame(run);
  }, []);
  useEffect(() => () => {
    if (frame.current > 0) cancelAnimationFrame(frame.current);
  }, []);

  const [followState, setFollowState] = useState(defaultFollow);
  const following = follow ?? followState;
  const followingRef = useRef(following);
  followingRef.current = following;
  const setFollowing = useCallback(
    (next: boolean) => {
      if (next === followingRef.current) return;
      // Controlled: the prop stays the truth until the app renders the change.
      if (follow === undefined) {
        followingRef.current = next;
        setFollowState(next);
      }
      onFollowChange?.(next);
    },
    [follow, onFollowChange],
  );

  const scroller = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scrollTop: 0, viewport: 0, rowHeight: 20 });
  const programmatic = useRef(false);
  const rowHeight = view.rowHeight;

  const rowTop = useCallback(
    (index: number): number => {
      if (!wrap) return index * rowHeight;
      if (!offsets.current) {
        const list = new Array<number>(entries.current.length + 1);
        let top = 0;
        for (let i = 0; i < entries.current.length; i += 1) {
          list[i] = top;
          top += heights.current[i] || rowHeight;
        }
        list[entries.current.length] = top;
        offsets.current = list;
      }
      return offsets.current[index] ?? 0;
    },
    [wrap, rowHeight],
  );

  const scrollToEnd = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const target = element.scrollHeight - element.clientHeight;
    if (Math.abs(element.scrollTop - target) <= 1) return;
    programmatic.current = true;
    element.scrollTop = target;
    setView((previous) => (previous.scrollTop === element.scrollTop ? previous : { ...previous, scrollTop: element.scrollTop }));
  }, []);

  // Search.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const matches = useMemo<Match[]>(() => {
    if (!searchOpen || query === "") return [];
    const needle = query.toLowerCase();
    const out: Match[] = [];
    entries.current.forEach((entry, index) => {
      const hay = entry.plain.toLowerCase();
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) out.push({ index, start: at });
    });
    return out;
    // `version` stands for the lines array, which is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [searchOpen, query, version]);
  const current = matches.length > 0 ? matches[Math.min(currentIndex, matches.length - 1)] : undefined;

  const reveal = useCallback(
    (index: number) => {
      const element = scroller.current;
      if (!element) return;
      const top = rowTop(index);
      const bottom = rowTop(index + 1);
      const visible = element.clientHeight || rowHeight * 24;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (bottom > element.scrollTop + visible) element.scrollTop = bottom - visible;
      setView((previous) => ({ ...previous, scrollTop: element.scrollTop }));
    },
    [rowTop, rowHeight],
  );

  const step = useCallback(
    (by: 1 | -1) => {
      if (matches.length === 0) return;
      const next = (Math.min(currentIndex, matches.length - 1) + by + matches.length) % matches.length;
      setCurrentIndex(next);
      setFollowing(false);
      reveal(matches[next]!.index);
    },
    [matches, currentIndex, reveal, setFollowing],
  );

  // A new query starts at its first match in view or below, else the first one.
  useEffect(() => {
    if (matches.length === 0) return;
    const firstInView = Math.floor(view.scrollTop / rowHeight);
    const at = matches.findIndex((m) => m.index >= firstInView);
    setCurrentIndex(at >= 0 ? at : 0);
    // Only when the query changes, not on every new line.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [query, searchOpen]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    scroller.current?.focus();
  }, []);

  const lineText = useCallback(
    (entry: Entry) => {
      const parts: string[] = [];
      if (timestamps && entry.line.ts !== undefined) parts.push(formatTimestamp(entry.line.ts));
      if (entry.line.stream !== undefined && (streamColumn || streamColors[entry.line.stream])) parts.push(entry.line.stream);
      parts.push(entry.plain);
      return parts.join(" ");
    },
    [timestamps, formatTimestamp, streamColumn, streamColors],
  );

  useImperativeHandle(
    ref,
    () => ({
      append(lines) {
        if (lines.length === 0) return;
        for (const line of lines) {
          const { segments, text } = parseAnsi(line.text);
          entries.current.push({ line, segments, plain: text });
        }
        const over = entries.current.length - maxLines;
        if (over > 0) {
          // Drop in chunks of 10 % so a steady stream does not shift the array on every line.
          const cut = Math.min(entries.current.length, over + Math.floor(maxLines / 10));
          const removedHeight = rowTop(cut);
          entries.current.splice(0, cut);
          heights.current.splice(0, cut);
          dropped.current += cut;
          const element = scroller.current;
          if (element && !followingRef.current) {
            programmatic.current = true;
            element.scrollTop = Math.max(0, element.scrollTop - removedHeight);
          }
        }
        offsets.current = null;
        bump();
      },
      clear() {
        entries.current = [];
        heights.current = [];
        offsets.current = null;
        dropped.current = 0;
        bump();
      },
      lines: () => entries.current.map((e) => e.line),
      text: () => entries.current.map(lineText).join("\n"),
      openSearch,
      scrollToEnd() {
        setFollowing(true);
        scrollToEnd();
      },
    }),
    [maxLines, rowTop, bump, lineText, openSearch, setFollowing, scrollToEnd],
  );

  // The viewport and the row height (text.code-sm's line, as size.control.xs).
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const measure = () => {
      const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
      if (programmatic.current) programmatic.current = false;
      else if (followingRef.current && !atEnd) setFollowing(false);
      else if (!followingRef.current && atEnd && element.scrollTop > 0) setFollowing(true);
      setView((previous) => {
        const next = { scrollTop: element.scrollTop, viewport: element.clientHeight, rowHeight: tokenPx(element, "--by-size-control-xs", previous.rowHeight) };
        return next.scrollTop === previous.scrollTop && next.viewport === previous.viewport && next.rowHeight === previous.rowHeight ? previous : next;
      });
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [setFollowing]);

  // Wrapping changes every row's height.
  useEffect(() => {
    heights.current = [];
    offsets.current = null;
    bump();
  }, [wrap, timestamps, streamColumn, bump]);

  const count = entries.current.length;
  const total = rowTop(count);
  const height = view.viewport || rowHeight * 24;
  // The first row whose bottom is below the top of the view.
  let first = 0;
  if (wrap) {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rowTop(mid + 1) <= view.scrollTop) lo = mid + 1;
      else hi = mid;
    }
    first = lo;
  } else first = Math.floor(view.scrollTop / rowHeight);
  let last = first;
  while (last < count && rowTop(last) < view.scrollTop + height) last += 1;
  first = Math.max(0, first - overscan);
  last = Math.min(count, last + overscan);

  // Measure wrapped rows, keep the widest row's width for sideways scrolling, and follow.
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const container = rowsRef.current;
    if (!container) return;
    let changed = false;
    let widest = width;
    for (const row of container.children as HTMLCollectionOf<HTMLElement>) {
      const index = Number(row.dataset.index);
      if (wrap) {
        const h = row.offsetHeight;
        if (h > 0 && heights.current[index] !== h) {
          heights.current[index] = h;
          changed = true;
        }
      } else widest = Math.max(widest, row.scrollWidth);
    }
    if (!wrap && widest !== width) setWidth(widest);
    if (changed) {
      offsets.current = null;
      bump();
    }
    if (followingRef.current) scrollToEnd();
  });

  // A row's matches, by binary search into the sorted list.
  const matchesOf = (index: number): Match[] => {
    let lo = 0;
    let hi = matches.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (matches[mid]!.index < index) lo = mid + 1;
      else hi = mid;
    }
    const out: Match[] = [];
    for (let i = lo; i < matches.length && matches[i]!.index === index; i += 1) out.push(matches[i]!);
    return out;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openSearch();
    } else if (event.key === "F3") {
      event.preventDefault();
      if (!searchOpen) openSearch();
      else step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && searchOpen) {
      event.preventDefault();
      closeSearch();
    } else if (event.key === "End" && event.target === scroller.current) {
      event.preventDefault();
      setFollowing(true);
      scrollToEnd();
    }
  };

  const countId = useId();
  const rows: ReactNode[] = [];
  for (let index = first; index < last; index += 1) {
    const entry = entries.current[index]!;
    const stream = entry.line.stream;
    const color = stream === undefined ? undefined : streamColors[stream];
    const rowMatches = searchOpen && query !== "" ? matchesOf(index) : [];
    rows.push(
      <div
        key={dropped.current + index}
        data-slot="log-viewer-row"
        data-index={index}
        data-stream={stream}
        data-wrap={wrap ? "" : undefined}
        data-current={current?.index === index ? "" : undefined}
        className={cn(classes.row, color ? STREAM_MARK[color] : undefined)}
        style={{ top: rowTop(index), ...(wrap ? {} : { minHeight: rowHeight }) }}
      >
        {timestamps && entry.line.ts !== undefined ? <span className={classes.ts}>{formatTimestamp(entry.line.ts)}</span> : null}
        {streamColumn && stream !== undefined ? (
          <span className={classes.stream}>
            <span aria-hidden="true" className={cn(classes.swatch, STREAM_SWATCH[color ?? "neutral"])} />
            {stream}
          </span>
        ) : null}
        <span className={classes.text}>{rowMatches.length > 0 ? highlighted(entry.segments, rowMatches, query.length, current) : entry.segments.map((s, i) => (ansiClasses(s.style) ? <span key={i} className={ansiClasses(s.style)}>{s.text}</span> : s.text))}</span>
      </div>,
    );
  }

  const status = `${count.toLocaleString("en")} ${count === 1 ? "line" : "lines"}${dropped.current > 0 ? `, ${dropped.current.toLocaleString("en")} older dropped` : ""}`;

  return (
    <div data-slot="log-viewer" data-follow={following ? "" : undefined} className={cn(classes.root, className)} onKeyDown={onKeyDown}>
      {searchOpen ? (
        <div data-slot="log-viewer-search" role="search" className={classes.search}>
          <SearchInput
            ref={searchInput}
            size="small"
            aria-label="Search the log"
            aria-describedby={countId}
            value={query}
            onValueChange={setQuery}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
            className="min-w-0 flex-1"
          />
          <span id={countId} aria-live="polite" className={classes.searchCount}>
            {query === "" ? "" : matches.length === 0 ? "No matches" : `${Math.min(currentIndex, matches.length - 1) + 1} of ${matches.length}`}
          </span>
          <Button appearance="subtle" size="small" disabled={matches.length === 0} onClick={() => step(-1)}>
            Previous
          </Button>
          <Button appearance="subtle" size="small" disabled={matches.length === 0} onClick={() => step(1)}>
            Next
          </Button>
          <Button appearance="subtle" size="small" onClick={closeSearch}>
            Close
          </Button>
        </div>
      ) : null}
      <div
        ref={scroller}
        data-slot="log-viewer-scroller"
        role="log"
        aria-label={label}
        aria-live="off"
        // The scroller is the keyboard's way to scroll the log (arrows, Page Up and Down, Home, End).
        tabIndex={0}
        className={cn(classes.scroller)}
      >
        {count === 0 ? (
          <div data-slot="log-viewer-empty" className={classes.empty}>
            {emptyText}
          </div>
        ) : (
          <div ref={rowsRef} className={classes.sizer} style={{ height: total, ...(wrap || width === 0 ? {} : { width }) }}>
            {rows}
          </div>
        )}
      </div>
      <div data-slot="log-viewer-footer" className={classes.footer}>
        <span className={classes.footerText}>{status}</span>
        {following ? null : (
          <Button
            appearance="subtle"
            size="small"
            onClick={() => {
              setFollowing(true);
              scrollToEnd();
            }}
          >
            Follow
          </Button>
        )}
        {onDownload ? (
          <Button appearance="subtle" size="small" disabled={count === 0} onClick={() => onDownload(entries.current.map(lineText).join("\n"))}>
            Download
          </Button>
        ) : null}
      </div>
    </div>
  );
}
