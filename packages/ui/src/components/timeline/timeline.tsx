import { useCallback, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/tooltip/tooltip";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";

/** How an item is drawn: its status colour. `running` is an item that has no end yet. */
export type TimelineStatus = "running" | "success" | "danger" | "warning" | "info" | "neutral";

/**
 * The mark of an item. Spans: `bar` (filled by status; a running one is a tinted outline),
 * `hatched` (striped: something retrying), `dashed` (an outline: a timer, a wait). Instants:
 * `tick` (a short stroke: a workflow task), `diamond` (a signal, an update), `pin` (a marker).
 */
export type TimelineShape = "bar" | "hatched" | "dashed" | "tick" | "diamond" | "pin";

/** What the axis reads: clock times, or offsets from the origin ("since start"). */
export type TimelineAxis = "clock" | "offset";

/** A lane: one row of the timeline (a workflow, an activity, a timer, a child workflow). */
export interface TimelineLane {
  id: string;
  label: string;
  /** A short muted word or two at the end of the lane's label: "activity 5", "4 tasks". */
  detail?: string | undefined;
  /** An icon before the label (an `<Icon>`), decorative. */
  icon?: ReactNode;
}

/** A span (or an instant when `start === end`) in a lane. Times are milliseconds on any one clock. */
export interface TimelineItem {
  id: string;
  laneId: string;
  start: number;
  /** `null`: still running; it grows to `now`. */
  end: number | null;
  status: TimelineStatus;
  /** The item's name for assistive technology, and the text drawn when there is no caption. */
  label: string;
  /** The mark; `bar` when absent. */
  shape?: TimelineShape | undefined;
  /** The text drawn with the item: inside a bar when it fits, else after it ("1.67 s", "Failed · 11.8 s"). */
  caption?: string | undefined;
}

/** The visible stretch of time. */
export interface TimelineRange {
  start: number;
  end: number;
}

/** No variant props: a bar's look comes from its item's status and shape. */
export const timelineVariants = {} as const;

/** The fill of a bar by status (an item field, not a prop of the component). */
export const timelineStatusClasses = {
  running: "border border-accent-solid bg-accent-subtle text-fg",
  success: "bg-success text-success-solid-fg",
  danger: "bg-danger text-danger-solid-fg",
  warning: "bg-warning text-warning-solid-fg",
  info: "bg-info text-info-solid-fg",
  neutral: "bg-neutral-solid text-neutral-solid-fg",
} as const;

/** The colour of an instant's mark by status (ticks, diamonds and pins carry no text). */
const markClasses = {
  running: "bg-accent-solid border-accent-solid",
  success: "bg-success border-success",
  danger: "bg-danger border-danger",
  warning: "bg-warning border-warning",
  info: "bg-info border-info",
  neutral: "bg-fg-muted border-fg-muted",
} as const;

/** The stripes of a hatched bar: thin warning strokes on the warning tint. */
const HATCH: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, var(--by-color-status-warning-bg) 0 5px, var(--by-color-status-warning-border) 5px 6px)",
};

