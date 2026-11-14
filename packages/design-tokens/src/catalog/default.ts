/**
 * The default catalogue (spec "Byterygon UI", section 3): the semantic roles, the contrast pairs
 * they must satisfy, and the shadcn alias table. This file holds the colour, shape and density
 * roles and puts the catalogue together; the rest is data in its own file:
 *
 *   scales.ts     primitive scales: space, type scale, icon size, border width, z, motion
 *   type.ts       text roles
 *   space.ts      density-aware space roles
 *   elevation.ts  shadow scale, elevation roles, focus ring
 *   domain.ts     syntax, editor, data type, grid, chart and diff tokens
 *
 * See AGENTS.md for how to add a role.
 */
import type { ShadowLayer } from "../model.js";
import { type Catalog, type RoleDef, byDensity, byTheme, layer, pairs, px, ramp, ref } from "./authoring.js";
import { DOMAIN_PAIRS, DOMAIN_ROLES } from "./domain.js";
import { ELEVATION_ROLES } from "./elevation.js";
import { SCALE_ROLES } from "./scales.js";
import { SPACE_ROLES } from "./space.js";
import { TEXT_ROLE_DEFS } from "./type.js";

const STATUS: readonly { name: string; ramp: string; meaning: string }[] = [
  { name: "danger", ramp: "red", meaning: "errors and destructive actions" },
  { name: "warning", ramp: "amber", meaning: "warnings that need attention but do not block" },
  { name: "success", ramp: "green", meaning: "success and completion" },
  { name: "info", ramp: "blue", meaning: "neutral information" },
];

const background: RoleDef[] = [
  {
    path: "color.bg.canvas",
    type: "color",
    value: ramp("neutral", 1, 2),
    tailwind: "--color-canvas",
    use: "The app background, behind every surface.",
    avoid: "Not for cards, panels or menus: use color.bg.surface, raised or overlay.",
  },
  {
    path: "color.bg.surface",
    type: "color",
    value: byTheme(ref("color.base.white"), ref("color.neutral-dark.3")),
    tailwind: "--color-surface",
    use: "Cards, panels, table bodies and inputs that sit on the canvas.",
    avoid: "Not for floating layers: use color.bg.raised (popovers, dropdowns) or color.bg.overlay (dialogs).",
  },
  {
    path: "color.bg.raised",
    type: "color",
    value: byTheme(ref("color.base.white"), ref("color.neutral-dark.4")),
    tailwind: "--color-raised",
    use: "Layers that float above a surface: popovers, dropdown menus, tooltips.",
    avoid: "Not for content that scrolls with the page: use color.bg.surface.",
  },
  {
    path: "color.bg.overlay",
    type: "color",
    value: byTheme(ref("color.base.white"), ref("color.neutral-dark.5")),
    tailwind: "--color-overlay",
    use: "The top layer: dialogs, drawers, command palettes.",
    avoid: "Not for the dimmed backdrop behind a dialog, and not for ordinary cards.",
  },
  {
    path: "color.bg.inset",
    type: "color",
    value: ramp("neutral", 3, 1),
    tailwind: "--color-inset",
    use: "Recessed areas inside a surface: wells, code blocks, secondary buttons, table headers.",
    avoid: "Not a hover state: use color.interactive.hover.",
  },
  {
    path: "color.bg.scrim",
    type: "color",
    value: byTheme(ref("color.black.a6"), ref("color.black.a8")),
    tailwind: "--color-scrim",
    use: "The translucent backdrop behind a modal dialog, a drawer or a sheet.",
    avoid: "Not a surface and not a hover wash: nothing is read on it. Use color.bg.overlay for the dialog itself.",
  },
];

