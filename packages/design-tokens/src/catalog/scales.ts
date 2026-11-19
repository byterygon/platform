/**
 * Primitive scales that are not colours (spec "Byterygon UI", section 3, primitive tier): the
 * 4 px space scale, the type scale, icon sizes, border widths, opacity, layering and motion.
 *
 * Roles (`space.inline.*`, `text.*`, `elevation.*`) point at these; components use the roles.
 * A few have a Tailwind variable because Tailwind has no role to ask for (`--spacing`, icon
 * sizes, easing curves); the rest are reached through a role.
 */
import type { CubicBezierValue, DurationValue } from "../model.js";
import { type RoleDef, px, ref } from "./authoring.js";

const REFERENCE = "Primitive: reference it through a role, never from a component.";

/** `space.<name>`: the 4 px unit scale. A half step is written `0-5`, a path segment cannot hold a dot. */
const SPACE: readonly (readonly [string, number])[] = [
  ["0", 0],
  ["0-5", 2],
  ["1", 4],
  ["1-5", 6],
  ["2", 8],
  ["3", 12],
  ["4", 16],
  ["5", 20],
  ["6", 24],
  ["8", 32],
  ["10", 40],
  ["12", 48],
  ["16", 64],
  ["20", 80],
  ["24", 96],
];

const space: RoleDef[] = SPACE.map(([name, value]): RoleDef => ({
  path: `space.${name}`,
  type: "dimension",
  tier: "primitive",
  value: px(value),
  ...(name === "1" ? { tailwind: "--spacing" } : {}),
  use: `${value} px on the 4 px space scale. ${REFERENCE}`,
  avoid: "Not for a density-aware gap: use space.inline, space.stack, space.inset or space.gap, which change with the density mode.",
}));

/**
 * The legacy type scale: steps and how far each sits from the body size (the `fontSize` seed).
 * Kept because the spec names it and themes may alias it (Paper's relaxed body leading is a
 * `font.leading.*` step); the text roles use Fluent's ramp below (TSK-57).
 */
const FONT_SIZES: readonly (readonly [string, number])[] = [
  ["2xs", -3],
  ["xs", -2],
  ["sm", -1],
  ["base", 0],
  ["lg", 2],
  ["xl", 4],
  ["2xl", 6],
  ["3xl", 10],
  ["4xl", 16],
];

const fontSize: RoleDef[] = FONT_SIZES.map(([name, offset]): RoleDef => ({
  path: `font.size.${name}`,
  type: "dimension",
  tier: "primitive",
  value: (seeds) => px(Math.max(10, seeds.fontSize + offset)),
  use: `The ${name} step of the legacy type scale, derived from the fontSize seed (the base step is the body size). ${REFERENCE}`,
  avoid: "Not for a new role: the text roles use Fluent's ramp (font.size.100 to font.size.1000); not for a one-off size: pick the text role (text.body-1, text.subtitle-2) that has it.",
}));

/**
 * Fluent 2's type ramp, from `@fluentui/tokens` 1.0.0-alpha.24 (MIT; `fontSizes` and
 * `lineHeights` in lib/global/fonts.js): step, font size and line height in px at Fluent's body
 * size, 14 px (`fontSizeBase300`). Steps 100 to 600 are Fluent's Base sizes, 700 to 1000 its Hero
 * sizes.
 */
export const FLUENT_RAMP: readonly (readonly [step: string, size: number, lineHeight: number])[] = [
  ["100", 10, 14],
  ["200", 12, 16],
  ["300", 14, 20],
  ["400", 16, 22],
  ["500", 20, 28],
  ["600", 24, 32],
  ["700", 28, 36],
  ["800", 32, 40],
  ["900", 40, 52],
  ["1000", 68, 92],
];
const FLUENT_BODY = 14;

/**
 * How `seeds.fontSize` drives Fluent's ramp: it is the size of step 300 (body-1). Every step is
 * Fluent's size times fontSize / 14, rounded to a whole px (at least 10), and its line height is
 * that size times Fluent's ratio for the step, rounded to a whole px. At 14 every value is
 * Fluent's exactly; at 13 the ramp is 10, 11, 13, 15, 19, 22, 26, 30, 37, 63.
 */
export function fluentStep(fontSizeSeed: number, step: string): { size: number; lineHeight: number } {
  const entry = FLUENT_RAMP.find(([name]) => name === step);
  if (!entry) throw new Error(`unknown Fluent type ramp step ${step}`);
  const [, size, lineHeight] = entry;
  const scaled = Math.max(10, Math.round((size * fontSizeSeed) / FLUENT_BODY));
  return { size: scaled, lineHeight: Math.round((scaled * lineHeight) / size) };
}

