/**
 * The token model: DTCG (Design Tokens Format Module 2025.10) values, the three tiers, the mode
 * axes, and the flat token set every other module works on.
 */
import type { ContrastKind, RampSeed } from "./color/index.js";

/** The `$extensions` key Byterygon metadata lives under. */
export const EXTENSION = "com.byterygon";

/** Version of the theme file schema and of the `--json` envelopes. */
export const SCHEMA_VERSION = 1;

export type Tier = "primitive" | "semantic" | "component";
export const TIERS: readonly Tier[] = ["primitive", "semantic", "component"];

// ---------------------------------------------------------------------------------------------
// Values (DTCG 2025.10)

/** `{group.token}`: a reference to another token. */
export type Alias = `{${string}}`;

export interface ColorValue {
  readonly colorSpace: "oklch";
  /** Lightness 0..1, chroma, hue in degrees. */
  readonly components: readonly [number, number, number];
  readonly alpha?: number;
  /** sRGB fallback, `#rrggbb`, for tools that do not read OKLCH. */
  readonly hex: string;
}

export interface DimensionValue {
  readonly value: number;
  readonly unit: "px" | "rem";
}

export interface DurationValue {
  readonly value: number;
  readonly unit: "ms" | "s";
}

export interface ShadowLayer {
  readonly color: ColorValue | Alias;
  readonly offsetX: DimensionValue | Alias;
  readonly offsetY: DimensionValue | Alias;
  readonly blur: DimensionValue | Alias;
  readonly spread: DimensionValue | Alias;
  readonly inset?: boolean;
}

export type FontFamilyValue = string | readonly string[];
export type CubicBezierValue = readonly [number, number, number, number];

export interface ValueByType {
  color: ColorValue;
  dimension: DimensionValue;
  number: number;
  fontFamily: FontFamilyValue;
  fontWeight: number | string;
  duration: DurationValue;
  cubicBezier: CubicBezierValue;
  shadow: readonly ShadowLayer[];
}

export type TokenType = keyof ValueByType;
export type RawValue = ValueByType[TokenType];
/** What a token holds in one mode: a literal of its type, or an alias. */
export type TokenValue = RawValue | Alias;

export function isAlias(value: unknown): value is Alias {
  return typeof value === "string" && /^\{[^{}]+\}$/.test(value);
}

export function aliasTarget(alias: Alias): string {
  return alias.slice(1, -1);
}

export function aliasTo(path: string): Alias {
  return `{${path}}`;
}

// ---------------------------------------------------------------------------------------------
// Modes

/** One mode axis: a token varies along at most one of them. */
export interface Axis {
  readonly name: string;
  /** The HTML attribute that selects a mode at run time. */
  readonly attribute: string;
  readonly modes: readonly string[];
  /** The mode `:root` gets (from the theme's seeds). */
  readonly default: string;
  /** Extra selectors per mode (the `.dark` class shadcn uses). */
  readonly selectors?: Readonly<Record<string, readonly string[]>>;
  /** Modes that set the CSS `color-scheme` property. */
  readonly colorScheme?: Readonly<Record<string, "light" | "dark">>;
}

/** One mode per axis, for example `{ theme: "dark", density: "compact" }`. */
export type ModeContext = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------------------------
// Tokens

export interface RampInfo {
  readonly name: string;
  readonly scheme: "light" | "dark";
  readonly step: number | "contrast";
  readonly alpha?: boolean;
}

export interface Token {
  /** Dot path, for example `color.bg.surface`. */
  readonly path: string;
  readonly type: TokenType;
  readonly tier: Tier;
  /** When to use the token and when not to. */
  readonly description: string;
  /** Unmoded value. Exactly one of `value` and `modes` is set. */
  readonly value?: TokenValue;
  /** The axis the token varies along, with one value for every mode of it. */
  readonly axis?: string;
  readonly modes?: Readonly<Record<string, TokenValue>>;
  /** Tailwind v4 theme variable that exposes the token as a utility, for example `--color-surface`. */
  readonly tailwind?: string;
  /** Set on generated ramp steps. */
  readonly ramp?: RampInfo;
  /** True when the theme's `overrides` changed the token. */
  readonly overridden?: boolean;
}