const foreground: RoleDef[] = [
  {
    path: "color.fg.default",
    type: "color",
    value: ramp("neutral", 12),
    tailwind: "--color-fg",
    use: "Body text, headings and icons that carry meaning.",
    avoid: "Not for text on a solid accent background (use color.fg.on-accent) or a solid status background (use that status's solid-fg).",
  },
  {
    path: "color.fg.muted",
    type: "color",
    value: ramp("neutral", 11),
    tailwind: "--color-fg-muted",
    use: "Secondary text: labels, descriptions, captions, inactive tabs.",
    avoid: "Not for disabled content (use color.fg.disabled) and not for body text.",
  },
  {
    path: "color.fg.subtle",
    type: "color",
    value: ramp("neutral", 10),
    tailwind: "--color-fg-subtle",
    use: "Tertiary text: placeholders, hints, timestamps, decorative icons.",
    avoid: "Not for anything the user must read to complete a task: use color.fg.muted or default.",
  },
  {
    path: "color.fg.disabled",
    type: "color",
    value: ramp("neutral", 8),
    tailwind: "--color-fg-disabled",
    use: "Text and icons of disabled controls.",
    avoid: "Never for readable content: it is below text contrast on purpose (WCAG exempts disabled controls).",
  },
  {
    path: "color.fg.link",
    type: "color",
    value: ramp("brand", 11),
    tailwind: "--color-fg-link",
    use: "Hyperlinks and link-styled buttons in running text.",
    avoid: "Not for emphasis and not on a solid accent background.",
  },
  {
    path: "color.fg.on-accent",
    type: "color",
    value: ramp("brand", "contrast"),
    tailwind: "--color-fg-on-accent",
    use: "Text and icons on color.accent.bg and its hover and pressed colours.",
    avoid: "Not on a solid status background (use that status's solid-fg, which can differ) and not on neutral backgrounds (use color.fg.default).",
  },
];

const border: RoleDef[] = [
  {
    path: "color.border.muted",
    type: "color",
    value: ramp("neutral", 5),
    tailwind: "--color-border-muted",
    use: "The faintest separator: hairlines inside a dense list or between rows of a table.",
    avoid: "Not the outline of a card or a control: use color.border.default or color.border.strong.",
  },
  {
    path: "color.border.default",
    type: "color",
    value: ramp("neutral", 6),
    tailwind: "--color-border",
    use: "Separators and the outline of cards, panels and table cells.",
    avoid: "Not the only cue that identifies a control (it is below 3:1): use color.border.strong.",
  },
  {
    path: "color.border.strong",
    type: "color",
    value: ramp("neutral", 8),
    tailwind: "--color-border-strong",
    use: "The outline that identifies a control: inputs, checkboxes, outlined buttons (at least 3:1).",
    avoid: "Not for separators between content: use color.border.default.",
  },
  {
    path: "color.border.focus",
    type: "color",
    value: ref("color.ring"),
    tailwind: "--color-border-focus",
    use: "The border of a focused input, where the ring is drawn as the border itself.",
    avoid: "Not the outline drawn around a focused element: use ring.color with ring.width.",
  },
  {
    path: "color.ring",
    type: "color",
    value: ramp("brand", 9),
    tailwind: "--color-ring",
    use: "The focus ring of any focusable element.",
    avoid: "Not a decorative border and not a selection colour: use color.interactive.selected.",
  },
];

