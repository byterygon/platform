// Edits of a theme file (seeds plus overrides), as pure functions: each returns a new theme and
// leaves its input alone. The Studio never stores anything but the theme file and the view, so
// what it holds is always a file `by-tokens` can read (spec section 9a.1: no GUI-only state).
//
// A removed seed or override is deleted, not set to a default, and empty objects left behind are
// pruned, so "reset" gives back exactly the file the user started from.

/** A theme file as JSON: `schemaVersion`, `name`, `description?`, `seeds?`, `overrides?`. */
export type ThemeDoc = Record<string, unknown>;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at `path` (keys, not a dotted string: override keys contain dots). */
export function getIn(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** A copy with `path` set to `value`, or deleted when `value` is undefined (empty parents pruned). */
export function setIn<T extends Json>(source: T, path: readonly string[], value: unknown): T {
  const [key, ...rest] = path;
  if (key === undefined) return source;
  const out: Json = { ...source };
  if (rest.length === 0) {
    if (value === undefined) delete out[key];
    else out[key] = value;
    return out as T;
  }
  const child = isObject(source[key]) ? (source[key] as Json) : {};
  const next = setIn(child, rest, value);
  if (Object.keys(next).length === 0) delete out[key];
  else out[key] = next;
  return out as T;
}

// ---------------------------------------------------------------------------------------------
// Seeds

/** The seed at `seeds.<path>` as the file has it (undefined when the default applies). */
export const seedOf = (theme: ThemeDoc, path: readonly string[]) => getIn(theme, ["seeds", ...path]);

export const setSeed = (theme: ThemeDoc, path: readonly string[], value: unknown) => setIn(theme, ["seeds", ...path], value);

/** Removes every listed seed, so their defaults apply again. */
export function resetSeeds(theme: ThemeDoc, paths: readonly (readonly string[])[]): ThemeDoc {
  return paths.reduce((next, path) => setSeed(next, path, undefined), theme);
}

// ---------------------------------------------------------------------------------------------
// Overrides

const overridesOf = (theme: ThemeDoc): Json => (isObject(theme["overrides"]) ? (theme["overrides"] as Json) : {});

/** The override of a token as written (a value for every mode, or an object keyed by mode). */
export const overrideOf = (theme: ThemeDoc, token: string): unknown => overridesOf(theme)[token];

/** The paths of every overridden token, in file order. */
export const overriddenTokens = (theme: ThemeDoc): string[] => Object.keys(overridesOf(theme));

/**
 * Sets (or with `undefined`, removes) a token's override. Without `mode` the value applies to every
 * mode. With `mode`, only that mode changes: a value written for every mode is first spread over
 * `modes` (the token's modes, from its axis) so the other modes keep it.
 */
export function setOverride(theme: ThemeDoc, token: string, value: unknown, mode?: string, modes: readonly string[] = []): ThemeDoc {
  if (mode === undefined) return setIn(theme, ["overrides", token], value);
  const current = overrideOf(theme, token);
  const perMode: Json = isObject(current) ? { ...current } : current === undefined ? {} : Object.fromEntries(modes.map((m) => [m, current]));
  if (value === undefined) delete perMode[mode];
  else perMode[mode] = value;
  return setIn(theme, ["overrides", token], Object.keys(perMode).length === 0 ? undefined : perMode);
}

/** The group of a token path: everything before the last segment (`color.bg.surface` -> `color.bg`). */
export const groupOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf(".")));

/** Removes the overrides of every token in a group (the group itself and anything under it). */
export function resetGroup(theme: ThemeDoc, group: string): ThemeDoc {
  let next = theme;
  for (const token of overriddenTokens(theme)) {
    if (token === group || token.startsWith(`${group}.`)) next = setOverride(next, token, undefined);
  }
  return next;
}

/** The text a user edits for an override value: font lists comma-separated, the rest as written. */
export function overrideText(value: unknown): string {
  // A list of font families reads as CSS; a list of shadow or gradient layers as the JSON it is.
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(", ");
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The override value for the text a user typed, for a token of `type`. */
export function parseOverrideText(type: string, text: string): unknown {
  const trimmed = text.trim();
  if (type === "fontFamily" && !trimmed.startsWith("{")) {
    return trimmed
      .split(",")
      .map((family) => family.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if ((type === "number" || type === "fontWeight") && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") || trimmed.startsWith("{\"")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
