/**
 * The default catalogue: the semantic roles, the contrast pairs they must satisfy, and the
 * shadcn alias table (spec "Byterygon UI", section 3).
 *
 * This is the minimal set that proves the pipeline and that the first components use. The full
 * catalogue (type, elevation, motion, grid, syntax, chart) is added here as data; see AGENTS.md.
 */
import type { ShadowLayer } from "../model.js";
import { type Catalog, type RoleDef, byDensity, byTheme, layer, pairs, px, ramp, ref } from "./authoring.js";

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
];

const foreground: RoleDef[] = [
  {
    path: "color.fg.default",
    type: "color",
    value: ramp("neutral", 12),
    tailwind: "--color-fg",
    use: "Body text, headings and icons that carry meaning.",
    avoid: "Not for text on a solid accent or status background: use color.fg.on-accent.",
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
    use: "Text and icons on color.accent.bg and on solid status backgrounds.",
    avoid: "Not on neutral backgrounds: use color.fg.default.",
  },
];

const border: RoleDef[] = [
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
    path: "color.accent.bg",
    type: "color",
    value: ramp("brand", 9),
    tailwind: "--color-accent",
    use: "The filled background of the primary action and of checked controls.",
    avoid: "Not for large areas, and not more than one primary action per view.",
  },
  {
    path: "color.accent.bg-hover",
    type: "color",
    value: ramp("brand", 10),
    tailwind: "--color-accent-hover",
    use: "color.accent.bg while hovered.",
    avoid: "Not a resting colour.",
  },
  {
    path: "color.accent.bg-active",
    type: "color",
    value: ramp("brand", 11),
    tailwind: "--color-accent-active",
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
    avoid: "Not on color.accent.bg: use color.fg.on-accent.",
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
];

const status: RoleDef[] = STATUS.flatMap((s): RoleDef[] => [
  ...(s.name === "danger"
    ? ([
        {
          path: "color.status.danger.solid",
          type: "color",
          value: ramp(s.ramp, 9),
          tailwind: "--color-danger",
          use: "The filled background of a destructive action, and the border of an invalid field.",
          avoid: "Not for error text on a neutral background: use color.status.danger.fg.",
        },
        {
          path: "color.status.danger.solid-hover",
          type: "color",
          value: ramp(s.ramp, 10),
          tailwind: "--color-danger-hover",
          use: "color.status.danger.solid while hovered.",
          avoid: "Not a resting colour.",
        },
      ] satisfies RoleDef[])
    : []),
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
]);

const shape: RoleDef[] = [
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

const SURFACES = ["color.bg.canvas", "color.bg.surface", "color.bg.raised", "color.bg.overlay", "color.bg.inset"];
const WASHES = ["color.interactive.hover", "color.interactive.active", "color.interactive.selected"];

export const DEFAULT_CATALOG: Catalog = {
  roles: [...background, ...foreground, ...border, ...accent, ...interactive, ...status, ...shape, ...font, ...elevation, ...density],
  pairs: [
    // Text on every surface.
    ...pairs("text", ["color.fg.default", "color.fg.muted", "color.fg.subtle", "color.fg.link"], SURFACES),
    // Text on a hovered, pressed or selected item, over the darkest and the lightest surface.
    ...pairs("text", ["color.fg.default", "color.fg.muted"], WASHES, "color.bg.canvas"),
    ...pairs("text", ["color.fg.default", "color.fg.muted"], WASHES, "color.bg.overlay"),
    // Filled controls.
    ...pairs("text", ["color.fg.on-accent"], [
      "color.accent.bg",
      "color.accent.bg-hover",
      "color.accent.bg-active",
      "color.status.danger.solid",
      "color.status.danger.solid-hover",
    ]),
    ...pairs("text", ["color.accent.subtle-fg"], ["color.accent.subtle-bg"]),
    // Status text on its tint and on the page.
    ...STATUS.flatMap((s) =>
      pairs("text", [`color.status.${s.name}.fg`], [`color.status.${s.name}.bg`, "color.bg.canvas", "color.bg.surface"]),
    ),
    // Non-text contrast (WCAG 1.4.11): what identifies a control, and the focus ring.
    ...pairs("ui", ["color.border.strong", "color.ring"], SURFACES),
    ...pairs("ui", ["color.accent.bg", "color.status.danger.solid"], ["color.bg.canvas", "color.bg.surface"]),
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
    "--border": "color.border.default",
    "--input": "color.border.strong",
    "--ring": "color.ring",
    "--radius": "radius.md",
  },
};
