// Times as the tables write them (moved from the Temporal tool for LangGraph, TSK-96).

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
