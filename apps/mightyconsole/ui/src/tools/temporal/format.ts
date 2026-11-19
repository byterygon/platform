// How the Workflows table writes times and durations.

/** "1d 4h", "3m 20s", "850 ms": the two largest units, so a row stays short. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const parts: [string, number][] = [
    ["d", Math.floor(ms / 86_400_000)],
    ["h", Math.floor(ms / 3_600_000) % 24],
    ["m", Math.floor(ms / 60_000) % 60],
    ["s", Math.floor(ms / 1000) % 60],
  ];
  const shown = parts.filter(([, n]) => n > 0).slice(0, 2);
  return shown.map(([unit, n]) => `${n}${unit}`).join(" ");
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A short local time for a table, as the mockup writes it: "10:39:30" today, "17 Nov, 10:39" this
 * year, "17 Nov 2025" before; empty when absent or invalid. The full time goes in the cell's title.
 */
export function formatShortTime(iso: string | undefined, now: Date = new Date(), locale = "en-GB"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (d.toDateString() === now.toDateString()) return hms;
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(d);
  if (d.getFullYear() === now.getFullYear()) return `${day}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${day} ${d.getFullYear()}`;
}

/** A local date and time with seconds, from an RFC 3339 string; empty when absent or invalid. */
export function formatTime(iso: string | undefined, locale = "en-GB"): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(date);
}