const accent: RoleDef[] = [
  {
    path: "color.accent.fg",
    type: "color",
    value: ramp("brand", "contrast"),
    tailwind: "--color-accent-fg",
    tailwindAliases: ["--color-accent-solid-fg"],
    use: "Text and icons on color.accent.bg and its hover and pressed colours (the same colour as color.fg.on-accent).",
    avoid: "Not on color.accent.subtle-bg: use color.accent.subtle-fg.",
  },
  {
    path: "color.accent.bg",
    type: "color",
    value: ramp("brand", 9),
    tailwind: "--color-accent",
    // shadcn/ui's `bg-accent` is a hover background (its --accent), so Byterygon components use
    // `bg-accent-solid`, and a project with stock shadcn components can keep shadcn's meaning.
    tailwindAliases: ["--color-accent-solid"],
    use: "The filled background of the primary action and of checked controls.",
    avoid: "Not for large areas, and not more than one primary action per view.",
  },
  {
    path: "color.accent.bg-hover",
    type: "color",
    value: ramp("brand", 10),
    tailwind: "--color-accent-hover",
    tailwindAliases: ["--color-accent-solid-hover"],
    use: "color.accent.bg while hovered.",
    avoid: "Not a resting colour.",
  },
  {
    path: "color.accent.bg-active",
    type: "color",
    value: ramp("brand", 11),
    tailwind: "--color-accent-active",
    tailwindAliases: ["--color-accent-solid-active"],
    use: "color.accent.bg while pressed.",
    avoid: "Not a resting colour.",
  },
  {
    path: "color.accent.subtle-bg",
    type: "color",
    value: ramp("brand", 3, 5),
    tailwind: "--color-accent-subtle",
    use: "A tinted background for accent badges, tags and highlighted callouts.",
    avoid: "Not for the selected row or item: use color.interactive.selected.",
  },
  {
    path: "color.accent.subtle-fg",
    type: "color",
    value: ramp("brand", 11),
    tailwind: "--color-accent-subtle-fg",
    use: "Text and icons on color.accent.subtle-bg.",
    avoid: "Not on color.accent.bg: use color.accent.fg.",
  },
];

/**
 * The neutral solids: a grey filled action for views where the accent is reserved for one thing.
 * The step mapping is the accent's; if a theme's solid is light enough to take dark text, the
 * pressed colour (step 11) goes the wrong way and the pair fails: apply the suggested override.
 */
const neutral: RoleDef[] = [
  {
    path: "color.neutral.bg",
    type: "color",
    value: ramp("neutral", 9),
    tailwind: "--color-neutral-solid",
    use: "The filled background of a neutral action: a secondary solid button, a neutral badge.",
    avoid: "Not for the primary action: use color.accent.bg. Not for cards: use color.bg.surface.",
  },
  {
    path: "color.neutral.bg-hover",
    type: "color",
    value: ramp("neutral", 10),
    tailwind: "--color-neutral-solid-hover",
    use: "color.neutral.bg while hovered.",
    avoid: "Not a resting colour.",
  },
  {
    path: "color.neutral.bg-active",
    type: "color",
    value: ramp("neutral", 11),
    tailwind: "--color-neutral-solid-active",
    use: "color.neutral.bg while pressed.",
    avoid: "Not a resting colour.",
  },
  {
    path: "color.neutral.fg",
    type: "color",
    value: ramp("neutral", "contrast"),
    tailwind: "--color-neutral-solid-fg",
    use: "Text and icons on color.neutral.bg and its hover and pressed colours.",
    avoid: "Not on a plain surface: use color.fg.default.",
  },
  {
    path: "color.neutral.subtle-bg",
    type: "color",
    value: ramp("neutral", 3, 5),
    tailwind: "--color-neutral-subtle",
    use: "A grey tinted background for neutral badges, tags and callouts.",
    avoid: "Not for a recessed area: use color.bg.inset.",
  },
  {
    path: "color.neutral.subtle-fg",
    type: "color",
    value: ramp("neutral", 11),
    tailwind: "--color-neutral-subtle-fg",
    use: "Text and icons on color.neutral.subtle-bg.",
    avoid: "Not on color.neutral.bg: use color.neutral.fg.",
  },
];

const interactive: RoleDef[] = [
  {
    path: "color.interactive.hover",
    type: "color",
    value: ramp("neutral", "a3", "a4"),
    tailwind: "--color-hover",
    use: "A translucent wash over any background for hovered rows, menu items and ghost buttons.",
    avoid: "Not for filled controls: use the role's own hover token (color.accent.bg-hover).",
  },
  {
    path: "color.interactive.active",
    type: "color",
    value: ramp("neutral", "a4", "a5"),
    tailwind: "--color-pressed",
    use: "The same wash while pressed.",
    avoid: "Not for a persistent selected state: use color.interactive.selected.",
  },
  {
    path: "color.interactive.selected",
    type: "color",
    value: ramp("brand", "a4", "a5"),
    tailwind: "--color-selected",
    use: "A translucent accent wash for the selected row, item or tab.",
    avoid: "Not for hover, and not for text selection inside an editor.",
  },
  {
    path: "color.interactive.selected-hover",
    type: "color",
    value: ramp("brand", "a5", "a6"),
    tailwind: "--color-selected-hover",
    use: "The selected wash while the pointer is over the selected row, item or tab.",
    avoid: "Not for an unselected item: use color.interactive.hover.",
  },
  {
    path: "color.interactive.drag",
    type: "color",
    value: ramp("blue", "a5", "a6"),
    tailwind: "--color-drag",
    use: "A translucent wash, in the blue ramp so it stays apart from selection, for an item being dragged and for the drop target it is over.",
    avoid: "Not for selection or hover.",
  },
];

