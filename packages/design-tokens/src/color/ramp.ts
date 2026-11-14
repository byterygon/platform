/**
 * Seed-to-ramp generator: one hue and one chroma become twelve OKLCH steps per colour scheme,
 * following the Radix model in which every step has a fixed job.
 *
 * Lightness comes from a per-scheme recipe, chroma is the seed chroma scaled per step and then
 * mapped into sRGB, and the steps whose job is a contrast promise (8, 9, 10, 11) are moved by
 * the solver until the promise holds. The recipe is data: changing the curve never touches the
 * generator.
 */
import { type Oklch, type Rgb, srgbToOklch } from "./convert.js";
import { alphaOver, wcagContrast } from "./contrast.js";
import { oklchToDisplayRgb, oklchToHex, roundOklch } from "./css.js";
import { gamutMapSrgb } from "./gamut.js";
import { settle, solveLightness } from "./solve.js";

export type Scheme = "light" | "dark";

/** The seed of one ramp. */
export interface RampSeed {
  /** OKLCH hue in degrees. */
  readonly hue: number;
  /** Peak chroma (the chroma of the solid step, before gamut mapping). */
  readonly chroma: number;
  /** Optional lightness of the solid step (step 9) per scheme; the recipe decides when omitted. */
  readonly solid?: { readonly light?: number; readonly dark?: number };
}

export type ContrastKind = "text" | "ui";

export interface StepRecipe {
  /** Preferred lightness. */
  readonly l: number;
  /** Fraction of the seed chroma. */
  readonly c: number;
  /** What the step is for (becomes part of the token description). */
  readonly job: string;
  /**
   * A contrast promise: the step must reach the `kind` threshold against these steps of its own
   * ramp and of the reference (neutral) ramp. Lightness moves away from the background until it does.
   */
  readonly solve?: { readonly against: readonly number[]; readonly kind: ContrastKind };
}

export interface SchemeRecipe {
  /** Twelve steps, index 0 is step 1. Steps 9 and 10 are the solids (see `generateRamp`). */
  readonly steps: readonly StepRecipe[];
  /** Lightness distance between the solid (9) and its hover state (10). */
  readonly solidHoverDelta: number;
  /** The dark candidate for text on the solid: lightness, and chroma as a cap. */
  readonly ink: { readonly l: number; readonly c: number };
  /** What alpha variants are computed over: white, or a step of the reference ramp. */
  readonly alphaBackdrop: "white" | number;
}

export type RampRecipe = Readonly<Record<Scheme, SchemeRecipe>>;

/** Contrast thresholds (WCAG 2.x ratios) the solved steps must reach. */
export interface ContrastThresholds {
  readonly text: number;
  readonly ui: number;
}

export const WCAG_AA: ContrastThresholds = { text: 4.5, ui: 3 };
export const WCAG_AAA: ContrastThresholds = { text: 7, ui: 4.5 };

/**
 * The default recipe. Step jobs follow Radix: 1-2 app and subtle backgrounds, 3-5 component
 * backgrounds (rest, hover, pressed), 6-8 borders, 9-10 solids, 11-12 text. Two deliberate
 * differences from Radix: step 8 is solved to 3:1 so a strong border passes WCAG 1.4.11, and the
 * solid is solved to 4.5:1 against its text colour so a filled button passes WCAG 1.4.3.
 */
