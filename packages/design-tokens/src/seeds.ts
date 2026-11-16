/**
 * Seeds: the handful of numbers a theme is generated from. This module holds the defaults and
 * turns a theme file's partial `seeds` into a complete, validated set.
 */
import type { RampSeed } from "./color/index.js";
import type { Diagnostic, Seeds, SeedsInput } from "./model.js";
import { closest, isPlainObject } from "./util.js";

/**
 * The default theme's seeds. `themes/default.theme.json` spells the same values out, and a test
 * keeps the two equal.
 *
 * The default theme is Aurora (DOC-17 open question 104, TSK-57): the violet #6b4eff brand (hue
 * 282.5; the seed chroma is what the dark solid can show, the light steps 9-11 are overridden to
 * the full chroma in the theme file) with the solid lightness of #6b4eff and the canvas's #a998ff,
 * on a cool grey neutral (hue 275, a faint tint). The previous blue-teal default is the `classic`
 * preset. Amber is the one other ramp with a light solid, because a dark amber reads as brown.
 *
 * `brand` and `neutral` are a theme's identity: a theme that gives its own takes their optional
 * fields (`solid`, `tint`, and the neutral `hue`) from itself only, never from these defaults
 * (`resolveSeeds`), so Aurora's tuning does not leak into a theme with another brand; a theme
 * that gives a brand and no neutral gets the default neutral's chroma on its own brand hue.
 */
export const DEFAULT_SEEDS: Seeds = {
  colors: {
    neutral: { hue: 275, chroma: 0.012, tint: 0.006 },
    brand: { hue: 282.5, chroma: 0.165, solid: { light: 0.5656, dark: 0.7365 } },
    red: { hue: 27, chroma: 0.2 },
    amber: { hue: 75, chroma: 0.15, solid: { light: 0.8, dark: 0.8 } },
    green: { hue: 150, chroma: 0.14 },
    blue: { hue: 255, chroma: 0.17 },
    // Hues the status ramps leave open: syntax, data types and chart series need more than six.
    violet: { hue: 305, chroma: 0.15 },
    orange: { hue: 55, chroma: 0.16 },
    teal: { hue: 190, chroma: 0.11 },
    pink: { hue: 350, chroma: 0.16 },
  },
  radius: 4,
  fontSize: 14,
  colorScheme: "light",
  density: "comfortable",
  contrast: { level: "AA" },
};

/** Seeds with every ramp complete (the neutral hue filled in from the brand when omitted). */
export interface ResolvedSeeds extends Omit<Seeds, "colors"> {
  readonly colors: Readonly<Record<string, RampSeed>>;
}

/** Ramp names that would collide with the fixed primitives or with the `-dark` naming. */
const RESERVED_RAMPS = new Set(["base", "white", "black"]);
const RAMP_NAME = /^[a-z][a-z0-9]*$/;

export const SEED_KEYS = ["colors", "radius", "fontSize", "colorScheme", "density", "contrast"] as const;
export const RAMP_KEYS = ["hue", "chroma", "solid", "tint"] as const;

/**
 * Ramps whose optional fields are tuned to the default theme's own colour: a theme that gives one
 * keeps only `chroma` (and the brand's `hue`) from the defaults, so a brand of another hue does not
 * inherit Aurora's solid lightness, nor a neutral Aurora's hue or tint.
 */
const IDENTITY_RAMPS: Readonly<Record<string, readonly string[]>> = { brand: ["solid", "tint"], neutral: ["hue", "solid", "tint"] };

