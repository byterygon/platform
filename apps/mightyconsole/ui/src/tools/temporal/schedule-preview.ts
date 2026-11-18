// The next runs of a schedule, computed in the browser while the sheet is filled (Mightyconsole
// spec §9.3 "Create or edit schedule", TSK-92). Pure: the sheet shows them as "computed in the
// browser"; the server's own times show on the schedule once it is saved.
//
// - Calendars use Temporal's calendar strings: `*`, `n`, `a-b`, `a-b/s`, `*/s`, `n/s` and lists of
//   those, month and weekday names by their first three letters. An absent second, minute or
//   hour is 0; an absent day of month, month, year or day of week is every value.
// - Cron strings are Temporal's: 5 fields (minute to day of week), 6 (and year) or 7 (second
//   first, then year), `@yearly`, `@monthly`, `@weekly`, `@daily`, `@hourly`, `@every d[/offset]`,
//   a leading `CRON_TZ=` or `TZ=`, a trailing `# comment`. Day of month and day of week must both
//   match (Temporal does not implement cron's "or").
// - Intervals are aligned on the Unix epoch plus their offset.
// - Wall times are turned into instants in the schedule's time zone through Intl.DateTimeFormat.
// Jitter is not applied.
import type { CalendarForm, IntervalForm } from "@/gen/api";

/** The part of a schedule spec the preview reads. */
export interface PreviewSpec {
  calendars: readonly CalendarForm[];
  intervals: readonly IntervalForm[];
  cronStrings: readonly string[];
  timezone?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}

export interface Preview {
  runs: Date[];
  /** Why a part of the spec could not be read, by where it is (`calendar 1 hour`, `cron 1`, `interval 1`, `timezone`). */
  errors: Record<string, string>;
}

// --- Durations --------------------------------------------------------------------------------

/** "30s", "1h30m", "2d", "250ms" or plain seconds, as the server reads them; null when empty. */
export function parseDuration(text: string): number | null | "invalid" {
  const t = text.trim();
  if (t === "") return null;
  if (/^\d+$/.test(t)) return Number(t) * 1000;
  const re = /(\d+)(ms|s|m|h|d)/y;
  let ms = 0;
  let at = 0;
  while (at < t.length) {
    re.lastIndex = at;
    const m = re.exec(t);
    if (!m) return "invalid";
    ms += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms"];
    at = re.lastIndex;
  }
  return ms;
}

/** Milliseconds as the server writes durations: "1h30m", "2d", "250ms", "0s". */
export function formatDurationText(ms: number): string {
  if (ms === 0) return "0s";
  let rest = ms;
  let out = "";
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000], ["ms", 1]] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) out += `${n}${unit}`;
    rest -= n * size;
  }
  return out;
}

// --- Calendar strings -------------------------------------------------------------------------

export type CalendarField = "second" | "minute" | "hour" | "dayOfMonth" | "month" | "year" | "dayOfWeek";

const BOUNDS: Record<CalendarField, [number, number]> = {
  second: [0, 59],
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  year: [1970, 2999],
  dayOfWeek: [0, 6],
};

const DEFAULTS: Record<CalendarField, string> = { second: "0", minute: "0", hour: "0", dayOfMonth: "*", month: "*", year: "*", dayOfWeek: "*" };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function valueOf(field: CalendarField, token: string): number | null {
  const t = token.trim().toLowerCase();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return field === "dayOfWeek" && n === 7 ? 0 : n;
  }
  if (t.length >= 3) {
    const names = field === "month" ? MONTHS : field === "dayOfWeek" ? DAYS : null;
    const i = names ? names.indexOf(t.slice(0, 3)) : -1;
    if (i >= 0) return field === "month" ? i + 1 : i;
  }
  return null;
}

/**
 * The values a calendar string matches, sorted, or why it cannot be read. The year has no upper
 * bound in Temporal; `*` there is every year (returned as `null`: no constraint).
 */
export function parseCalendarField(field: CalendarField, text: string | null | undefined): number[] | null | { error: string } {
  const source = (text ?? "").trim() || DEFAULTS[field];
  const [lo, hi] = BOUNDS[field];
  if (field === "year" && source === "*") return null;
  const out = new Set<number>();
  for (const part of source.split(",")) {
    const p = part.trim();
    if (p === "") return { error: "An empty item in the list." };
    const [range = "", stepText, extra] = p.split("/");
    if (extra !== undefined) return { error: `"${p}" has two steps.` };
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText.trim()) || Number(stepText) < 1) return { error: `The step of "${p}" is a whole number from 1.` };
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range.trim() === "*") {
      from = lo;
      to = hi;
    } else {
      const [a = "", b, more] = range.split("-");
      if (more !== undefined) return { error: `"${p}" is not a range.` };
      const start = valueOf(field, a);
      if (start === null) return { error: `"${a.trim()}" is not a ${label(field)}.` };
      from = start;
      if (b === undefined) to = stepText !== undefined ? hi : start;
      else {
        const end = valueOf(field, b);
        if (end === null) return { error: `"${b.trim()}" is not a ${label(field)}.` };
        to = end;
      }
    }
    if (from < lo || to > hi || (field === "year" && from < lo)) return { error: `The ${label(field)} is ${lo} to ${hi}.` };
    if (to < from) return { error: `"${p}" ends before it starts.` };
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