const fluentSize: RoleDef[] = FLUENT_RAMP.map(([step, size, lineHeight]): RoleDef => ({
  path: `font.size.${step}`,
  type: "dimension",
  tier: "primitive",
  value: (seeds) => px(fluentStep(seeds.fontSize, step).size),
  use: `Step ${step} of Fluent 2's type ramp: ${size} px at the default body size (line height ${lineHeight} px), scaled by the fontSize seed. ${REFERENCE}`,
  avoid: "Not for a one-off size: pick the text role (text.body-1, text.caption-1, text.title-3) that has it.",
}));

/** Unitless, so `calc(lines * size * leading)` and Monaco's metrics keep working. */
const fluentLeading: RoleDef[] = FLUENT_RAMP.map(([step, size, lineHeight]): RoleDef => ({
  path: `font.leading.${step}`,
  type: "number",
  tier: "primitive",
  value: (seeds) => {
    const scaled = fluentStep(seeds.fontSize, step);
    return Math.round((scaled.lineHeight / scaled.size) * 10000) / 10000;
  },
  use: `Unitless line height of step ${step} of Fluent 2's type ramp (${lineHeight} px on ${size} px at the default body size, kept a whole px when the fontSize seed scales it). ${REFERENCE}`,
  avoid: "Not with another step's font size: the ratio only gives Fluent's line height on its own step (font.size.<same step>).",
}));

const WEIGHTS: readonly (readonly [string, number])[] = [
  ["regular", 400],
  ["medium", 500],
  ["semibold", 600],
  ["bold", 700],
];
const fontWeight: RoleDef[] = WEIGHTS.map(([name, value]): RoleDef => ({
  path: `font.weight.${name}`,
  type: "fontWeight",
  tier: "primitive",
  value,
  use: `Font weight ${value} (${name}). ${REFERENCE}`,
  avoid: "Not a way to emphasise inside a role: use text.body-strong or text.label.",
}));

const LEADINGS: readonly (readonly [string, number, string])[] = [
  ["tight", 1.2, "large headings and display text"],
  ["snug", 1.35, "headings, labels and captions"],
  ["normal", 1.5, "body text and code"],
  ["relaxed", 1.65, "long-form reading text"],
];
const fontLeading: RoleDef[] = LEADINGS.map(([name, value, fit]): RoleDef => ({
  path: `font.leading.${name}`,
  type: "number",
  tier: "primitive",
  value,
  use: `Unitless line height ${value}, for ${fit}. ${REFERENCE}`,
  avoid: "Not a fixed pixel line height: it must scale with the font size.",
}));

/** Letter spacing is a px dimension: DTCG dimensions have no em, and each text role has one size. */
const TRACKINGS: readonly (readonly [string, number, string])[] = [
  ["tight", -0.3, "large headings, where the glyphs look loose"],
  ["normal", 0, "everything else"],
  ["wide", 0.4, "small capitals and overlines"],
];
const fontTracking: RoleDef[] = TRACKINGS.map(([name, value, fit]): RoleDef => ({
  path: `font.tracking.${name}`,
  type: "dimension",
  tier: "primitive",
  value: px(value),
  use: `Letter spacing of ${value} px, for ${fit}. ${REFERENCE}`,
  avoid: "Not for body text: tracking out lowercase text hurts reading.",
}));

const ICONS: readonly (readonly [string, number])[] = [
  ["xs", 12],
  ["sm", 14],
  ["md", 16],
  ["lg", 20],
  // Fluent's three drawing sizes are 16, 20 and 24: xl is the 24 px artwork at its own size (TSK-57).
  ["xl", 24],
];
const iconSize: RoleDef[] = ICONS.map(([name, value]): RoleDef => ({
  path: `size.icon.${name}`,
  type: "dimension",
  tier: "primitive",
  value: px(value),
  tailwind: `--spacing-icon-${name}`,
  use: `Edge of a ${name} icon (${value} px): the size-icon-${name} utility.`,
  avoid: "Not for the size of a control: use size.control.*, which follows the density mode.",
}));

const trackSize: RoleDef[] = [
  {
    path: "size.track",
    type: "dimension",
    tier: "primitive",
    value: px(4),
    tailwind: "--spacing-track",
    use: "Thickness of a slider track or a thin progress bar (4 px): the h-track (w-track when vertical) utility.",
    avoid: "Not for borders or dividers: use border.width.*; not for a control or an icon: use size.control.* or size.icon.*.",
  },
];

/**
 * Widths of floating and side panels. Fixed px, not density-aware: a panel holds text that wraps,
 * and the compact density shrinks its controls and gaps, not the reading measure.
 */
