// @ts-check
/**
 * @byterygon/lint: the design-token guardrails (spec section 9a.4) as an ESLint plugin
 * (`@byterygon/lint/eslint`), a Stylelint plugin (`@byterygon/lint/stylelint`, recommended config
 * `@byterygon/lint/stylelint-config`) and the analysis they share, exported here.
 */
export { buildCatalog, loadCatalog, tailwindPalette } from "./catalog.js";
export { analyzeClass, classesIn, nearestLengths, splitClass } from "./classes.js";
export { findRawColors, nearestColors, parseCssColor } from "./colors.js";
