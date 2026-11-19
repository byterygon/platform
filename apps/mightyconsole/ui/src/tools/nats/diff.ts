// Two revisions of a value compared line by line (the KV History's "38 → 42", DOC-21 Open question
// 45 (o)): JSON is pretty-printed first so a change to one field is one line; a longest common
// subsequence keeps the unchanged lines in place. Large values are compared as text up to a limit.

export type DiffLine = { kind: "same" | "removed" | "added"; text: string };

/** Lines compared at most on each side; beyond, the rest is shown as removed and added. */
export const MAX_DIFF_LINES = 2000;

/** JSON pretty-printed, other text as it is. */
export function normalise(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The lines of `after` against `before`. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = normalise(before).split("\n");
  const b = normalise(after).split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...a.map((text) => ({ kind: "removed" as const, text })), ...b.map((text) => ({ kind: "added" as const, text }))];
  }
  // lcs[i][j]: the common lines of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "removed", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) out.push({ kind: "added", text: b[j++]! });
  return out;
}
