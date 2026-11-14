/**
 * Token values by type: building them, reading the literals a theme file may write, checking
 * their structure, and printing them as CSS. Adding a token type is an entry in each of the
 * switches below; nothing else in the engine depends on the list of types.
 */
import { type Oklch, formatOklch, gamutMapSrgb, oklchToHex, parseColor, roundOklch } from "./color/index.js";
import {
  type Alias,
  type ColorValue,
  type DimensionValue,
  type DurationValue,
  type RawValue,
  type ShadowLayer,
  type TokenType,
  type TokenValue,
  isAlias,
} from "./model.js";
import { isPlainObject } from "./util.js";

export const TOKEN_TYPES: readonly TokenType[] = [
  "color",
  "dimension",
  "number",
  "fontFamily",
  "fontWeight",
  "duration",
  "cubicBezier",
  "shadow",
];

/** CSS custom property name of a token: `color.bg.surface` -> `--by-color-bg-surface`. */
export function cssVarName(path: string): string {
  return `--by-${path.split(".").join("-")}`;
}

const SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A token path is dot-separated lower-case segments (letters, digits, single dashes). */
export function isValidPath(path: string): boolean {
  const segments = path.split(".");
  return segments.length >= 2 && segments.every((segment) => SEGMENT.test(segment));
}

// ---------------------------------------------------------------------------------------------
// Colour

/** A DTCG colour value from an OKLCH colour: mapped into sRGB, at token precision, with a hex fallback. */
export function colorValue(color: Oklch): ColorValue {
  const settled = roundOklch(gamutMapSrgb(color).color);
  const base = { colorSpace: "oklch" as const, components: [settled.l, settled.c, settled.h] as const };
  const hex = oklchToHex(settled);
  return settled.alpha === undefined ? { ...base, hex } : { ...base, alpha: settled.alpha, hex };
}

export function colorToOklch(value: ColorValue): Oklch {
  const [l, c, h] = value.components;
  return value.alpha === undefined ? { l, c, h } : { l, c, h, alpha: value.alpha };
}

function isColorValue(value: unknown): value is ColorValue {
  if (!isPlainObject(value)) return false;
  const components = value["components"];
  return (
    value["colorSpace"] === "oklch" &&
    Array.isArray(components) &&
    components.length === 3 &&
    components.every((c) => typeof c === "number" && Number.isFinite(c)) &&
    (value["alpha"] === undefined || (typeof value["alpha"] === "number" && value["alpha"] >= 0 && value["alpha"] <= 1)) &&
    typeof value["hex"] === "string" &&
    /^#[0-9a-f]{6}$/.test(value["hex"])
  );
}

// ---------------------------------------------------------------------------------------------
// Parsing the literals a theme file may write

export type Parsed = { readonly ok: true; readonly value: TokenValue; readonly note?: string } | { readonly ok: false; readonly error: string };

const fail = (error: string): Parsed => ({ ok: false, error });

function parseUnit<U extends string>(input: unknown, units: readonly U[]): { value: number; unit: U } | undefined {
  if (isPlainObject(input)) {
    const { value, unit } = input;
    if (typeof value === "number" && Number.isFinite(value) && typeof unit === "string" && (units as readonly string[]).includes(unit)) {
      return { value, unit: unit as U };
    }
    return undefined;
  }
  if (input === 0) return { value: 0, unit: units[0]! };
  if (typeof input !== "string") return undefined;
  const match = /^(-?(?:\d+\.?\d*|\.\d+))([a-z]+)$/.exec(input.trim());
  if (!match || !(units as readonly string[]).includes(match[2]!)) return undefined;
  return { value: Number(match[1]), unit: match[2] as U };
}

function parseColorLiteral(input: unknown): Parsed {
  if (isColorValue(input)) return { ok: true, value: input };
  if (typeof input !== "string") return fail("expected a colour: oklch(L C H), oklch(L C H / A) or a hex colour");
  const parsed = parseColor(input);
  if (!parsed) return fail(`"${input}" is not a colour; write oklch(L C H), oklch(L C H / A) or a hex colour`);
  const mapped = gamutMapSrgb(parsed);
  const value = colorValue(parsed);
  return mapped.mapped && mapped.requestedChroma - mapped.color.c > 0.005
    ? { ok: true, value, note: `chroma ${mapped.requestedChroma} is outside sRGB; reduced to ${value.components[1]}` }
    : { ok: true, value };
}

function parseShadowLayer(input: unknown): { ok: true; layer: ShadowLayer } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: "a shadow layer must be an object with color, offsetX, offsetY, blur and spread" };
  const dimension = (key: string): DimensionValue | Alias | string => {
    const raw = input[key] ?? 0;
    if (isAlias(raw)) return raw;
    return parseUnit(raw, ["px", "rem"] as const) ?? `shadow ${key} must be a dimension such as 2px`;
  };
  const color = isAlias(input["color"]) ? ({ ok: true, value: input["color"] } as const) : parseColorLiteral(input["color"]);
  if (!color.ok) return { ok: false, error: `shadow color: ${color.error}` };
  const fields = { offsetX: dimension("offsetX"), offsetY: dimension("offsetY"), blur: dimension("blur"), spread: dimension("spread") };
  for (const value of Object.values(fields)) {
    if (typeof value === "string" && !isAlias(value)) return { ok: false, error: value };
  }
  const layer = { color: color.value as ColorValue | Alias, ...(fields as Record<keyof typeof fields, DimensionValue | Alias>) };
  return { ok: true, layer: input["inset"] === true ? { ...layer, inset: true } : layer };
}

