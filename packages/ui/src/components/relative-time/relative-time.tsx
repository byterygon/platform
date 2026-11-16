import { useEffect, useState, type Ref } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/tooltip/tooltip";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";

// A time relative to now ("in 14 min", "2 s ago") in a <time datetime>, kept current while it is
// on screen, with the absolute time in a Tooltip and as hidden text for screen readers (a
// grant's expiry, "last run 3 min ago" in the status line). Formatting is the browser's own
// Intl.RelativeTimeFormat and Intl.DateTimeFormat, so it needs no locale data download. It
// re-renders every second while the time is within a minute, every 15 s within an hour, then
// every minute. It is not a live region: a countdown that announced itself would never stop.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const relativeTimeVariants = {} as const;

const classes = {
  root: [
    "whitespace-nowrap rounded-md tabular-nums",
    "data-tooltip:underline data-tooltip:decoration-fg-subtle data-tooltip:decoration-dotted data-tooltip:underline-offset-4",
    focusRing,
  ],
  hidden: "sr-only",
} as const;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

const toDate = (value: Date | string | number) => (value instanceof Date ? value : new Date(value));

/** "in 14 min", "2 s ago", "yesterday": the largest unit that fits, rounded. */
export function formatRelative(date: Date | string | number, now: number, locale?: string, style: Intl.RelativeTimeFormatStyle = "short"): string {
  const seconds = (toDate(date).getTime() - now) / 1000;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === "second") return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "second");
}

/** How long until the text may change: 1 s within a minute, 15 s within an hour, then a minute. */
export function refreshInterval(date: Date | string | number, now: number): number {
  const distance = Math.abs(toDate(date).getTime() - now);
  return distance < 60_000 ? 1000 : distance < 3_600_000 ? 15_000 : 60_000;
}

export interface RelativeTimeProps {
  /** The moment: a Date, an ISO string or epoch milliseconds. */
  date: Date | string | number;
  /** Freeze "now" (tests, previews); otherwise the clock, kept current. */
  now?: number;
  /** Keep the text current while mounted (default true). */
  live?: boolean;
  /** The BCP 47 locale; the user's own by default. */
  locale?: string;
  /** long ("in 14 minutes"), short ("in 14 min") or narrow ("in 14m"). */
  style?: Intl.RelativeTimeFormatStyle;
  /** Time zone of the absolute time ("UTC"); the user's own by default. */
  timeZone?: string;
  /** Show the absolute time in a Tooltip on hover and focus (the time becomes focusable). */
  tooltip?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
  /** Reaches the `<time>`. */
  ref?: Ref<HTMLTimeElement>;
}

/** A relative time in a `<time datetime>`, with the absolute time in a Tooltip and as hidden text. */
export function RelativeTime({ date, now: fixedNow, live = true, locale, style = "short", timeZone, tooltip = true, className, ref }: RelativeTimeProps) {
  const [clock, setClock] = useState(() => Date.now());
  const now = fixedNow ?? clock;
  const moment = toDate(date);
  const valid = !Number.isNaN(moment.getTime());

  useEffect(() => {
    if (!live || fixedNow !== undefined || !valid) return undefined;
    const timer = setTimeout(() => setClock(Date.now()), refreshInterval(moment, clock));
    return () => clearTimeout(timer);
  }, [live, fixedNow, valid, moment.getTime(), clock]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!valid) {
    return (
      <time ref={ref} data-slot="relative-time" className={cn(classes.root, className)}>
        —
      </time>
    );
  }

  const relative = formatRelative(moment, now, locale, style);
  const absolute = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
    timeZoneName: timeZone ? "short" : undefined,
  }).format(moment);
  const element = (
    <time
      ref={ref}
      data-slot="relative-time"
      data-tooltip={tooltip ? "" : undefined}
      dateTime={moment.toISOString()}
      tabIndex={tooltip ? 0 : undefined}
      className={cn(classes.root, className)}
    >
      {relative}
      <span className={classes.hidden}>{`, ${absolute}`}</span>
    </time>
  );
  if (!tooltip) return element;
  return (
    <Tooltip>
      <TooltipTrigger render={element} />
      <TooltipContent>{absolute}</TooltipContent>
    </Tooltip>
  );
}