const PANELS: readonly (readonly [string, number, string])[] = [
  ["xs", 240, "a tooltip's maximum width, a sidebar"],
  ["sm", 320, "a popover, a hover card, a toast"],
  ["md", 448, "a dialog or an alert dialog, a side sheet"],
  ["lg", 576, "a wide dialog, the command palette"],
  ["xl", 768, "a dialog that holds a table or a form in two columns"],
];
const panelSize: RoleDef[] = PANELS.map(([name, value, fit]): RoleDef => ({
  path: `size.panel.${name}`,
  type: "dimension",
  tier: "primitive",
  value: px(value),
  tailwind: `--spacing-panel-${name}`,
  use: `Width of a ${name} panel (${value} px), for ${fit}: the w-panel-${name} and max-w-panel-${name} utilities.`,
  avoid: "Not for controls, gaps or page layout: use size.control.*, space.* or the layout of the page; not a minimum width, panels shrink on narrow viewports (max-w-full).",
}));

const borderWidth: RoleDef[] = [0, 1, 2, 3].map((value): RoleDef => ({
  path: `border.width.${value}`,
  type: "dimension",
  tier: "primitive",
  value: px(value),
  use: value === 3 ? `A 3 px stroke: Fluent's strokeWidthThicker, the selected tab's indicator. ${REFERENCE}` : `A ${value} px border. ${REFERENCE}`,
  avoid: "Not for the focus ring: use ring.width.",
}));

const BREAKPOINTS: readonly (readonly [string, number])[] = [
  ["sm", 640],
  ["md", 768],
  ["lg", 1024],
  ["xl", 1280],
  ["2xl", 1536],
];
/** No Tailwind mapping: a media query cannot read a CSS variable, so Tailwind keeps its own. */
const breakpoint: RoleDef[] = BREAKPOINTS.map(([name, value]): RoleDef => ({
  path: `breakpoint.${name}`,
  type: "dimension",
  tier: "primitive",
  value: px(value),
  use: `Viewport width ${value} px at which layouts change (the ${name} breakpoint), for scripts and docs that need the number.`,
  avoid: "Not for CSS media queries: Tailwind's own breakpoint utilities (sm:, md:) cannot read a CSS variable.",
}));

const opacity: RoleDef[] = [
  { path: "opacity.disabled", value: 0.5, use: "Opacity of a disabled control that is dimmed instead of recoloured.", avoid: "Not for text colour: use color.fg.disabled." },
  { path: "opacity.hover", value: 0.08, use: "Opacity of a hover wash laid over an arbitrary image or colour.", avoid: "Not over ordinary surfaces: use color.interactive.hover." },
  { path: "opacity.overlay", value: 0.6, use: "Opacity of a veil over content that is loading or inert.", avoid: "Not for the dialog backdrop: use color.bg.scrim." },
].map(({ path, value, use, avoid }): RoleDef => ({ path, type: "number", tier: "primitive", value, use, avoid }));

const Z: readonly (readonly [string, number, string])[] = [
  ["base", 0, "ordinary content"],
  ["sticky", 100, "sticky headers and pinned columns"],
  ["dropdown", 200, "menus and select lists attached to a control"],
  ["overlay", 300, "the scrim behind a modal"],
  ["modal", 400, "dialogs and drawers"],
  ["popover", 500, "popovers that can open from inside a modal"],
  ["toast", 600, "toast notifications"],
  ["tooltip", 700, "tooltips, always on top"],
];
const zIndex: RoleDef[] = Z.map(([name, value, fit]): RoleDef => ({
  path: `z.${name}`,
  type: "number",
  tier: "primitive",
  value,
  use: `Layer ${value} for ${fit}. Use it as z-index: var(--by-z-${name}).`,
  avoid: "Not an arbitrary z-index: every layered element takes one of these, so layers stay in a known order.",
}));

/**
 * Fluent 2's durations, from `@fluentui/tokens` 1.0.0-alpha.24 (`durations` in
 * lib/global/durations.js), plus `instant` (0 ms, for reduced motion and drag) and `base`, an
 * alias kept from before TSK-57 (semantic: a primitive holds a literal). `fast` and `slow` are
 * Fluent's names, so they take Fluent's values (100 to 150 ms, 240 to 300 ms); `faster` is the
 * old `fast`.
 */