const classes = {
  root: ["flex min-h-0 flex-col font-sans text-body-1 text-fg", focusRing],
  toolbar: "flex shrink-0 flex-wrap items-center gap-inline-md border-b border-border-subtle px-inset-lg py-stack-sm",
  zoom: "flex items-center",
  /** One part of the Fit and zoom track: the parts draw the track's edge, a divider before each. */
  zoomPart: "inline-flex h-control-sm items-center justify-center gap-inline-xs border-y border-s border-border bg-layer bg-clip-padding px-inline-md text-caption-1 text-fg first:rounded-s-md last:rounded-e-md last:border-e focus-visible:relative",
  zoomButton: "cursor-default select-none hover:bg-hover active:bg-pressed",
  zoomLabel: "bg-pressed text-caption-1-strong",
  divider: "my-inline-xs self-stretch border-s border-border-subtle",
  overview: "flex shrink-0 items-center py-stack-sm",
  overviewTrack: "relative h-control-xs min-w-0 flex-1 cursor-pointer touch-none",
  overviewBand: "absolute inset-x-0 top-1/2 h-inline-md -translate-y-1/2 rounded-sm bg-accent-subtle",
  overviewMark: "absolute top-1/2 h-inline-lg w-0 -translate-y-1/2 border-s border-accent-solid",
  overviewWindow: "absolute inset-y-0 cursor-grab rounded-sm border-2 border-accent-solid bg-accent-subtle/40 active:cursor-grabbing",
  axis: "flex shrink-0 border-b border-border-subtle text-caption-1 text-fg-muted",
  gutter: "flex w-panel-xs shrink-0 items-center gap-inline-sm truncate px-inset-sm text-caption-1 text-fg-muted",
  lanes: "relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain",
  lane: "flex items-center data-selected:bg-hover",
  laneLabel: "flex w-panel-xs shrink-0 items-center gap-inline-sm px-inset-sm text-caption-1 text-fg [&_svg]:size-icon-md [&_svg]:shrink-0 [&_svg]:text-fg-muted",
  track: "relative h-full min-w-0 flex-1 overflow-hidden",
  tick: "absolute inset-y-0 whitespace-nowrap border-s border-border-subtle ps-inline-xs pt-stack-xs text-caption-1 text-fg-muted",
  grid: "absolute inset-y-0 border-s border-border-subtle",
  bar: [
    "absolute top-1/2 h-control-xs -translate-y-1/2 cursor-default overflow-hidden rounded-sm text-start text-caption-1",
    "hover:opacity-90 data-selected:outline-solid data-selected:outline-[length:var(--by-ring-width)] data-selected:outline-ring",
    focusRing,
  ],
  mark: [
    "absolute top-1/2 flex h-control-xs w-inline-lg -translate-x-1/2 -translate-y-1/2 cursor-default items-center justify-center rounded-sm",
    "data-selected:outline-solid data-selected:outline-[length:var(--by-ring-width)] data-selected:outline-ring",
    focusRing,
  ],
  caption: "pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap ps-inline-sm text-caption-1 text-fg-muted",
  edge: "pointer-events-none absolute top-1/2 -translate-y-1/2 text-caption-1 text-fg-muted",
  now: "absolute inset-y-0 w-px bg-accent-compound",
  empty: "p-inset-md text-body-1 text-fg-muted",
  /** The chart (overview, axis, lanes) and the pane beside it, under the toolbar. */
  body: "flex min-h-0 flex-1",
  chart: "flex min-h-0 min-w-0 flex-1 flex-col",
  aside: "flex w-panel-pane max-w-1/2 min-h-0 min-w-0 shrink-0 flex-col overflow-auto border-s border-border-subtle",
};

/** Time to fit every item, with a little room on both sides; `now` closes the running ones. */
export function fitRange(items: readonly TimelineItem[], now: number): TimelineRange {
  if (items.length === 0) return { start: now - 1000, end: now };
  let start = Infinity;
  let end = -Infinity;
  for (const item of items) {
    start = Math.min(start, item.start);
    end = Math.max(end, item.end ?? now);
  }
  const span = Math.max(end - start, 1);
  const pad = span * 0.03;
  return { start: start - pad, end: end + pad };
}

/** Zooms by `factor` (above 1 shows more time) around `anchor`, a 0 to 1 position in the range. */
export function zoomRange(range: TimelineRange, factor: number, anchor = 0.5): TimelineRange {
  const span = range.end - range.start;
  const next = Math.max(span * factor, 1);
  const at = range.start + span * anchor;
  return { start: at - next * anchor, end: at + next * (1 - anchor) };
}

/** Moves the range by `fraction` of its width (negative: earlier). */
export function panRange(range: TimelineRange, fraction: number): TimelineRange {
  const shift = (range.end - range.start) * fraction;
  return { start: range.start + shift, end: range.end + shift };
}

const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000];

/** The tick step for a range: the round step (1, 2, 5 times a power of ten ms, then seconds, minutes, hours) giving about `count` ticks. */
export function tickStep(range: TimelineRange, count = 6): number {
  const rough = (range.end - range.start) / Math.max(count, 1);
  return STEPS.find((s) => s >= rough) ?? Math.ceil(rough / 86_400_000) * 86_400_000;
}