export function resolveSeeds(input: SeedsInput | undefined): { seeds: ResolvedSeeds; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const error = (token: string, message: string, extra: Partial<Diagnostic> = {}) =>
    diagnostics.push({ severity: "error", rule: "seed-invalid", token, message, ...extra });

  const source: Record<string, unknown> = isPlainObject(input) ? input : {};
  if (input !== undefined && !isPlainObject(input)) error("seeds", "seeds must be an object");
  for (const key of Object.keys(source)) {
    if (!(SEED_KEYS as readonly string[]).includes(key)) {
      const near = closest(key, SEED_KEYS);
      error(`seeds.${key}`, `unknown seed "${key}"`, {
        fix: { summary: near.length > 0 ? `Did you mean ${near.join(" or ")}?` : `Known seeds: ${SEED_KEYS.join(", ")}.` },
      });
    }
  }

  const number = (path: string, value: unknown, min: number, max: number, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      error(path, `${path} must be a number from ${min} to ${max}`, {
        measured: typeof value === "number" ? value : JSON.stringify(value),
        required: `${min}..${max}`,
      });
      return fallback;
    }
    return value;
  };
  const oneOf = <T extends string>(path: string, value: unknown, options: readonly T[], fallback: T): T => {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
      error(path, `${path} must be one of ${options.join(", ")}`, {
        measured: JSON.stringify(value),
        required: options.join(" | "),
      });
      return fallback;
    }
    return value as T;
  };

  // Colours: defaults, then the theme's ramps on top, field by field.
  const colorsInput = source["colors"];
  if (colorsInput !== undefined && !isPlainObject(colorsInput)) error("seeds.colors", "seeds.colors must be an object");
  const colorSources: Record<string, unknown> = isPlainObject(colorsInput) ? colorsInput : {};
  const names = [...new Set([...Object.keys(DEFAULT_SEEDS.colors), ...Object.keys(colorSources)])];
  const partial = new Map<string, { hue?: number; chroma: number; solid?: { light?: number; dark?: number }; tint?: number }>();

  for (const name of names) {
    const path = `seeds.colors.${name}`;
    if (!RAMP_NAME.test(name) || RESERVED_RAMPS.has(name)) {
      error(path, `"${name}" is not a valid ramp name`, {
        required: "lower-case letters and digits, starting with a letter; not base, white or black",
      });
      continue;
    }
    const given = colorSources[name];
    if (given !== undefined && !isPlainObject(given)) {
      error(path, `${path} must be an object with hue and chroma`);
      continue;
    }
    const defaults: Record<string, unknown> = { ...(DEFAULT_SEEDS.colors[name] ?? {}) };
    // A theme with its own brand also gets a neutral that follows that brand, as the neutral
    // always has, rather than the default's own cool grey.
    const ownIdentity = given !== undefined || (name === "neutral" && colorSources["brand"] !== undefined);
    if (ownIdentity) for (const key of IDENTITY_RAMPS[name] ?? []) delete defaults[key];
    const fields: Record<string, unknown> = { ...defaults, ...(given ?? {}) };
    for (const key of Object.keys(fields)) {
      if (!(RAMP_KEYS as readonly string[]).includes(key)) {
        error(`${path}.${key}`, `unknown ramp seed "${key}"`, { fix: { summary: `Known fields: ${RAMP_KEYS.join(", ")}.` } });
      }
    }
    if (fields["chroma"] === undefined) {
      error(`${path}.chroma`, `${path} needs a chroma`, { required: "0..0.4", fix: { summary: "Add chroma, for example 0.15." } });
      continue;
    }
    if (fields["hue"] === undefined && name !== "neutral") {
      error(`${path}.hue`, `${path} needs a hue`, { required: "0..360", fix: { summary: "Add hue in OKLCH degrees, for example 230." } });
      continue;
    }
    const ramp: { hue?: number; chroma: number; solid?: { light?: number; dark?: number }; tint?: number } = {
      chroma: number(`${path}.chroma`, fields["chroma"], 0, 0.4, 0),
    };
    if (fields["tint"] !== undefined) ramp.tint = number(`${path}.tint`, fields["tint"], 0, 0.1, 0);
    if (fields["hue"] !== undefined) ramp.hue = number(`${path}.hue`, fields["hue"], 0, 360, 0);
    const solid = fields["solid"];
    if (solid !== undefined) {
      if (!isPlainObject(solid)) {
        error(`${path}.solid`, `${path}.solid must be an object with light and/or dark lightness`);
      } else {
        const out: { light?: number; dark?: number } = {};
        for (const key of Object.keys(solid)) {
          if (key !== "light" && key !== "dark") error(`${path}.solid.${key}`, `unknown key "${key}"; use light or dark`);
        }
        if (solid["light"] !== undefined) out.light = number(`${path}.solid.light`, solid["light"], 0.2, 0.95, 0.55);
        if (solid["dark"] !== undefined) out.dark = number(`${path}.solid.dark`, solid["dark"], 0.2, 0.95, 0.72);
        ramp.solid = out;
      }
    }
    partial.set(name, ramp);
  }

  const brandHue = partial.get("brand")?.hue ?? (DEFAULT_SEEDS.colors["brand"] as RampSeed).hue;
  const colors: Record<string, RampSeed> = {};
  for (const [name, ramp] of partial) {
    colors[name] = {
      hue: ramp.hue ?? brandHue,
      chroma: ramp.chroma,
      ...(ramp.solid ? { solid: ramp.solid } : {}),
      ...(ramp.tint !== undefined ? { tint: ramp.tint } : {}),
    };
  }

  const contrastInput = source["contrast"];
  if (contrastInput !== undefined && !isPlainObject(contrastInput)) error("seeds.contrast", "seeds.contrast must be an object");
  const contrastSource: Record<string, unknown> = isPlainObject(contrastInput) ? contrastInput : {};
  for (const key of Object.keys(contrastSource)) {
    if (key !== "level" && key !== "apca") error(`seeds.contrast.${key}`, `unknown key "${key}"; use level or apca`);
  }
  const level = oneOf("seeds.contrast.level", contrastSource["level"], ["AA", "AAA"] as const, DEFAULT_SEEDS.contrast.level);
  let apca: { text?: number; ui?: number } | undefined;
  const apcaInput = contrastSource["apca"];
  if (apcaInput !== undefined) {
    if (!isPlainObject(apcaInput)) {
      error("seeds.contrast.apca", "seeds.contrast.apca must be an object with text and/or ui (Lc)");
    } else {
      apca = {};
      for (const key of Object.keys(apcaInput)) {
        if (key !== "text" && key !== "ui") error(`seeds.contrast.apca.${key}`, `unknown key "${key}"; use text or ui`);
      }
      if (apcaInput["text"] !== undefined) apca.text = number("seeds.contrast.apca.text", apcaInput["text"], 0, 108, 60);
      if (apcaInput["ui"] !== undefined) apca.ui = number("seeds.contrast.apca.ui", apcaInput["ui"], 0, 108, 45);
    }
  }

  const seeds: ResolvedSeeds = {
    colors,
    radius: number("seeds.radius", source["radius"], 0, 32, DEFAULT_SEEDS.radius),
    fontSize: number("seeds.fontSize", source["fontSize"], 11, 18, DEFAULT_SEEDS.fontSize),
    colorScheme: oneOf("seeds.colorScheme", source["colorScheme"], ["light", "dark"] as const, DEFAULT_SEEDS.colorScheme),
    density: oneOf("seeds.density", source["density"], ["comfortable", "compact"] as const, DEFAULT_SEEDS.density),
    contrast: apca ? { level, apca } : { level },
  };
  return { seeds, diagnostics };
}
