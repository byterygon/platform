import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";

/** How an item is drawn: its status colour. `running` is an item that has no end yet. */
export type TimelineStatus = "running" | "success" | "danger" | "warning" | "info" | "neutral";

/** A lane: one row of the timeline (a workflow, an activity type, a timer, a child workflow). */
export interface TimelineLane {
  id: string;
  label: string;
}

/** A span (or an instant when `start === end`) in a lane. Times are milliseconds on any one clock. */
export interface TimelineItem {
  id: string;
  laneId: string;
  start: number;
  /** `null`: still running; it grows to `now`. */
  end: number | null;
  status: TimelineStatus;
  label: string;
}

/** The visible stretch of time. */
export interface TimelineRange {
  start: number;
  end: number;
}

/** No variant props: a bar's fill comes from its item's status. */
export const timelineVariants = {} as const;

/** The fill of a bar by status (an item field, not a prop of the component). */
export const timelineStatusClasses = {
  running: "bg-accent-solid text-accent-solid-fg",
  success: "bg-success text-success-solid-fg",
  danger: "bg-danger text-danger-solid-fg",
  warning: "bg-warning text-warning-solid-fg",
  info: "bg-info text-info-solid-fg",
  neutral: "bg-neutral-solid text-neutral-solid-fg",
} as const;