/** Round tick times inside `range`, about `count` of them. */
export function niceTicks(range: TimelineRange, count = 6): number[] {
  const span = range.end - range.start;
  if (!(span > 0)) return [];
  const step = tickStep(range, count);
  const ticks: number[] = [];
  for (let t = Math.ceil(range.start / step) * step; t <= range.end; t += step) ticks.push(t);
  return ticks;
}

/** "0", "850 ms", "2.5 s", "3m 20s", "1h 5m": an offset from the timeline's origin. */
export function formatOffset(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  if (abs < 0.5) return "0";
  if (abs < 1000) return `${sign}${Math.round(abs)} ms`;
  if (abs < 60_000) return `${sign}${Number((abs / 1000).toFixed(1))} s`;
  if (abs < 3_600_000) {
    const seconds = Math.round((abs % 60_000) / 1000);
    return `${sign}${Math.floor(abs / 60_000)}m${seconds > 0 ? ` ${seconds}s` : ""}`;
  }
  const minutes = Math.round((abs % 3_600_000) / 60_000);
  return `${sign}${Math.floor(abs / 3_600_000)}h${minutes > 0 ? ` ${minutes}m` : ""}`;
}

/** The width of a view in one rounded unit, for the zoom control: "800 ms", "45 s", "2 min", "1.5 h", "3 d". */
export function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Number((ms / 1000).toPrecision(2))} s`;
  if (ms < 3_600_000) return `${Number((ms / 60_000).toPrecision(2))} min`;
  if (ms < 86_400_000) return `${Number((ms / 3_600_000).toPrecision(2))} h`;
  return `${Number((ms / 86_400_000).toPrecision(2))} d`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A clock time for the axis, local: "10:42:20", "10:42:20.250" under a second, "10:40" from an hour, the date added from a day. */
export function formatClock(t: number, step = 1000): string {
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (step >= 86_400_000) return `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
  if (step >= 3_600_000) return hm;
  const hms = `${hm}:${pad2(d.getSeconds())}`;
  return step < 1000 ? `${hms}.${String(d.getMilliseconds()).padStart(3, "0")}` : hms;
}

export interface TimelineProps {
  /** Names the timeline for assistive technology: "History timeline of order-1". */
  "aria-label": string;
  /** The rows, top to bottom; none when absent. */
  lanes?: readonly TimelineLane[] | undefined;
  /** The spans; none when absent. */
  items?: readonly TimelineItem[] | undefined;
  /** The current time on the items' clock: running items grow to it, and a marker shows it. 0 when absent. */
  now?: number | undefined;
  /** The selected item (its mark is ringed and its lane tinted). */
  selectedId?: string | null | undefined;
  /** Called when a mark is pressed (click, Enter or Space). */
  onSelect?: ((id: string) => void) | undefined;
  /** Where "since start" counts from: the earliest start when absent. */
  origin?: number | undefined;
  /** How a mark is described to a screen reader; "label, status, duration" when absent. */
  describeItem?: ((item: TimelineItem, end: number) => string) | undefined;
  /** Shown when there are no lanes. */
  emptyLabel?: string | undefined;
  /** What the axis reads first: offsets from the origin ("offset", the default) or clock times. The toolbar switches it. */
  defaultAxis?: TimelineAxis | undefined;
  /** The axis's clock times; `formatClock` (local time) when absent. Items' times must be epoch ms for it to mean anything. */
  formatTime?: ((t: number, step: number) => string) | undefined;
  /** The toolbar (Fit, zoom, the axis switch) and the overview strip; on by default. */
  controls?: boolean | undefined;
  /** More of the toolbar, after the built-in controls: filters, a follow switch. */
  toolbar?: ReactNode;
  /** The overview strip's name for the whole range: "Whole run". */
  overviewLabel?: string | undefined;
  /** Keep `now` in view while zoomed in: the view slides with the clock. */
  follow?: boolean | undefined;
  /** Called with `false` when the person pans away from now (keys, wheel, the overview), so the app can offer "Jump to now". */
  onFollowChange?: ((follow: boolean) => void) | undefined;
  /**
   * A pane beside the chart, under the toolbar: the selected item's details (times, failure, its
   * events). The chart's keys and wheel leave it alone. None when absent.
   */
  aside?: ReactNode;
  /** The pane's name for assistive technology (it is a `complementary` region): "Selected item". */
  asideLabel?: string | undefined;
  /** Extra classes, merged after the component's own so they win. */
  className?: string | undefined;
}