const status: RoleDef[] = STATUS.flatMap((s): RoleDef[] => [
  {
    path: `color.status.${s.name}.solid`,
    type: "color",
    value: ramp(s.ramp, 9),
    tailwind: `--color-${s.name}`,
    use:
      s.name === "danger"
        ? "The filled background of a destructive action, and the border of an invalid field."
        : `The filled background of a ${s.name} badge, banner or button for ${s.meaning}.`,
    avoid: `Not for ${s.name} text on a neutral background: use color.status.${s.name}.fg.`,
  },
  {
    path: `color.status.${s.name}.solid-hover`,
    type: "color",
    value: ramp(s.ramp, 10),
    tailwind: `--color-${s.name}-hover`,
    use: `color.status.${s.name}.solid while hovered.`,
    avoid: "Not a resting colour.",
  },
  {
    path: `color.status.${s.name}.solid-fg`,
    type: "color",
    value: ramp(s.ramp, "contrast"),
    tailwind: `--color-${s.name}-solid-fg`,
    use: `Text and icons on color.status.${s.name}.solid and its hover colour. It is the ramp's own contrast colour, so it is white or dark ink as that solid needs.`,
    avoid: "Not on a tinted status background: use the status fg. Not color.fg.on-accent, which belongs to the accent ramp.",
  },
  {
    path: `color.status.${s.name}.fg`,
    type: "color",
    value: ramp(s.ramp, 11),
    tailwind: `--color-${s.name}-fg`,
    use: `Text and icons for ${s.meaning}, on neutral backgrounds or on color.status.${s.name}.bg.`,
    avoid: "Not the only signal: pair it with an icon or text, colour alone does not carry meaning.",
  },
  {
    path: `color.status.${s.name}.bg`,
    type: "color",
    value: ramp(s.ramp, 3, 5),
    tailwind: `--color-${s.name}-subtle`,
    use: `A tinted background for ${s.meaning}: alerts, badges, inline messages.`,
    avoid: "Not for filled buttons: use the status solid.",
  },
  {
    path: `color.status.${s.name}.border`,
    type: "color",
    value: ramp(s.ramp, 7),
    tailwind: `--color-${s.name}-border`,
    use: `The outline of a ${s.name} alert or banner, on color.status.${s.name}.bg.`,
    avoid: "Not the outline of an invalid field, which must reach 3:1: use color.status.danger.solid.",
  },
]);

