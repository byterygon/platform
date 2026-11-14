/**
 * The vocabulary a catalogue is written in. A catalogue is data: role definitions, contrast
 * pairs and alias tables. Adding a role, a pair or a whole family of tokens is an edit to a
 * catalogue file, never to the generator.
 */
import type { ContrastKind } from "../color/index.js";
import type {
  Alias,
  ContrastPair,
  DimensionValue,
  ShadowLayer,
  Tier,
  TokenType,
  TokenValue,
} from "../model.js";
import { aliasTo } from "../model.js";
import type { ResolvedSeeds } from "../seeds.js";

/** A value that differs per mode of one axis. Every mode of the axis must be given. */
export interface Moded {
  readonly axis: string;
  readonly values: Readonly<Record<string, TokenValue>>;
}

export function isModed(value: unknown): value is Moded {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Moded).axis === "string" &&
    typeof (value as Moded).values === "object"
  );
}

export type RoleValue = TokenValue | Moded;

export interface RoleDef {
  /** Dot path; becomes the CSS variable `--by-` plus the path joined with dashes. */
  readonly path: string;
  readonly type: TokenType;
  /**
   * `semantic` unless stated. A `primitive` role holds a literal (a number a seed drives, a
   * duration, a scale step) and is referenced by roles, never by components.
   */
  readonly tier?: Tier;
  /** The value, or a function of the seeds for roles a seed drives (radius). */
  readonly value: RoleValue | ((seeds: ResolvedSeeds) => RoleValue);
  /** When to use the token. A full sentence. */
  readonly use: string;
  /** When not to use it, and what to use instead. A full sentence. */
  readonly avoid: string;
  /** Tailwind v4 theme variable that exposes the role as a utility, for example `--color-surface`. */
  readonly tailwind?: string;
}

export interface Catalog {
  readonly roles: readonly RoleDef[];
  readonly pairs: readonly ContrastPair[];
  /** shadcn/ui variable name -> role path. */
  readonly shadcn: Readonly<Record<string, string>>;
}

export const ref = (path: string): Alias => aliasTo(path);
export const px = (value: number): DimensionValue => ({ value, unit: "px" });

/** A different value in the light and the dark colour scheme. */
export const byTheme = (light: TokenValue, dark: TokenValue): Moded => ({ axis: "theme", values: { light, dark } });

/** A different value in the comfortable and the compact density. */
export const byDensity = (comfortable: TokenValue, compact: TokenValue): Moded => ({
  axis: "density",
  values: { comfortable, compact },
});

/**
 * A ramp step in both schemes: `ramp("neutral", 12)` is `{color.neutral.12}` in light and
 * `{color.neutral-dark.12}` in dark. Pass a second step when the dark scheme uses a different one.
 * A step is 1..12, an alpha variant (`"a3"`) or `"contrast"` (the text colour for the solid).
 */
export const ramp = (name: string, light: number | string, dark: number | string = light): Moded =>
  byTheme(ref(`color.${name}.${light}`), ref(`color.${name}-dark.${dark}`));

/** One shadow layer; the colour must be an alias to a primitive. */
export const layer = (color: Alias, x: number, y: number, blur: number, spread: number = 0): ShadowLayer => ({
  color,
  offsetX: px(x),
  offsetY: px(y),
  blur: px(blur),
  spread: px(spread),
});

/** Every foreground against every background. */
export function pairs(
  kind: ContrastKind,
  fgs: readonly string[],
  bgs: readonly string[],
  over?: string,
): ContrastPair[] {
  return fgs.flatMap((fg) => bgs.map((bg): ContrastPair => (over === undefined ? { fg, bg, kind } : { fg, bg, kind, over })));
}
