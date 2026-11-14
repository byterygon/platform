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
 * Brand: a blue-teal around hue 230 (tentative; see the spec's open questions). Its chroma is the
 * most sRGB can show at the solid's lightness for that hue. Amber is the one ramp with a light
 * solid, because a dark amber reads as brown.
 */
export const DEFAULT_SEEDS: Seeds = {
  colors: {
    neutral: { chroma: 0.025 },
    brand: { hue: 230, chroma: 0.11 },
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
  radius: 6,
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

const SEED_KEYS = ["colors", "radius", "fontSize", "colorScheme", "density", "contrast"] as const;
const RAMP_KEYS = ["hue", "chroma", "solid", "tint"] as const;

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
    const fields: Record<string, unknown> = { ...(DEFAULT_SEEDS.colors[name] ?? {}), ...(given ?? {}) };
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