export const DEFAULT_RECIPE: RampRecipe = {
  light: {
    steps: [
      { l: 0.99, c: 0.03, job: "app background" },
      { l: 0.975, c: 0.07, job: "subtle background (sidebars, stripes, code blocks)" },
      { l: 0.955, c: 0.14, job: "component background at rest; recessed wells" },
      { l: 0.93, c: 0.22, job: "component background, hovered" },
      { l: 0.9, c: 0.31, job: "component background, pressed or selected" },
      { l: 0.875, c: 0.4, job: "subtle borders and separators" },
      { l: 0.8, c: 0.52, job: "borders of non-essential outlines (below 3:1)" },
      {
        l: 0.66,
        c: 0.7,
        job: "strong borders that identify a control; at least 3:1 against steps 1-3",
        solve: { against: [1, 2, 3], kind: "ui" },
      },
      { l: 0.55, c: 1, job: "solid background (filled buttons, badges); text on it uses the ramp's contrast colour" },
      { l: 0.505, c: 1, job: "solid background, hovered" },
      {
        l: 0.46,
        c: 0.85,
        job: "low-contrast text, links and icons; pressed solid; at least 4.5:1 against steps 1-5",
        solve: { against: [1, 2, 3, 4, 5], kind: "text" },
      },
      { l: 0.22, c: 0.45, job: "high-contrast text" },
    ],
    solidHoverDelta: 0.045,
    ink: { l: 0.16, c: 0.03 },
    alphaBackdrop: "white",
  },
  dark: {
    steps: [
      { l: 0.14, c: 0.1, job: "recessed background (wells, insets), darker than the app background" },
      { l: 0.17, c: 0.12, job: "app background" },
      { l: 0.21, c: 0.2, job: "component background at rest; surfaces" },
      { l: 0.25, c: 0.3, job: "component background, hovered; raised surfaces" },
      { l: 0.28, c: 0.38, job: "component background, pressed or selected; overlays" },
      { l: 0.32, c: 0.45, job: "subtle borders and separators" },
      { l: 0.4, c: 0.55, job: "borders of non-essential outlines (below 3:1)" },
      {
        l: 0.52,
        c: 0.7,
        job: "strong borders that identify a control; at least 3:1 against steps 1-5",
        solve: { against: [1, 2, 3, 4, 5], kind: "ui" },
      },
      { l: 0.72, c: 1, job: "solid background (filled buttons, badges); text on it uses the ramp's contrast colour" },
      { l: 0.77, c: 0.9, job: "solid background, hovered" },
      {
        l: 0.82,
        c: 0.7,
        job: "low-contrast text, links and icons; pressed solid; at least 4.5:1 against steps 1-5",
        solve: { against: [1, 2, 3, 4, 5], kind: "text" },
      },
      { l: 0.955, c: 0.25, job: "high-contrast text" },
    ],
    solidHoverDelta: 0.05,
    ink: { l: 0.16, c: 0.03 },
    alphaBackdrop: 2,
  },
};

export interface RampStep {
  /** 1..12. */
  readonly step: number;
  /** The colour as stored: inside sRGB, at token precision. */
  readonly color: Oklch;
  /** `#rrggbb` of `color`. */
  readonly hex: string;
  /** The translucent colour that shows as `color` over the scheme's backdrop. */
  readonly alpha: Oklch;
  readonly job: string;
  /** True when chroma was reduced to fit sRGB. */
  readonly gamutMapped: boolean;
  /** The chroma the recipe asked for. */
  readonly requestedChroma: number;
  /** True when the solver moved lightness away from the recipe's preference. */
  readonly solved: boolean;
}

export interface RampWarning {
  readonly step: number;
  readonly kind: "gamut" | "unreachable";
  readonly message: string;
  readonly measured?: number;
  readonly required?: number;
}

export interface Ramp {
  readonly scheme: Scheme;
  readonly seed: RampSeed;
  /** Twelve steps, index 0 is step 1. */
  readonly steps: readonly RampStep[];
  /** The text colour for the solids (steps 9 and 10): white or a near-black ink, whichever contrasts more. */
  readonly contrast: Oklch;
  readonly contrastHex: string;
  readonly contrastIs: "white" | "ink";
  readonly warnings: readonly RampWarning[];
}

export interface RampOptions {
  readonly recipe?: RampRecipe;
  readonly thresholds?: ContrastThresholds;
  /**
   * The neutral ramp of the same scheme. Solved steps are also checked against its steps (a brand
   * text colour sits on neutral backgrounds), and it supplies the alpha backdrop.
   */
  readonly reference?: Ramp;
}

/** Chroma lost to gamut mapping on the solid before the generator warns about it. */
const GAMUT_NOTICE = 0.03;

const WHITE: Oklch = { l: 1, c: 0, h: 0 };
const WHITE_RGB: Rgb = { r: 1, g: 1, b: 1 };

