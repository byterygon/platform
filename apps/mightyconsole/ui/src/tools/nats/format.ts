// How the NATS screens write sizes, counts, sequences, durations and times.
import { formatCount } from "@/app/messages";

/** "1 MiB", "980 B", "1.9 GiB". */
export function formatSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${n} B` : `${+n.toFixed(n >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** "1.28 M", "512 k", "980": a count in a bar's label. */
export function formatShortCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)} M`;
  if (n >= 10_000) return `${Math.round(n / 1000)} k`;
  return formatCount(n);
}

/** "24h", "8h 44m", "2 min", "30 s", "250 ms": a limit or an age. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/** A JetStream time (microseconds since the epoch): "18 Nov 2026, 02:00:04". */
export function formatUs(us: number | undefined, locale = "en-GB"): string {
  if (us === undefined || us <= 0) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(us / 1000));
}

/** "3 days ago", "2 min ago", "just now". */
export function formatAgo(us: number | undefined, now = Date.now()): string {
  if (us === undefined || us <= 0) return "";
  const ms = Math.max(0, now - us / 1000);
  if (ms < 5000) return "just now";
  return `${formatDuration(ms)} ago`;
}
