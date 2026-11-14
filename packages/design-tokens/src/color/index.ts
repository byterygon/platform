/**
 * The colour module: OKLCH conversions, sRGB gamut mapping, WCAG and APCA contrast, the lightness
 * solver and the seed-to-ramp generator. Pure TypeScript with no imports outside this folder, so
 * it loads in a browser as it is (Theme Studio uses it for live preview).
 */
export {
  type Oklch,
  type Rgb,
  clampRgb,
  hexToRgb,
  linearToSrgb,
  oklchToSrgb,
  quantizeRgb,
  rgbToHex,
  srgbToLinear,
  srgbToOklch,
} from "./convert.js";
export { type GamutMapped, gamutMapSrgb, inSrgbGamut, maxChroma, toDisplayRgb } from "./gamut.js";
export { alphaOver, apcaContrast, compositeOver, relativeLuminance, wcagContrast } from "./contrast.js";
export { formatOklch, oklchToDisplayRgb, oklchToHex, parseColor, roundOklch } from "./css.js";
export {
  type SolveOptions,
  type SolveResult,
  minContrast,
  nearestPassingLightness,
  settle,
  solveLightness,
} from "./solve.js";
export {
  type ContrastKind,
  type ContrastThresholds,
  type Ramp,
  type RampOptions,
  type RampRecipe,
  type RampSeed,
  type RampStep,
  type RampWarning,
  type Scheme,
  type SchemeRecipe,
  type StepRecipe,
  DEFAULT_RECIPE,
  WCAG_AA,
  WCAG_AAA,
  generateRamp,
} from "./ramp.js";