/** Two roles that are used together and must contrast. */
export interface ContrastPair {
  /** The foreground role (text, icon, border, ring). */
  readonly fg: string;
  /** The background role. */
  readonly bg: string;
  /** What a translucent `bg` (or `fg`) is painted over. Defaults to `color.bg.canvas`. */
  readonly over?: string;
  /** `text`: WCAG 1.4.3. `ui`: WCAG 1.4.11 (non-text). */
  readonly kind: ContrastKind;
}

export interface ContrastTargets {
  readonly level: "AA" | "AAA";
  /** WCAG 2.x ratios. */
  readonly text: number;
  readonly ui: number;
  /** Optional APCA minimums (absolute Lc); unset means APCA is reported but not enforced. */
  readonly apca?: { readonly text?: number; readonly ui?: number };
}

export interface TokenSet {
  /** Theme name. */
  readonly name: string;
  readonly description?: string;
  readonly axes: readonly Axis[];
  /** In output order: primitives first, then semantic, then component. */
  readonly tokens: ReadonlyMap<string, Token>;
  readonly pairs: readonly ContrastPair[];
  readonly contrast: ContrastTargets;
  /** shadcn/ui variable name -> token path. */
  readonly shadcn: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------------------------
// Theme file

export interface NeutralSeed extends Omit<RampSeed, "hue"> {
  /** Omit to follow the brand hue. */
  readonly hue?: number;
}

export interface Seeds {
  /**
   * One ramp per entry. `brand` and `neutral` are required by the catalogue; the built-in status
   * ramps (`red`, `amber`, `green`, `blue`) are filled in when a theme leaves them out.
   */
  readonly colors: Readonly<Record<string, RampSeed | NeutralSeed>>;
  /** Corner radius of a medium control, in px. */
  readonly radius: number;
  /** The colour scheme `:root` gets. */
  readonly colorScheme: "light" | "dark";
  /** The density `:root` gets. */
  readonly density: "comfortable" | "compact";
  readonly contrast: {
    readonly level: "AA" | "AAA";
    readonly apca?: { readonly text?: number; readonly ui?: number };
  };
}

/** Everything in a theme's `seeds` is optional; missing seeds take the default. */
export interface SeedsInput {
  readonly colors?: Readonly<Record<string, Partial<RampSeed>>>;
  readonly radius?: number;
  readonly colorScheme?: "light" | "dark";
  readonly density?: "comfortable" | "compact";
  readonly contrast?: {
    readonly level?: "AA" | "AAA";
    readonly apca?: { readonly text?: number; readonly ui?: number };
  };
}

/**
 * An override: a value for every mode (an alias such as `{color.brand.11}`, or a literal such as
 * `oklch(0.5 0.1 230)`, `#0a7ea4`, `12px`, `["Inter", "sans-serif"]`), or an object keyed by mode
 * name (`{ "dark": "{color.neutral-dark.4}" }`) to change some modes only.
 */
export type OverrideInput = unknown;

/** A theme: plain data, seeds plus overrides. */
export interface ThemeFile {
  readonly $schema?: string;
  readonly schemaVersion: number;
  readonly name: string;
  readonly description?: string;
  readonly seeds?: SeedsInput;
  readonly overrides?: Readonly<Record<string, OverrideInput>>;
}

// ---------------------------------------------------------------------------------------------
// Diagnostics

export type Severity = "error" | "warning";

export interface Fix {
  /** One sentence: what to change. */
  readonly summary: string;
  /** Ready to merge into the theme file's `overrides`. */
  readonly overrides?: Readonly<Record<string, unknown>>;
  /** Ready to merge into the theme file's `seeds`. */
  readonly seeds?: unknown;
  /** Other ways to fix it. */
  readonly alternatives?: readonly { readonly summary: string; readonly overrides?: Readonly<Record<string, unknown>> }[];
}

/** A structured, actionable finding. `rule` is a stable identifier. */
export interface Diagnostic {
  readonly severity: Severity;
  readonly rule: string;
  readonly message: string;
  /** The token the finding is about (dot path). */
  readonly token?: string;
  /** The other token involved (the background of a contrast pair, the target of an alias). */
  readonly related?: string;
  /** The modes it was measured in, for example `{ theme: "dark" }`. */
  readonly mode?: ModeContext;
  readonly measured?: number | string;
  readonly required?: number | string;
  readonly fix?: Fix;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
