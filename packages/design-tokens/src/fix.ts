/**
 * Applying a diagnostic's fix to a theme file: what the Theme Studio's one-click fixes and
 * `by-tokens fix` both do, so a fix is the same edit whichever applies it. Pure; runs in the browser.
 *
 * A fix carries `overrides` (token path to a value, or to an object keyed by mode) and `seeds` (a
 * partial seeds object). Overrides replace the theme's override for that token; when the fix sets
 * some modes of a token the theme overrides for every mode, the theme's value is kept for the other
 * modes. Seeds merge key by key, ramps field by field.
 */
import { DEFAULT_CATALOG } from "./catalog/default.js";
import type { Catalog } from "./catalog/authoring.js";
import { generateTokens } from "./generate.js";
import type { Diagnostic, Fix, TokenSet } from "./model.js";
import { isPlainObject } from "./util.js";
import { validate } from "./validate.js";

type Json = Record<string, unknown>;

function mergeDeep(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch);
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = mergeDeep(base[key], value);
  return out;
}

/** True when `value` is an override keyed by mode names (`{ "dark": "{color.brand-dark.12}" }`). */
function isModed(value: unknown, modes: readonly string[]): value is Json {
  return isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => modes.includes(key));
}

/**
 * The theme file with `fix` applied. `set` is the theme's generated token set (it names the mode
 * axes); without it, a per-mode fix replaces the whole override.
 */
export function applyFix(theme: unknown, fix: Pick<Fix, "overrides" | "seeds">, set?: TokenSet): Json {
  const out: Json = isPlainObject(theme) ? structuredClone(theme) : { schemaVersion: 1, name: "theme" };
  if (fix.seeds !== undefined) out["seeds"] = mergeDeep(isPlainObject(out["seeds"]) ? out["seeds"] : {}, fix.seeds);
  if (fix.overrides) {
    const overrides: Json = isPlainObject(out["overrides"]) ? { ...out["overrides"] } : {};
    for (const [path, value] of Object.entries(fix.overrides)) {
      // The axis whose modes the fix names (a token overridden for every mode no longer has one).
      const keys = isPlainObject(value) ? Object.keys(value) : [];
      const modes = (keys.length > 0 && set?.axes.find((axis) => keys.every((key) => axis.modes.includes(key)))?.modes) || [];
      const existing = overrides[path];
      if (modes.length > 0 && isModed(value, modes) && existing !== undefined) {
        // Keep what the theme says for the modes the fix leaves alone.
        const before: Json = isModed(existing, modes) ? existing : Object.fromEntries(modes.map((mode) => [mode, existing]));
        overrides[path] = { ...before, ...structuredClone(value) };
      } else {
        overrides[path] = structuredClone(value);
      }
    }
    out["overrides"] = overrides;
  }
  return out;
}

/** True when the fix changes the theme file (some only explain what to do). */
export const isApplicable = (fix: Fix | undefined): fix is Fix & ({ overrides: object } | { seeds: unknown }) =>
  fix !== undefined && (fix.overrides !== undefined || fix.seeds !== undefined);

export interface FixAllResult {
  /** The theme with every applied fix. */
  readonly theme: Json;
  /** The diagnostics whose fixes were applied, in order. */
  readonly applied: readonly Diagnostic[];
  /** What the theme still breaks after the fixes. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Applies the primary fix of the first fixable error, validates again, and repeats until no error
 * has a fix (or `limit` fixes). One at a time, because a contrast fix is solved against every
 * background of its role and often clears several failures at once. Warnings (a gamut warning:
 * accepting the reduced chroma is a valid choice) are left alone.
 */
export function fixAll(theme: unknown, options: { readonly catalog?: Catalog; readonly limit?: number } = {}): FixAllResult {
  const catalog = options.catalog ?? DEFAULT_CATALOG;
  let current: Json = isPlainObject(theme) ? structuredClone(theme) : { schemaVersion: 1, name: "theme" };
  const applied: Diagnostic[] = [];
  const tried = new Set<string>();
  for (let i = 0; i < (options.limit ?? 50); i += 1) {
    const generated = generateTokens(current, catalog);
    const diagnostics = [...generated.diagnostics, ...validate(generated.set).diagnostics];
    const next = diagnostics.find((d) => d.severity === "error" && isApplicable(d.fix) && !tried.has(JSON.stringify([d.fix!.overrides, d.fix!.seeds])));
    if (!next) return { theme: current, applied, diagnostics };
    // A fix that comes back after being applied would loop; try each edit once.
    tried.add(JSON.stringify([next.fix!.overrides, next.fix!.seeds]));
    current = applyFix(current, next.fix!, generated.set);
    applied.push(next);
  }
  const generated = generateTokens(current, catalog);
  return { theme: current, applied, diagnostics: [...generated.diagnostics, ...validate(generated.set).diagnostics] };
}
