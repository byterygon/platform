/** Small helpers shared by the generator, the validator and the CLI. No Node or DOM APIs. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The candidates closest to `name` (for "did you mean" hints), nearest first, at most `limit`. */
export function closest(name: string, candidates: Iterable<string>, limit: number = 3): string[] {
  const scored: { candidate: string; score: number }[] = [];
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    const shared = candidate.includes(name) || name.includes(candidate);
    if (shared || distance <= Math.max(2, Math.floor(name.length / 3))) {
      scored.push({ candidate, score: shared ? Math.min(distance, 1) : distance });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, limit).map((entry) => entry.candidate);
}

/** Stable JSON: two-space indent, trailing newline. Key order is insertion order, which every producer fixes. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