const NO_LANES: readonly TimelineLane[] = [];
const NO_ITEMS: readonly TimelineItem[] = [];

/** How many lanes are drawn beyond the ones in view, above and below. */
const OVERSCAN = 6;
/** Lanes drawn when the scroll area has no size yet (first render, jsdom). */
const FALLBACK_LANES = 60;
/** A lane's height in px (the lanes are windowed by it). */
const ROW = 36;
/** The label gutter's width in px (size.panel.xs), to measure the track. */
const GUTTER = 240;
/** About how wide a caption-1 character is, to tell whether a caption fits inside its bar. */
const CHAR_PX = 6.5;
/** Overview marks drawn at most (the rest are skipped evenly). */
const OVERVIEW_MARKS = 400;
const SPANS: ReadonlySet<TimelineShape> = new Set(["bar", "hatched", "dashed"]);

/**
 * Spans and instants over time in lanes, for a workflow's history: the workflow, its activities,
 * timers, child workflows, signals and markers. Pure DOM, bars positioned by percentage of the
 * visible range. A toolbar fits, zooms and switches the axis between clock time and time since the
 * start; an overview strip shows the whole range with the visible window, which drags to pan.
 * Keys: + and - zoom (or Ctrl+wheel), the arrows pan (or Shift+wheel), Home fits. Lanes are
 * windowed, so thousands stay cheap. Running items grow to `now`; with `follow` the view keeps it in sight.
 */