const label = (field: CalendarField): string =>
  ({ second: "second", minute: "minute", hour: "hour", dayOfMonth: "day of the month", month: "month", year: "year", dayOfWeek: "day of the week" })[field];

const FIELDS: readonly CalendarField[] = ["second", "minute", "hour", "dayOfMonth", "month", "year", "dayOfWeek"];

/** A calendar with each field read. */
interface Matcher {
  second: number[];
  minute: number[];
  hour: number[];
  dayOfMonth: Set<number>;
  month: Set<number>;
  year: Set<number> | null;
  dayOfWeek: Set<number>;
}

function matcherOf(calendar: CalendarForm, errors: Record<string, string>, where: string): Matcher | null {
  const parsed: Partial<Record<CalendarField, number[] | null>> = {};
  let ok = true;
  for (const field of FIELDS) {
    const r = parseCalendarField(field, calendar[field]);
    if (r !== null && !Array.isArray(r)) {
      errors[`${where} ${field}`] = r.error;
      ok = false;
    } else parsed[field] = r;
  }
  if (!ok) return null;
  return {
    second: parsed.second!,
    minute: parsed.minute!,
    hour: parsed.hour!,
    dayOfMonth: new Set(parsed.dayOfMonth!),
    month: new Set(parsed.month!),
    year: parsed.year ? new Set(parsed.year) : null,
    dayOfWeek: new Set(parsed.dayOfWeek!),
  };
}

// --- Cron strings -----------------------------------------------------------------------------

const SHORTHANDS: Record<string, CalendarForm> = {
  "@yearly": { dayOfMonth: "1", month: "1" },
  "@annually": { dayOfMonth: "1", month: "1" },
  "@monthly": { dayOfMonth: "1" },
  "@weekly": { dayOfWeek: "0" },
  "@daily": {},
  "@midnight": {},
  "@hourly": { hour: "*" },
};

/** A cron string as Temporal reads it: a calendar or an interval, and its time zone if it names one. */
export function parseCron(text: string): { calendar?: CalendarForm; interval?: IntervalForm; timezone?: string } | { error: string } {
  let rest = text.trim();
  const hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash).trim();
  let timezone: string | undefined;
  const tz = /^(?:CRON_TZ|TZ)=(\S+)\s+/.exec(rest);
  if (tz) {
    timezone = tz[1];
    rest = rest.slice(tz[0].length).trim();
  }
  const withTz = <T extends object>(v: T) => (timezone ? { ...v, timezone } : v);
  if (rest === "") return { error: "The cron string is empty." };
  const shorthand = SHORTHANDS[rest.toLowerCase()];
  if (shorthand) return withTz({ calendar: shorthand });
  const every = /^@every\s+(\S+?)(?:\/(\S+))?$/i.exec(rest);
  if (every) {
    const interval: IntervalForm = every[2] ? { every: every[1]!, offset: every[2] } : { every: every[1]! };
    return withTz({ interval });
  }
  if (rest.startsWith("@")) return { error: `"${rest}" is not a cron shorthand.` };
  const f = rest.split(/\s+/);
  let calendar: CalendarForm;
  if (f.length === 5) calendar = { minute: f[0]!, hour: f[1]!, dayOfMonth: f[2]!, month: f[3]!, dayOfWeek: f[4]! };
  else if (f.length === 6) calendar = { minute: f[0]!, hour: f[1]!, dayOfMonth: f[2]!, month: f[3]!, dayOfWeek: f[4]!, year: f[5]! };
  else if (f.length === 7) calendar = { second: f[0]!, minute: f[1]!, hour: f[2]!, dayOfMonth: f[3]!, month: f[4]!, dayOfWeek: f[5]!, year: f[6]! };
  else return { error: `A cron string has 5, 6 or 7 fields; this one has ${f.length}.` };
  // Cron's `?` is "any" for the day fields.
  for (const k of ["dayOfMonth", "dayOfWeek"] as const) if (calendar[k] === "?") calendar[k] = "*";
  return withTz({ calendar });
}