/**
 * Reads a value written in a theme file for a token of `type`: an alias (`{color.brand.11}`), a
 * CSS-like literal (`oklch(0.5 0.1 230)`, `#0a7ea4`, `12px`, `150ms`), or the DTCG object form.
 */
export function parseLiteral(type: TokenType, input: unknown): Parsed {
  if (isAlias(input)) return { ok: true, value: input };
  switch (type) {
    case "color":
      return parseColorLiteral(input);
    case "dimension": {
      const value = parseUnit(input, ["px", "rem"] as const);
      return value ? { ok: true, value } : fail("expected a dimension such as 12px or 0.75rem");
    }
    case "duration": {
      const value = parseUnit(input, ["ms", "s"] as const);
      return value ? { ok: true, value } : fail("expected a duration such as 150ms or 0.2s");
    }
    case "number":
      return typeof input === "number" && Number.isFinite(input) ? { ok: true, value: input } : fail("expected a number");
    case "fontWeight":
      return (typeof input === "number" && input >= 1 && input <= 1000) || (typeof input === "string" && input.length > 0)
        ? { ok: true, value: input }
        : fail("expected a font weight: a number from 1 to 1000, or a keyword");
    case "fontFamily":
      if (typeof input === "string" && input.length > 0) return { ok: true, value: input };
      if (Array.isArray(input) && input.length > 0 && input.every((f) => typeof f === "string" && f.length > 0)) {
        return { ok: true, value: input as string[] };
      }
      return fail("expected a font family: a string or a list of strings");
    case "cubicBezier":
      return Array.isArray(input) && input.length === 4 && input.every((n) => typeof n === "number" && Number.isFinite(n))
        ? { ok: true, value: input as unknown as RawValue }
        : fail("expected a cubic bezier: four numbers");
    case "shadow": {
      const list = Array.isArray(input) ? input : [input];
      if (list.length === 0) return fail("expected at least one shadow layer");
      const layers: ShadowLayer[] = [];
      for (const item of list) {
        const parsed = parseShadowLayer(item);
        if (!parsed.ok) return fail(parsed.error);
        layers.push(parsed.layer);
      }
      return { ok: true, value: layers };
    }
  }
}

/** Structural check of a stored value. Returns a message when it is not a valid value of `type`. */
export function checkValue(type: TokenType, value: TokenValue): string | undefined {
  const parsed = parseLiteral(type, value);
  return parsed.ok ? undefined : parsed.error;
}

// ---------------------------------------------------------------------------------------------
// Walking aliases inside a value

/** Every alias a value contains: the value itself, or the fields of a composite. */
export function aliasesIn(value: TokenValue): Alias[] {
  if (isAlias(value)) return [value];
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).flatMap((item) =>
      isPlainObject(item) ? Object.values(item).filter((field): field is Alias => isAlias(field)) : [],
    );
  }
  return [];
}

/** Every colour literal a value contains (a colour token's own value, or a shadow layer's colour). */
export function colorLiteralsIn(type: TokenType, value: TokenValue): ColorValue[] {
  if (isAlias(value)) return [];
  if (type === "color") return [value as ColorValue];
  if (type === "shadow") {
    return (value as readonly ShadowLayer[]).map((l) => l.color).filter((c): c is ColorValue => !isAlias(c));
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// CSS

const formatNumber = (value: number) => String(Math.round(value * 10000) / 10000);
const dimensionCss = (value: DimensionValue | DurationValue) => (value.value === 0 ? "0" : `${formatNumber(value.value)}${value.unit}`);

function fontFamilyCss(value: string | readonly string[]): string {
  const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|emoji|math|fangsong)$/;
  const quote = (family: string) => (generic.test(family) || /^[a-zA-Z][a-zA-Z0-9-]*$/.test(family) ? family : JSON.stringify(family));
  return (typeof value === "string" ? [value] : value).map(quote).join(", ");
}

/**
 * A value as CSS text. `alias` prints an alias (the outputs pass a function that returns
 * `var(--by-...)`; pass none when the value is already fully resolved).
 */
export function cssValue(type: TokenType, value: TokenValue, alias: (alias: Alias) => string = (a) => a): string {
  if (isAlias(value)) return alias(value);
  switch (type) {
    case "color":
      return formatOklch(colorToOklch(value as ColorValue));
    case "dimension":
    case "duration":
      return dimensionCss(value as DimensionValue | DurationValue);
    case "number":
      return formatNumber(value as number);
    case "fontWeight":
      return String(value);
    case "fontFamily":
      return fontFamilyCss(value as string | readonly string[]);
    case "cubicBezier":
      return `cubic-bezier(${(value as readonly number[]).map(formatNumber).join(", ")})`;
    case "shadow":
      return (value as readonly ShadowLayer[])
        .map((l) => {
          const part = (field: DimensionValue | Alias) => (isAlias(field) ? alias(field) : dimensionCss(field));
          const color = isAlias(l.color) ? alias(l.color) : formatOklch(colorToOklch(l.color));
          return `${l.inset ? "inset " : ""}${part(l.offsetX)} ${part(l.offsetY)} ${part(l.blur)} ${part(l.spread)} ${color}`;
        })
        .join(", ");
  }
}