const classes = {
  root: ["flex min-h-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-layer font-sans text-body-1 text-fg", focusRing],
  axis: "flex shrink-0 border-b border-border-subtle bg-grid-header text-caption-1 text-fg-muted",
  gutter: "w-panel-xs shrink-0 truncate px-inset-sm",
  lanes: "relative min-h-0 flex-1 overflow-auto overscroll-contain",
  lane: "flex h-control-md items-center border-b border-border-subtle",
  laneLabel: "w-panel-xs shrink-0 truncate px-inset-sm text-caption-1 text-fg-muted",
  track: "relative h-full min-w-0 flex-1",
  tick: "absolute inset-y-0 whitespace-nowrap border-s border-border-subtle ps-inline-xs text-caption-1 text-fg-muted",
  bar: [
    "absolute inset-y-inline-xs min-w-inline-sm cursor-default overflow-hidden rounded-sm text-start text-caption-1",
    "hover:opacity-90 data-selected:outline-solid data-selected:outline-[length:var(--by-ring-width)] data-selected:outline-ring",
    focusRing,
  ],
  now: "absolute inset-y-0 w-px bg-accent-compound",
  empty: "p-inset-md text-body-1 text-fg-muted",
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

/** Round tick times (1, 2, 5 times a power of ten ms, then whole seconds, minutes, hours) inside `range`, about `count` of them. */
export function niceTicks(range: TimelineRange, count = 6): number[] {
  const span = range.end - range.start;
  if (!(span > 0)) return [];
  const rough = span / Math.max(count, 1);
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000];
  const step = steps.find((s) => s >= rough) ?? Math.ceil(rough / 86_400_000) * 86_400_000;
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

export interface TimelineProps {
  /** Names the timeline for assistive technology: "History timeline of order-1". */
  "aria-label": string;
  /** The rows, top to bottom; none when absent. */
  lanes?: readonly TimelineLane[] | undefined;
  /** The spans; none when absent. */
  items?: readonly TimelineItem[] | undefined;
  /** The current time on the items' clock: running items grow to it, and a marker shows it. 0 when absent. */
  now?: number | undefined;
  /** The selected item (its bar is ringed). */
  selectedId?: string | null | undefined;
  /** Called when a bar is pressed (click, Enter or Space). */
  onSelect?: ((id: string) => void) | undefined;
  /** Where the axis starts counting: the earliest start when absent. Ticks read as offsets from it. */
  origin?: number | undefined;
  /** How a bar is described to a screen reader; "label, status, duration" when absent. */
  describeItem?: ((item: TimelineItem, end: number) => string) | undefined;
  /** Shown when there are no lanes. */
  emptyLabel?: string | undefined;
  /** Extra classes, merged after the component's own so they win. */
  className?: string | undefined;
}

const NO_LANES: readonly TimelineLane[] = [];
const NO_ITEMS: readonly TimelineItem[] = [];

/** How many lanes are drawn beyond the ones in view, above and below. */
const OVERSCAN = 6;
/** Lanes drawn when the scroll area has no size yet (first render, jsdom). */
const FALLBACK_LANES = 60;

/**
 * Spans over time in lanes, for a workflow's history: the workflow, its activities, timers, child
 * workflows and signals. Pure DOM: bars are positioned by percentage of the visible range. Zoom
 * with + and - (or Ctrl+wheel), pan with the arrow keys (or Shift+wheel), Home fits everything;
 * lanes are windowed, so thousands of them stay cheap. Running items grow to `now`.
 */
export function Timeline({ "aria-label": ariaLabel, lanes = NO_LANES, items = NO_ITEMS, now = 0, selectedId, onSelect, origin, describeItem, emptyLabel = "Nothing to show", className }: TimelineProps) {
  const [range, setRange] = useState<TimelineRange | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const lanesRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const fitted = useMemo(() => fitRange(items, now), [items, now]);
  const view = range ?? fitted;
  const span = view.end - view.start;
  const zero = origin ?? (items.length > 0 ? Math.min(...items.map((i) => i.start)) : view.start);

  const byLane = useMemo(() => {
    const map = new Map<string, TimelineItem[]>();
    for (const item of items) {
      const list = map.get(item.laneId);
      if (list) list.push(item);
      else map.set(item.laneId, [item]);
    }
    return map;
  }, [items]);

  const percent = useCallback((t: number) => ((t - view.start) / span) * 100, [view.start, span]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case "+":
      case "=":
        setRange(zoomRange(view, 0.5));
        break;
      case "-":
      case "_":
        setRange(zoomRange(view, 2));
        break;
      case "ArrowLeft":
        setRange(panRange(view, -0.2));
        break;
      case "ArrowRight":
        setRange(panRange(view, 0.2));
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
    if (event.ctrlKey || event.metaKey) {
      const box = event.currentTarget.getBoundingClientRect();
      const anchor = box.width > 0 ? Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1) : 0.5;
      setRange(zoomRange(view, event.deltaY > 0 ? 1.25 : 0.8, anchor));
      event.preventDefault();
    } else if (event.shiftKey && event.deltaY !== 0) {
      setRange(panRange(view, event.deltaY > 0 ? 0.1 : -0.1));
      event.preventDefault();
    }
  };

  const rowHeight = 36;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = viewport > 0 ? Math.min(lanes.length, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN) : Math.min(lanes.length, FALLBACK_LANES);
  // Round numbers of the offset the axis shows (0, 5 s, 10 s), not of the clock.
  const ticks = niceTicks({ start: view.start - zero, end: view.end - zero }).map((t) => t + zero);
  const nowAt = percent(now);

  const describe = describeItem ?? ((item: TimelineItem, end: number) => `${item.label}, ${item.status}, ${formatOffset(end - item.start)}`);

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-describedby={hintId}
      tabIndex={0}
      data-slot="timeline"
      onKeyDown={onKeyDown}
      onWheel={onWheel}
      className={cn(classes.root, className)}
    >
      <span id={hintId} className="sr-only">
        Plus and minus zoom, left and right arrows pan, Home fits everything.
      </span>
      <div data-slot="timeline-axis" aria-hidden="true" className={cn(classes.axis)}>
        <div className={cn(classes.gutter)} />
        <div className="relative h-control-sm min-w-0 flex-1">
          {ticks.map((t) => (
            <span key={t} className={cn(classes.tick)} style={{ left: `${percent(t)}%` }}>
              {formatOffset(t - zero)}
            </span>
          ))}
        </div>
      </div>
      {lanes.length === 0 ? (
        <p className={cn(classes.empty)}>{emptyLabel}</p>
      ) : (
        <div
          ref={(el) => {
            lanesRef.current = el;
            if (el && el.clientHeight !== viewport) setViewport(el.clientHeight);
          }}
          data-slot="timeline-lanes"
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          className={cn(classes.lanes)}
        >
          <div style={{ height: lanes.length * rowHeight }} className="relative">
            {lanes.slice(first, last).map((lane, i) => (
              <div key={lane.id} data-slot="timeline-lane" style={{ position: "absolute", top: (first + i) * rowHeight, left: 0, right: 0, height: rowHeight }} className={cn(classes.lane)}>
                <div className={cn(classes.laneLabel)} title={lane.label}>
                  {lane.label}
                </div>
                <div className={cn(classes.track)}>
                  {ticks.map((t) => (
                    <span key={t} aria-hidden="true" className="absolute inset-y-0 border-s border-border-subtle opacity-50" style={{ left: `${percent(t)}%` }} />
                  ))}
                  {(byLane.get(lane.id) ?? []).map((item) => {
                    const end = item.end ?? now;
                    const left = percent(item.start);
                    const width = Math.max(percent(end) - left, 0);
                    if (left > 100 || left + width < 0) return null;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-slot="timeline-item"
                        data-status={item.status}
                        data-selected={selectedId === item.id ? "" : undefined}
                        data-running={item.end === null ? "" : undefined}
                        aria-label={describe(item, end)}
                        aria-pressed={selectedId === undefined ? undefined : selectedId === item.id}
                        title={describe(item, end)}
                        onClick={() => onSelect?.(item.id)}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        className={cn(classes.bar, timelineStatusClasses[item.status])}
                      >
                        <span className="block truncate px-inline-xs">{item.label}</span>
                      </button>
                    );
                  })}
                  {nowAt >= 0 && nowAt <= 100 ? <span aria-hidden="true" data-slot="timeline-now" className={cn(classes.now)} style={{ left: `${nowAt}%` }} /> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
