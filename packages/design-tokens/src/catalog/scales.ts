/**
 * Primitive scales that are not colours (spec "Byterygon UI", section 3, primitive tier): the
 * 4 px space scale, the type scale, icon sizes, border widths, opacity, layering and motion.
 *
 * Roles (`space.inline.*`, `text.*`, `elevation.*`) point at these; components use the roles.
 * A few have a Tailwind variable because Tailwind has no role to ask for (`--spacing`, icon
 * sizes, easing curves); the rest are reached through a role.
 */
import type { CubicBezierValue, DurationValue } from "../model.js";
import { type RoleDef, px } from "./authoring.js";

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

/** Type scale steps and how far each sits from the body size (the `fontSize` seed). */
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
  use: `The ${name} step of the type scale, derived from the fontSize seed (the base step is the body size). ${REFERENCE}`,
  avoid: "Not for a one-off size: pick the text role (text.body, text.label, text.heading-2) that has it.",
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

const borderWidth: RoleDef[] = [0, 1, 2].map((value): RoleDef => ({
  path: `border.width.${value}`,
  type: "dimension",
  tier: "primitive",
  value: px(value),
  use: `A ${value} px border. ${REFERENCE}`,
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

const DURATIONS: readonly (readonly [string, number, string])[] = [
  ["instant", 0, "changes that must not animate (reduced motion, drag following the pointer)"],
  ["fast", 100, "hover and focus feedback, small toggles"],
  ["base", 160, "menus, popovers, tooltips and most transitions"],
  ["slow", 240, "dialogs, drawers and layout changes"],
];
const duration: RoleDef[] = DURATIONS.map(([name, value, fit]): RoleDef => ({
  path: `motion.duration.${name}`,
  type: "duration",
  tier: "primitive",
  value: { value, unit: "ms" } satisfies DurationValue,
  use: `${value} ms, for ${fit}. ${REFERENCE}`,
  avoid: "Not above 240 ms for interface feedback, and not when the user prefers reduced motion: switch to motion.duration.instant.",
}));

const EASINGS: readonly (readonly [string, CubicBezierValue, string, string])[] = [
  ["standard", [0.2, 0, 0, 1], "elements that move or change between two resting states", "--ease-standard"],
  ["enter", [0.05, 0.7, 0.1, 1], "elements that appear: they start fast and settle", "--ease-enter"],
  ["exit", [0.3, 0, 0.8, 0.15], "elements that leave: they start slowly and speed up", "--ease-exit"],
  ["emphasized", [0.16, 1, 0.3, 1], "large movements that should draw the eye: drawers, dialogs", "--ease-emphasized"],
];
const easing: RoleDef[] = EASINGS.map(([name, value, fit, tailwind]): RoleDef => ({
  path: `motion.easing.${name}`,
  type: "cubicBezier",
  tier: "primitive",
  value,
  tailwind,
  use: `The ${name} curve, for ${fit}.`,
  avoid: "Not linear easing for movement, and not a custom curve: pick one of the four so the interface moves alike.",
}));

export const SCALE_ROLES: readonly RoleDef[] = [
  ...space,
  ...fontSize,
  ...fontWeight,
  ...fontLeading,
  ...fontTracking,
  ...iconSize,
  ...trackSize,
  ...borderWidth,
  ...breakpoint,
  ...opacity,
  ...zIndex,
  ...duration,
  ...easing,
];
