// Durations as the servers read and write them ("30s", "1h30m", "2d", "250ms"): Temporal's sheets
// (TSK-92) and NATS's stream and consumer forms (TSK-85) share them.

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