// --- Time zones -------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether the browser knows the time zone. */
export function isTimeZone(name: string): boolean {
  try {
    formatter(name);
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall time of an instant in a time zone. */
export function wallTime(ms: number, timeZone: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return { year: parts["year"]!, month: parts["month"]!, day: parts["day"]!, hour: parts["hour"]! % 24, minute: parts["minute"]!, second: parts["second"]! };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallTime(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of a wall time in a time zone. A time skipped by a clock change moves forward by
 * the change, as Go's `time.Date` (the server) does; a repeated one is its first occurrence.
 */
export function instantOf(w: Wall, timeZone: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Clock changes are hours apart, so the offsets a day before and after are the two candidates.
  const before = guess - offsetAt(guess - 86_400_000, timeZone);
  const after = guess - offsetAt(guess + 86_400_000, timeZone);
  if (before === after) return before;
  const reads = (t: number) => {
    const back = wallTime(t, timeZone);
    return back.day === w.day && back.hour === w.hour && back.minute === w.minute && back.second === w.second;
  };
  const real = [before, after].filter(reads);
  // A repeated time: its first occurrence. A skipped one: the old offset, which lands after the gap.
  return real.length > 0 ? Math.min(...real) : before;
}

// --- Next runs --------------------------------------------------------------------------------

/** How far ahead a calendar is searched, in days (ten years: a yearly schedule still shows five). */
const HORIZON_DAYS = 3660;

function calendarRuns(m: Matcher, from: number, until: number, count: number, timeZone: string): number[] {
  const out: number[] = [];
  const start = wallTime(from, timeZone);
  let day = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < HORIZON_DAYS && out.length < count; i++, day += 86_400_000) {
    const d = new Date(day);
    const year = d.getUTCFullYear();
    if (m.year && !m.year.has(year)) continue;
    const month = d.getUTCMonth() + 1;
    if (!m.month.has(month) || !m.dayOfMonth.has(d.getUTCDate()) || !m.dayOfWeek.has(d.getUTCDay())) continue;
    for (const hour of m.hour) {
      for (const minute of m.minute) {
        for (const second of m.second) {
          const t = instantOf({ year, month, day: d.getUTCDate(), hour, minute, second }, timeZone);
          if (t < from) continue;
          if (t > until) return out;
          out.push(t);
          if (out.length >= count) return out;
        }
      }
    }
  }
  return out;
}

function intervalRuns(every: number, offset: number, from: number, until: number, count: number): number[] {
  const out: number[] = [];
  let t = Math.ceil((from - offset) / every) * every + offset;
  for (; out.length < count && t <= until; t += every) out.push(t);
  return out;
}

/**
 * The next `count` runs at or after `from`: every calendar, cron string and interval merged,
 * within the start and end time. A part that cannot be read is left out and named in `errors`.
 */
export function nextRuns(spec: PreviewSpec, from: Date, count = 5): Preview {
  const errors: Record<string, string> = {};
  let timeZone = (spec.timezone ?? "").trim() || "UTC";
  if (!isTimeZone(timeZone)) {
    errors["timezone"] = `The browser does not know the time zone "${timeZone}".`;
    timeZone = "UTC";
  }
  let lower = from.getTime();
  let upper = Number.POSITIVE_INFINITY;
  for (const [key, value] of [["startTime", spec.startTime], ["endTime", spec.endTime]] as const) {
    const v = (value ?? "").trim();
    if (v === "") continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) errors[key] = "Use a date and time such as 2026-12-01T09:00:00Z.";
    else if (key === "startTime") lower = Math.max(lower, t);
    else upper = t;
  }
  const all: number[] = [];
  const calendars: { calendar: CalendarForm; where: string; timeZone: string }[] = spec.calendars.map((calendar, i) => ({ calendar, where: `calendar ${i + 1}`, timeZone }));
  const intervals: { interval: IntervalForm; where: string }[] = spec.intervals.map((interval, i) => ({ interval, where: `interval ${i + 1}` }));
  spec.cronStrings.forEach((text, i) => {
    if (text.trim() === "") return;
    const where = `cron ${i + 1}`;
    const cron = parseCron(text);
    if ("error" in cron) errors[where] = cron.error;
    else if (cron.interval) intervals.push({ interval: cron.interval, where });
    else if (cron.calendar) {
      const zone = cron.timezone ?? timeZone;
      if (!isTimeZone(zone)) errors[where] = `The browser does not know the time zone "${zone}".`;
      else calendars.push({ calendar: cron.calendar, where, timeZone: zone });
    }
  });
  for (const { calendar, where, timeZone: zone } of calendars) {
    const m = matcherOf(calendar, errors, where);
    if (m) all.push(...calendarRuns(m, lower, upper, count, zone));
  }
  for (const { interval, where } of intervals) {
    const every = parseDuration(interval.every);
    const offset = parseDuration(interval.offset ?? "");
    if (every === null || every === "invalid" || every <= 0) errors[`${where} every`] = "A duration such as 30s, 5m, 1h30m or 2d.";
    else if (offset === "invalid") errors[`${where} offset`] = "A duration such as 30s, 5m, 1h30m or 2d.";
    else all.push(...intervalRuns(every, offset ?? 0, lower, upper, count));
  }
  const runs = [...new Set(all)].sort((a, b) => a - b).slice(0, count).map((t) => new Date(t));
  return { runs, errors };
}

/** A run in the schedule's time zone, as the preview lists it: "Mon 2026-11-23 09:00:00 Europe/Berlin". */
export function formatRun(at: Date, timeZone: string | null | undefined): string {
  const zone = (timeZone ?? "").trim() || "UTC";
  const tz = isTimeZone(zone) ? zone : "UTC";
  const w = wallTime(at.getTime(), tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekday = DAYS[new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()]!;
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)} ${tz}`;
}

// --- In words ---------------------------------------------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const everyValue = (values: readonly number[], field: CalendarField) => values.length === BOUNDS[field][1] - BOUNDS[field][0] + 1;

/** A run of consecutive values as "Mon to Fri", else a list. */
function listOf(values: readonly number[], name: (v: number) => string): string {
  const consecutive = values.length > 2 && values.every((v, i) => i === 0 || v === values[i - 1]! + 1);
  return consecutive ? `${name(values[0]!)} to ${name(values[values.length - 1]!)}` : values.map(name).join(", ");
}

/** A calendar in words: "Every day at 02:00", "Mon to Fri at 09:30", "Every hour at :15". Null when it cannot be read. */
export function describeCalendar(c: CalendarForm): string | null {
  const parts = (["second", "minute", "hour", "dayOfMonth", "month", "dayOfWeek", "year"] as const).map((f) => parseCalendarField(f, c[f]));
  if (parts.some((r) => r !== null && !Array.isArray(r))) return null;
  const [S, M, H, D, N, W] = parts.slice(0, 6) as number[][];
  const year = parts[6] as number[] | null;
  let time: string;
  const sec = S!.length === 1 && S![0] ? `:${pad2(S![0])}` : "";
  if (S!.length !== 1) time = `at seconds ${c.second}, minute ${c.minute || "0"}, hour ${c.hour || "0"}`;
  else if (everyValue(H!, "hour")) time = M!.length === 1 ? `every hour at :${pad2(M![0]!)}${sec}` : `every hour at minutes ${M!.join(", ")}`;
  else if (H!.length * M!.length <= 6) time = `at ${H!.flatMap((h) => M!.map((m) => `${pad2(h)}:${pad2(m)}${sec}`)).join(", ")}`;
  else time = `at minutes ${M!.join(", ")} of hours ${H!.join(", ")}`;
  const days: string[] = [];
  if (!everyValue(W!, "dayOfWeek")) days.push(listOf(W!, (v) => DAY_NAMES[v]!));
  if (!everyValue(D!, "dayOfMonth")) days.push(`day ${listOf(D!, String)} of the month`);
  if (!everyValue(N!, "month")) days.push(`in ${listOf(N!, (v) => MONTH_NAMES[v - 1]!)}`);
  if (year) days.push(`in ${year.join(", ")}`);
  const when = days.length === 0 ? (time.startsWith("every") ? "" : "every day") : days.join(", ");
  const text = when ? `${when} ${time}` : time;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The runs as the preview reads them: the first with its year and zone ("Wed 19 Nov 2026, 02:00
 * CET"), the next ones short ("Thu 20 Nov, 02:00"), the year again when it changes.
 */
export function formatRuns(runs: readonly Date[], timeZone: string | null | undefined): string[] {
  const zone = (timeZone ?? "").trim() || "UTC";
  const tz = isTimeZone(zone) ? zone : "UTC";
  const zoneName = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? tz;
  let lastYear: number | null = null;
  return runs.map((at, i) => {
    const w = wallTime(at.getTime(), tz);
    const weekday = DAY_NAMES[new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()]!;
    const year = w.year !== lastYear ? ` ${w.year}` : "";
    lastYear = w.year;
    const time = `${pad2(w.hour)}:${pad2(w.minute)}${w.second ? `:${pad2(w.second)}` : ""}`;
    return `${weekday} ${w.day} ${MONTH_NAMES[w.month - 1]}${year}, ${time}${i === 0 ? ` ${zoneName(at)}` : ""}`;
  });
}
