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

/** A local date and time with seconds, from an RFC 3339 string; empty when absent or invalid. */
export function formatTime(iso: string | undefined, locale?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(date);
}