const shape: RoleDef[] = [
  {
    path: "radius.none",
    type: "dimension",
    value: px(0),
    use: "Square corners: table cells, full-bleed panels, dividers.",
    avoid: "Not for controls and containers, which follow the radius seed: use radius.md or radius.lg.",
  },
  {
    path: "radius.xs",
    type: "dimension",
    value: (seeds) => px(Math.max(0, Math.round(seeds.radius / 3))),
    tailwind: "--radius-xs",
    use: "The smallest rounding: focus outlines on inline text, code chips, scrollbar thumbs.",
    avoid: "Not for controls: use radius.sm or radius.md.",
  },
  {
    path: "radius.sm",
    type: "dimension",
    value: (seeds) => px(Math.max(0, Math.round((seeds.radius * 2) / 3))),
    tailwind: "--radius-sm",
    use: "Small elements: checkboxes, tags, extra-small controls.",
    avoid: "Not for standard controls: use radius.md.",
  },
  {
    path: "radius.md",
    type: "dimension",
    value: (seeds) => px(seeds.radius),
    tailwind: "--radius-md",
    use: "Standard controls: buttons, inputs, menu items.",
    avoid: "Not for containers: use radius.lg.",
  },
  {
    path: "radius.lg",
    type: "dimension",
    value: (seeds) => px(Math.round((seeds.radius * 5) / 3)),
    tailwind: "--radius-lg",
    use: "Containers: cards, popovers, dialogs.",
    avoid: "Not for controls inside those containers: use radius.md.",
  },
  {
    path: "radius.xl",
    type: "dimension",
    value: (seeds) => px(Math.round(seeds.radius * 2)),
    tailwind: "--radius-xl",
    use: "Large containers: sheets, drawers, big cards.",
    avoid: "Not for controls and not for small containers: use radius.md or radius.lg.",
  },
  {
    path: "radius.full",
    type: "dimension",
    value: px(9999),
    use: "Pills and circles: avatars, switches, badges, round icon buttons.",
    avoid: "Not for rectangles that happen to be small: use radius.sm.",
  },
];

const font: RoleDef[] = [
  {
    path: "font.sans",
    type: "fontFamily",
    value: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
    tailwind: "--font-sans",
    use: "All interface text.",
    avoid: "Not for code, identifiers or tabular data that must align: use font.mono.",
  },
  {
    path: "font.mono",
    type: "fontFamily",
    value: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
    tailwind: "--font-mono",
    use: "Code, SQL, identifiers, and grid cells that must align.",
    avoid: "Not for labels or prose.",
  },
];

const raisedLight: ShadowLayer[] = [layer(ref("color.black.a2"), 0, 1, 2), layer(ref("color.black.a1"), 0, 1, 1)];
const raisedDark: ShadowLayer[] = [layer(ref("color.white.a1"), 0, 0, 0, 1)];

const elevation: RoleDef[] = [
  {
    path: "shadow.raised",
    type: "shadow",
    value: byTheme(raisedLight, raisedDark),
    tailwind: "--shadow-raised",
    use: "The lift of buttons and cards one step above their background.",
    avoid: "Not for popovers or dialogs, which need a deeper shadow.",
  },
];

const density: RoleDef[] = [
  {
    path: "size.control.xs",
    type: "dimension",
    value: byDensity(px(20), px(18)),
    tailwind: "--spacing-control-xs",
    use: "Height of the smallest controls: inline tags, icon buttons inside a row.",
    avoid: "Not a touch target; not for primary actions.",
  },
  {
    path: "size.control.sm",
    type: "dimension",
    value: byDensity(px(28), px(22)),
    tailwind: "--spacing-control-sm",
    use: "Height of small controls and of dense rows (toolbars, grid rows).",
    avoid: "Not for forms a user fills in at length: use size.control.md.",
  },
  {
    path: "size.control.md",
    type: "dimension",
    value: byDensity(px(36), px(28)),
    tailwind: "--spacing-control-md",
    use: "Height of standard controls: buttons, inputs, selects.",
    avoid: "Not a fixed pixel value: never hard-code 36px, the density mode changes it.",
  },
  {
    path: "size.control.lg",
    type: "dimension",
    value: byDensity(px(44), px(34)),
    tailwind: "--spacing-control-lg",
    use: "Height of large controls: the main call to action, touch-first layouts.",
    avoid: "Not inside dense tools such as grids and toolbars.",
  },
  {
    path: "space.control.x",
    type: "dimension",
    value: byDensity(px(12), px(8)),
    tailwind: "--spacing-control-x",
    use: "Horizontal padding inside a standard control.",
    avoid: "Not for gaps between controls or for layout spacing.",
  },
];

const WASHES = [
  "color.interactive.hover",
  "color.interactive.active",
  "color.interactive.selected",
  "color.interactive.selected-hover",
  "color.interactive.drag",
];
const SURFACES = ["color.bg.canvas", "color.bg.surface", "color.bg.raised", "color.bg.overlay", "color.bg.inset"];
const SOLIDS = ["color.accent.bg", "color.accent.bg-hover", "color.accent.bg-active"];
const NEUTRAL_SOLIDS = ["color.neutral.bg", "color.neutral.bg-hover", "color.neutral.bg-active"];