const DURATIONS: readonly (readonly [string, number, string])[] = [
  ["instant", 0, "changes that must not animate (reduced motion, drag following the pointer)"],
  ["ultra-fast", 50, "the smallest feedback: a press, a check mark, a colour change under the pointer"],
  ["faster", 100, "hover and focus feedback, small toggles"],
  ["fast", 150, "small elements that appear or change: tooltips, badges, a switch thumb"],
  ["normal", 200, "menus, popovers, fades and most transitions"],
  ["gentle", 250, "dialogs and medium elements entering or leaving"],
  ["slow", 300, "drawers, sheets and large elements; the period unit of looping indicators"],
  ["slower", 400, "full-width panels and layout changes"],
  ["ultra-slow", 500, "page-sized transitions that must be followed by the eye"],
];
const duration: RoleDef[] = [
  ...DURATIONS.map(([name, value, fit]): RoleDef => ({
    path: `motion.duration.${name}`,
    type: "duration",
    tier: "primitive",
    value: { value, unit: "ms" } satisfies DurationValue,
    use: `${value} ms${name === "instant" ? "" : ` (Fluent's duration ${name})`}, for ${fit}. ${REFERENCE}`,
    avoid: "Not a longer step for a small element: larger elements take longer, small ones stay short; and not when the user prefers reduced motion: switch to motion.duration.instant.",
  })),
  {
    path: "motion.duration.base",
    type: "duration",
    value: ref("motion.duration.normal"),
    use: "Alias of motion.duration.normal (200 ms; 160 ms before TSK-57), kept so code written against the first motion scale keeps working.",
    avoid: "Not in new code: use motion.duration.normal.",
  },
];

/**
 * Fluent 2's curves, from `@fluentui/tokens` 1.0.0-alpha.24 (`curves` in lib/global/curves.js).
 * Fluent's guidance: ease-out (decelerate) for what enters, ease-in (accelerate) for what leaves,
 * ease-in-out (easy ease) for what moves between two places, linear only for a constant rate.
 */
const EASINGS: readonly (readonly [string, CubicBezierValue, string])[] = [
  ["accelerate-max", [0.9, 0.1, 1, 0.2], "large elements that leave fast and far (a drawer closing)"],
  ["accelerate-mid", [1, 0, 1, 1], "elements that leave the screen or close: they start slowly and speed up"],
  ["accelerate-min", [0.8, 0, 0.78, 1], "small elements that leave: a gentler ease-in"],
  ["decelerate-max", [0.1, 0.9, 0.2, 1], "large elements that enter from far away (a drawer opening)"],
  ["decelerate-mid", [0, 0, 0, 1], "elements that enter the screen or open: they start fast and settle"],
  ["decelerate-min", [0.33, 0, 0.1, 1], "small elements that enter: a gentler ease-out"],
  ["easy-ease-max", [0.8, 0, 0.2, 1], "large movements between two places that should draw the eye"],
  ["easy-ease", [0.33, 0, 0.67, 1], "elements that move or change between two resting states"],
  ["linear", [0, 0, 1, 1], "a constant rate: rotation, a progress loop"],
];
/** The first curves, kept as semantic aliases of the Fluent curve with the same job (a primitive holds a literal). */
const EASING_ALIASES: readonly (readonly [string, string])[] = [
  ["standard", "easy-ease"],
  ["enter", "decelerate-mid"],
  ["exit", "accelerate-mid"],
  ["emphasized", "easy-ease-max"],
];
const easing: RoleDef[] = [
  ...EASINGS.map(([name, value, fit]): RoleDef => ({
    path: `motion.easing.${name}`,
    type: "cubicBezier",
    tier: "primitive",
    value,
    // Tailwind's own ease-linear is the same curve; a --ease-linear variable would clash with it.
    ...(name === "linear" ? {} : { tailwind: `--ease-${name}` }),
    use: `Fluent's ${name} curve, for ${fit}.${name === "linear" ? " In classes, Tailwind's ease-linear." : ""}`,
    avoid: "Not a custom curve: pick a Fluent curve by what the element does (enters, leaves, moves), so the interface moves alike.",
  })),
  ...EASING_ALIASES.map(([name, target]): RoleDef => ({
    path: `motion.easing.${name}`,
    type: "cubicBezier",
    value: ref(`motion.easing.${target}`),
    tailwind: `--ease-${name}`,
    use: `Alias of motion.easing.${target}, kept from the first motion scale so code written against it keeps working.`,
    avoid: `Not in new code: use motion.easing.${target} (ease-${target}).`,
  })),
];

export const SCALE_ROLES: readonly RoleDef[] = [
  ...space,
  ...fontSize,
  ...fluentSize,
  ...fontWeight,
  ...fontLeading,
  ...fluentLeading,
  ...fontTracking,
  ...iconSize,
  ...trackSize,
  ...panelSize,
  ...borderWidth,
  ...breakpoint,
  ...opacity,
  ...zIndex,
  ...duration,
  ...easing,
];