export function generateRamp(seed: RampSeed, scheme: Scheme, options: RampOptions = {}): Ramp {
  const recipe = (options.recipe ?? DEFAULT_RECIPE)[scheme];
  const thresholds = options.thresholds ?? WCAG_AA;
  const reference = options.reference;
  const warnings: RampWarning[] = [];
  const away = scheme === "light" ? -1 : 1;

  if (recipe.steps.length !== 12) throw new Error(`ramp recipe for ${scheme} must have 12 steps`);

  const requested = recipe.steps.map((step, index): Oklch => {
    const solid = index === 8 ? seed.solid?.[scheme] : undefined;
    return { l: solid ?? step.l, c: seed.chroma * step.c, h: seed.hue };
  });
  const colors: Oklch[] = requested.map((color) => settle(color));
  const solved: boolean[] = requested.map(() => false);
  const rgbOf = (color: Oklch) => oklchToDisplayRgb(color);

  // The solid (9), its text colour, and its hover state (10).
  const ink = settle({ l: recipe.ink.l, c: Math.min(recipe.ink.c, seed.chroma * 0.25), h: seed.hue });
  const solidStart = colors[8]!;
  const contrastIs: "white" | "ink" =
    wcagContrast(WHITE_RGB, rgbOf(solidStart)) >= wcagContrast(rgbOf(ink), rgbOf(solidStart)) ? "white" : "ink";
  const contrast = contrastIs === "white" ? WHITE : ink;
  const solidDirection = contrastIs === "white" ? -1 : 1;
  const solid = solveLightness({
    color: requested[8]!,
    against: [rgbOf(contrast)],
    ratio: thresholds.text,
    direction: solidDirection,
  });
  colors[8] = solid.color;
  solved[8] = solid.moved;
  if (!solid.reached) {
    warnings.push({
      step: 9,
      kind: "unreachable",
      message: `solid cannot reach ${thresholds.text}:1 against its ${contrastIs} text colour`,
      measured: solid.ratio,
      required: thresholds.text,
    });
  }
  const hoverLightness = Math.min(1, Math.max(0, solid.color.l + solidDirection * recipe.solidHoverDelta));
  requested[9] = { l: hoverLightness, c: seed.chroma * recipe.steps[9]!.c, h: seed.hue };
  colors[9] = settle(requested[9]);
  solved[9] = solid.moved || seed.solid?.[scheme] !== undefined;

  // Steps whose job is a contrast promise.
  recipe.steps.forEach((step, index) => {
    if (!step.solve || index === 8 || index === 9) return;
    const against: Rgb[] = [];
    for (const target of step.solve.against) {
      against.push(rgbOf(colors[target - 1]!));
      const other = reference?.steps[target - 1];
      if (other) against.push(rgbOf(other.color));
    }
    if (scheme === "light") against.push(WHITE_RGB);
    const ratio = thresholds[step.solve.kind];
    const result = solveLightness({ color: requested[index]!, against, ratio, direction: away });
    colors[index] = result.color;
    solved[index] = result.moved;
    if (!result.reached) {
      warnings.push({
        step: index + 1,
        kind: "unreachable",
        message: `step ${index + 1} cannot reach ${ratio}:1 against steps ${step.solve.against.join(", ")}`,
        measured: result.ratio,
        required: ratio,
      });
    }
  });

  // Only the seed colour itself is worth a gamut warning: light and dark steps are expected to
  // lose chroma, the solid is where the seed is supposed to show as asked. Below GAMUT_NOTICE the
  // loss is too small to see next to the requested colour.
  const solidMapped = gamutMapSrgb({ ...requested[8]!, l: colors[8]!.l });
  if (solidMapped.mapped && solidMapped.requestedChroma - solidMapped.color.c > GAMUT_NOTICE) {
    warnings.push({
      step: 9,
      kind: "gamut",
      message: `chroma ${round4(solidMapped.requestedChroma)} is outside sRGB at lightness ${colors[8]!.l} and hue ${seed.hue}; reduced to ${round4(solidMapped.color.c)}`,
      measured: round4(solidMapped.color.c),
      required: round4(solidMapped.requestedChroma),
    });
  }

  const backdrop: Rgb =
    recipe.alphaBackdrop === "white"
      ? WHITE_RGB
      : rgbOf((reference?.steps[recipe.alphaBackdrop - 1]?.color ?? colors[recipe.alphaBackdrop - 1])!);

  const steps = colors.map((color, index): RampStep => {
    const want = requested[index]!;
    const translucent = alphaOver(rgbOf(color), backdrop);
    return {
      step: index + 1,
      color,
      hex: oklchToHex(color),
      alpha: roundOklch({ ...srgbToOklch(translucent), alpha: translucent.alpha ?? 1 }),
      job: recipe.steps[index]!.job,
      gamutMapped: want.c - color.c > 0.0002,
      requestedChroma: round4(want.c),
      solved: solved[index]!,
    };
  });

  return { scheme, seed, steps, contrast, contrastHex: oklchToHex(contrast), contrastIs, warnings };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