export const DEFAULT_CATALOG: Catalog = {
  roles: [
    ...SCALE_ROLES,
    ...background,
    ...foreground,
    ...border,
    ...accent,
    ...neutral,
    ...interactive,
    ...status,
    ...shape,
    ...font,
    ...elevation,
    ...ELEVATION_ROLES,
    ...density,
    ...SPACE_ROLES,
    ...TEXT_ROLE_DEFS,
    ...DOMAIN_ROLES,
  ],
  pairs: [
    // Text on every surface.
    ...pairs("text", ["color.fg.default", "color.fg.muted", "color.fg.subtle", "color.fg.link"], SURFACES),
    // Text on a hovered, pressed, selected or dragged item, over the darkest and the lightest surface.
    ...pairs("text", ["color.fg.default", "color.fg.muted"], WASHES, "color.bg.canvas"),
    ...pairs("text", ["color.fg.default", "color.fg.muted"], WASHES, "color.bg.overlay"),
    // Filled controls.
    ...pairs("text", ["color.fg.on-accent", "color.accent.fg"], SOLIDS),
    ...pairs("text", ["color.neutral.fg"], NEUTRAL_SOLIDS),
    ...STATUS.flatMap((s) => pairs("text", [`color.status.${s.name}.solid-fg`], [`color.status.${s.name}.solid`, `color.status.${s.name}.solid-hover`])),
    ...pairs("text", ["color.accent.subtle-fg"], ["color.accent.subtle-bg"]),
    ...pairs("text", ["color.neutral.subtle-fg"], ["color.neutral.subtle-bg"]),
    // Status text on its tint and on the page.
    ...STATUS.flatMap((s) =>
      pairs("text", [`color.status.${s.name}.fg`], [`color.status.${s.name}.bg`, "color.bg.canvas", "color.bg.surface"]),
    ),
    // Non-text contrast (WCAG 1.4.11): what identifies a control, and the focus ring.
    ...pairs("ui", ["color.border.strong", "color.ring", "color.border.focus"], SURFACES),
    ...pairs("ui", ["color.accent.bg", "color.status.danger.solid"], ["color.bg.canvas", "color.bg.surface"]),
    ...DOMAIN_PAIRS,
  ],
  shadcn: {
    "--background": "color.bg.canvas",
    "--foreground": "color.fg.default",
    "--card": "color.bg.surface",
    "--card-foreground": "color.fg.default",
    "--popover": "color.bg.overlay",
    "--popover-foreground": "color.fg.default",
    "--primary": "color.accent.bg",
    "--primary-foreground": "color.fg.on-accent",
    "--secondary": "color.bg.inset",
    "--secondary-foreground": "color.fg.default",
    "--muted": "color.bg.inset",
    "--muted-foreground": "color.fg.muted",
    "--accent": "color.interactive.hover",
    "--accent-foreground": "color.fg.default",
    "--destructive": "color.status.danger.solid",
    "--destructive-foreground": "color.status.danger.solid-fg",
    "--border": "color.border.default",
    "--input": "color.border.strong",
    "--ring": "color.ring",
    "--radius": "radius.md",
    "--chart-1": "chart.cat.1",
    "--chart-2": "chart.cat.2",
    "--chart-3": "chart.cat.3",
    "--chart-4": "chart.cat.4",
    "--chart-5": "chart.cat.5",
    "--sidebar": "color.bg.inset",
    "--sidebar-foreground": "color.fg.default",
    "--sidebar-primary": "color.accent.bg",
    "--sidebar-primary-foreground": "color.fg.on-accent",
    "--sidebar-accent": "color.interactive.hover",
    "--sidebar-accent-foreground": "color.fg.default",
    "--sidebar-border": "color.border.default",
    "--sidebar-ring": "color.ring",
  },
};