export function Timeline({
  "aria-label": ariaLabel,
  lanes = NO_LANES,
  items = NO_ITEMS,
  now = 0,
  selectedId,
  onSelect,
  origin,
  describeItem,
  emptyLabel = "Nothing to show",
  defaultAxis = "offset",
  formatTime = formatClock,
  controls = true,
  toolbar,
  overviewLabel = "Whole range",
  follow = false,
  onFollowChange,
  aside,
  asideLabel = "Selected item",
  className,
}: TimelineProps) {
  const [range, setRange] = useState<TimelineRange | null>(null);
  const [axis, setAxis] = useState<TimelineAxis>(defaultAxis);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [trackPx, setTrackPx] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; range: TimelineRange } | null>(null);
  const hintId = useId();
  const fitted = useMemo(() => fitRange(items, now), [items, now]);
  const running = useMemo(() => items.some((i) => i.end === null), [items]);
  const first0 = useMemo(() => (items.length > 0 ? Math.min(...items.map((i) => i.start)) : fitted.start), [items, fitted.start]);
  const zero = origin ?? first0;

  // Following slides a zoomed view so now sits near its right edge; the fitted view holds now already.
  let view = range ?? fitted;
  if (range && follow && running) {
    const span = range.end - range.start;
    view = { start: now - span * 0.92, end: now + span * 0.08 };
  }
  const span = view.end - view.start;

  const byLane = useMemo(() => {
    const map = new Map<string, TimelineItem[]>();
    for (const item of items) {
      const list = map.get(item.laneId);
      if (list) list.push(item);
      else map.set(item.laneId, [item]);
    }
    return map;
  }, [items]);

  const selectedLane = useMemo(() => (selectedId ? items.find((i) => i.id === selectedId)?.laneId : undefined), [items, selectedId]);
  const percent = useCallback((t: number) => ((t - view.start) / span) * 100, [view.start, span]);

  const zoom = (factor: number) => setRange(zoomRange(view, factor, follow && running ? 0.92 : 0.5));
  const pan = (next: TimelineRange) => {
    setRange(next);
    if (follow) onFollowChange?.(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case "+":
      case "=":
        zoom(0.5);
        break;
      case "-":
      case "_":
        zoom(2);
        break;
      case "ArrowLeft":
        pan(panRange(view, -0.2));
        break;
      case "ArrowRight":
        pan(panRange(view, 0.2));
        break;
      case "Home":
        setRange(null);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest?.("[data-slot=timeline-aside]")) return;
    if (event.ctrlKey || event.metaKey) {
      const box = event.currentTarget.getBoundingClientRect();
      const anchor = box.width > 0 ? Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1) : 0.5;
      setRange(zoomRange(view, event.deltaY > 0 ? 1.25 : 0.8, anchor));
      event.preventDefault();
    } else if (event.shiftKey && event.deltaY !== 0) {
      pan(panRange(view, event.deltaY > 0 ? 0.1 : -0.1));
      event.preventDefault();
    }
  };

  // The overview: press to centre the view there, drag the window to pan.
  const overviewAt = (clientX: number) => {
    const box = overviewRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return fitted.start;
    return fitted.start + ((clientX - box.left) / box.width) * (fitted.end - fitted.start);
  };
  const onOverviewDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const at = overviewAt(event.clientX);
    const next = at >= view.start && at <= view.end ? view : { start: at - span / 2, end: at + span / 2 };
    if (next !== view) pan(next);
    drag.current = { x: event.clientX, range: next };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onOverviewMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    const box = overviewRef.current?.getBoundingClientRect();
    if (!from || !box || box.width === 0) return;
    const shift = ((event.clientX - from.x) / box.width) * (fitted.end - fitted.start);
    pan({ start: from.range.start + shift, end: from.range.end + shift });
  };
  const onOverviewUp = () => {
    drag.current = null;
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = viewport > 0 ? Math.min(lanes.length, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN) : Math.min(lanes.length, FALLBACK_LANES);
  // Round numbers of what the axis shows: the clock's, or the offset's (0, 5 s, 10 s).
  const step = tickStep(view);
  const ticks = axis === "clock" ? niceTicks(view) : niceTicks({ start: view.start - zero, end: view.end - zero }).map((t) => t + zero);
  const tickLabel = (t: number) => (axis === "clock" ? formatTime(t, step) : formatOffset(t - zero));
  const nowAt = percent(now);

  const describe = describeItem ?? ((item: TimelineItem, end: number) => `${item.label}, ${item.status}, ${formatOffset(end - item.start)}`);
  const extentEnd = items.length > 0 ? Math.max(...items.map((i) => i.end ?? now)) : now;
  const overviewMarks = items.length <= OVERVIEW_MARKS ? items : items.filter((_, i) => i % Math.ceil(items.length / OVERVIEW_MARKS) === 0);
  const fitSpan = fitted.end - fitted.start;
  const windowLeft = Math.max(0, ((view.start - fitted.start) / fitSpan) * 100);
  const windowRight = Math.min(100, ((view.end - fitted.start) / fitSpan) * 100);

  const lanesRef = (el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    if (el.clientHeight !== viewport) setViewport(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(() => {
      setViewport(el.clientHeight);
      setTrackPx(Math.max(el.clientWidth - GUTTER, 0));
    });
    observer.current.observe(el);
  };

  const renderItem = (item: TimelineItem) => {
    const shape = item.shape ?? "bar";
    const end = item.end ?? now;
    const rawLeft = percent(item.start);
    const rawRight = percent(end);
    const selected = selectedId === item.id;
    const common = {
      type: "button" as const,
      "data-slot": "timeline-item",
      "data-status": item.status,
      "data-shape": shape,
      "data-selected": selected ? "" : undefined,
      "data-running": item.end === null ? "" : undefined,
      "aria-label": describe(item, end),
      "aria-pressed": selectedId === undefined ? undefined : selected,
      title: describe(item, end),
      onClick: () => onSelect?.(item.id),
    };
    const text = item.caption ?? item.label;
    if (!SPANS.has(shape)) {
      if (rawLeft < -1 || rawLeft > 101) return null;
      return (
        <span key={item.id}>
          <button {...common} style={{ left: `${rawLeft}%` }} className={cn(classes.mark)}>
            {shape === "tick" ? (
              <span className={cn("h-full w-0 border-s-2", markClasses[item.status])} />
            ) : shape === "diamond" ? (
              <span className={cn("size-inline-lg rotate-45 rounded-xs", markClasses[item.status])} />
            ) : (
              <span className="flex h-full flex-col items-center">
                <span className={cn("size-inline-md shrink-0 rounded-full", markClasses[item.status])} />
                <span className={cn("w-0 flex-1 border-s-2", markClasses[item.status])} />
              </span>
            )}
          </button>
          {item.caption ? (
            <span aria-hidden="true" className={cn(classes.caption)} style={{ left: `calc(${rawLeft}% + var(--by-space-inline-md))` }}>
              {item.caption}
            </span>
          ) : null}
        </span>
      );
    }
    if (rawLeft > 100 || rawRight < 0) return null;
    const left = Math.max(rawLeft, 0);
    const right = Math.min(rawRight, 100);
    const width = Math.max(right - left, 0);
    // Inside when it fits (or when the track has no measured size: first render, tests); after it otherwise.
    const inside = trackPx === 0 || (width / 100) * trackPx >= text.length * CHAR_PX + 12;
    const look = shape === "hatched" ? "border border-warning-border text-fg" : shape === "dashed" ? "border border-dashed border-border-strong bg-transparent text-fg-muted" : timelineStatusClasses[item.status];
    const goesOn = item.end === null || rawRight > 100;
    return (
      <span key={item.id}>
        <button {...common} style={{ left: `${left}%`, width: `${width}%`, ...(shape === "hatched" ? HATCH : null) }} className={cn(classes.bar, look, "min-w-inline-sm")}>
          {inside ? <span className="block truncate px-inline-sm">{text}</span> : null}
        </button>
        {goesOn ? (
          <span aria-hidden="true" data-slot="timeline-edge" className={cn(classes.edge, right >= 99 ? "right-0" : null)} style={right >= 99 ? undefined : { left: `${right}%` }}>
            ▸
          </span>
        ) : null}
        {!inside && text ? (
          <span aria-hidden="true" className={cn(classes.caption, goesOn && "ps-inline-lg")} style={{ left: `${right}%` }}>
            {text}
          </span>
        ) : null}
        {rawLeft < 0 ? (
          <span aria-hidden="true" data-slot="timeline-edge" className={cn(classes.edge, "left-0")}>
            ◂
          </span>
        ) : null}
      </span>
    );
  };

  return (
    <div role="group" aria-label={ariaLabel} aria-describedby={hintId} tabIndex={0} data-slot="timeline" onKeyDown={onKeyDown} onWheel={onWheel} className={cn(classes.root, className)}>
      <span id={hintId} className="sr-only">
        Plus and minus zoom, left and right arrows pan, Home fits everything.
      </span>
      {controls ? (
        <div data-slot="timeline-toolbar" className={cn(classes.toolbar)}>
          <div role="group" aria-label="Zoom" className={cn(classes.zoom)}>
            <Tooltip>
              <TooltipTrigger render={<button type="button" aria-keyshortcuts="Home" className={cn(classes.zoomPart, classes.zoomButton, focusRing)} onClick={() => setRange(null)} />}>Fit</TooltipTrigger>
              <TooltipContent>
                Fit everything <TooltipShortcut>Home</TooltipShortcut>
              </TooltipContent>
            </Tooltip>
            <button type="button" aria-label="Zoom out" className={cn(classes.zoomPart, classes.zoomButton, focusRing)} onClick={() => zoom(2)}>
              <span aria-hidden="true">−</span>
            </button>
            <span aria-live="polite" data-slot="timeline-zoom-label" className={cn(classes.zoomPart, classes.zoomLabel)}>
              {formatSpan(span)}
            </span>
            <button type="button" aria-label="Zoom in" className={cn(classes.zoomPart, classes.zoomButton, focusRing)} onClick={() => zoom(0.5)}>
              <span aria-hidden="true">+</span>
            </button>
          </div>
          <ToggleGroup aria-label="Axis" size="small" value={[axis]} onValueChange={(v) => v[0] && setAxis(v[0] as TimelineAxis)}>
            <ToggleGroupItem value="clock">Clock</ToggleGroupItem>
            <ToggleGroupItem value="offset">Since start</ToggleGroupItem>
          </ToggleGroup>
          {toolbar ? <span aria-hidden="true" className={cn(classes.divider)} /> : null}
          {toolbar}
        </div>
      ) : null}
      <div data-slot="timeline-body" className={cn(classes.body)}>
        <div data-slot="timeline-chart" className={cn(classes.chart)}>
          {controls && items.length > 0 ? (
            <div data-slot="timeline-overview" className={cn(classes.overview)}>
              <div className={cn(classes.gutter)}>
                {overviewLabel} · {formatOffset(extentEnd - first0)}
              </div>
              <div ref={overviewRef} aria-hidden="true" onPointerDown={onOverviewDown} onPointerMove={onOverviewMove} onPointerUp={onOverviewUp} onPointerCancel={onOverviewUp} className={cn(classes.overviewTrack)}>
                <span className={cn(classes.overviewBand)} />
                {overviewMarks.map((item) => (
                  <span key={item.id} className={cn(classes.overviewMark)} style={{ left: `${((item.start - fitted.start) / fitSpan) * 100}%` }} />
                ))}
                <span data-slot="timeline-window" className={cn(classes.overviewWindow)} style={{ left: `${windowLeft}%`, width: `${Math.max(windowRight - windowLeft, 0.5)}%` }} />
                {running ? <span className="absolute right-0 top-1/2 -translate-y-1/2 pe-inline-sm text-caption-1 text-fg-muted">now {formatTime(now, 1000)}</span> : null}
              </div>
            </div>
          ) : null}
          <div data-slot="timeline-axis" aria-hidden="true" className={cn(classes.axis)}>
            <div className={cn(classes.gutter)} />
            <div className="relative h-control-sm min-w-0 flex-1 overflow-hidden">
              {ticks.map((t) => (
                <span key={t} className={cn(classes.tick)} style={{ left: `${percent(t)}%` }}>
                  {tickLabel(t)}
                </span>
              ))}
            </div>
          </div>
          {lanes.length === 0 ? (
            <p className={cn(classes.empty)}>{emptyLabel}</p>
          ) : (
            <div ref={lanesRef} data-slot="timeline-lanes" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className={cn(classes.lanes)}>
              <div style={{ height: lanes.length * ROW }} className="relative">
                {lanes.slice(first, last).map((lane, i) => (
                  <div
                    key={lane.id}
                    data-slot="timeline-lane"
                    data-selected={selectedLane === lane.id ? "" : undefined}
                    style={{ position: "absolute", top: (first + i) * ROW, left: 0, right: 0, height: ROW }}
                    className={cn(classes.lane)}
                  >
                    <div className={cn(classes.laneLabel)} title={lane.detail ? `${lane.label} · ${lane.detail}` : lane.label}>
                      {lane.icon}
                      <span className="min-w-0 flex-1 truncate">{lane.label}</span>
                      {lane.detail ? <span className="shrink-0 text-fg-muted">{lane.detail}</span> : null}
                    </div>
                    <div className={cn(classes.track)}>
                      {ticks.map((t) => (
                        <span key={t} aria-hidden="true" className={cn(classes.grid)} style={{ left: `${percent(t)}%` }} />
                      ))}
                      {(byLane.get(lane.id) ?? []).map(renderItem)}
                      {nowAt >= 0 && nowAt <= 100 ? <span aria-hidden="true" data-slot="timeline-now" className={cn(classes.now)} style={{ left: `${nowAt}%` }} /> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {aside === undefined || aside === null ? null : (
          <aside data-slot="timeline-aside" aria-label={asideLabel} className={cn(classes.aside)}>
            {aside}
          </aside>
        )}
      </div>
    </div>
  );
}
