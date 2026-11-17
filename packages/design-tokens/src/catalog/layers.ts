/**
 * The layered look (Fluent 2, the "Aurora" direction chosen on 2026-11-16): a backdrop gradient
 * on the app root, translucent layers on it, hairline control strokes with a darker bottom edge,
 * a 2 px underline on a focused field, a double focus ring, Fluent's depth shadows for flyouts
 * and dialogs, and a blur for what shows through.
 *
 * Every theme has these roles. Their defaults keep a theme's own look: the backdrop's glows are
 * the canvas colour (so it shows a flat canvas), and the layers are near-white (light) or a faint
 * white wash (dark). The `default` preset (Aurora) colours the glows. Values that are not ramp steps come from the reference
 * canvas (black and white at exact percentages, `color.black.alpha-*`).
 *
 * Contrast on a layer is measured over the backdrop at its least favourable point, and for a
 * control on a layer over both (`over: ["gradient.backdrop", "color.bg.layer"]`).
 */
import type { ContrastPair, ShadowLayer } from "../model.js";
import { type RoleDef, byTheme, insetLayer, layer, pairs, px, radial, ref, solid } from "./authoring.js";

const black = (percent: number) => ref(`color.black.alpha-${percent}`);
const white = (percent: number) => ref(`color.white.alpha-${percent}`);

/**
 * The backdrop: two glows (the reference canvas's geometry: one at the top left, one at the right
 * edge) over the canvas colour. The glow colours are roles of their own, the canvas colour by
 * default, so a theme without glows paints a flat canvas and a theme with glows sets two colours
 * (the Theme Studio edits them like any colour role) rather than the whole gradient.
 */
const backdrop: RoleDef[] = [
  {
    path: "color.backdrop.glow-1",
    type: "color",
    value: ref("color.bg.canvas"),
    use: "Colour of the backdrop's first glow, at the top left of the app. The canvas colour unless the theme gives the backdrop glows (Aurora: a light tint of the brand).",
    avoid: "Not painted on its own: gradient.backdrop draws it. Not for surfaces or text.",
  },
  {
    path: "color.backdrop.glow-2",
    type: "color",
    value: ref("color.bg.canvas"),
    use: "Colour of the backdrop's second glow, at the right edge of the app. The canvas colour unless the theme gives the backdrop glows (Aurora: a light aqua).",
    avoid: "Not painted on its own: gradient.backdrop draws it. Not for surfaces or text.",
  },
  {
    path: "gradient.backdrop",
    type: "gradient",
    value: [
      radial(ref("color.backdrop.glow-1"), 1100, 700, 0.08, 0, 0.6),
      radial(ref("color.backdrop.glow-2"), 1000, 800, 1, 0.35, 0.6),
      solid(ref("color.bg.canvas")),
    ],
    use: "The app background of the layered look, painted once on the app root (background or background-image: var(--by-gradient-backdrop), or the bg-(image:--by-gradient-backdrop) utility): the two backdrop glows over the canvas colour, under every translucent layer. Where the glows are the canvas colour it shows a flat canvas.",
    avoid: "Not behind a single card or control, and not where a colour is needed: tools without gradients (Figma, Monaco) read its solid colour, color.bg.canvas unless the theme changes it.",
  },
];

const layers: RoleDef[] = [
  {
    path: "color.bg.layer",
    type: "color",
    value: byTheme(white(72), ref("color.white.a1")),
    tailwind: "--color-layer",
    use: "Translucent surfaces on the backdrop: cards, panels, toolbars, and the fill of secondary buttons. The backdrop shows through (72 % white in light, 5 % in dark).",
    avoid: "Not for floating layers (use elevation.flyout or elevation.dialog) and not on an opaque surface where nothing shows through: use color.bg.surface.",
  },
  {
    path: "color.bg.layer-alt",
    type: "color",
    value: byTheme(ref("color.base.white"), white(6)),
    tailwind: "--color-layer-alt",
    use: "The fill of text fields, selects and segmented tracks on a layer, and every other row of a striped table: one step brighter than color.bg.layer.",
    avoid: "Not for cards or panels: use color.bg.layer. Not a hover state: use color.interactive.hover.",
  },
];

const strokes: RoleDef[] = [
  {
    path: "color.border.subtle",
    type: "color",
    value: byTheme(black(8), white(8)),
    tailwind: "--color-border-subtle",
    use: "Hairline outline of controls, flyouts and separators on translucent layers: 8 % black or white, so it reads on any backdrop.",
    avoid: "Not the only cue that identifies a text field (far below 3:1): add color.border.control-bottom. On opaque surfaces color.border.default also works.",
  },
  {
    path: "color.border.control-bottom",
    type: "color",
    value: byTheme(black(45), white(55)),
    tailwind: "--color-border-control-bottom",
    use: "The darker bottom edge of text fields, selects and other inputs, drawn over color.border.subtle: the stroke that makes a field reach 3:1 on its layer.",
    avoid: "Not on buttons (use color.border.control-bottom-subtle) and not as a whole outline (use color.border.subtle around the field).",
  },
  {
    path: "color.border.control-bottom-subtle",
    type: "color",
    value: byTheme(black(18), white(4)),
    tailwind: "--color-border-control-bottom-subtle",
    use: "The slightly different bottom edge of buttons and other raised controls, which reads as depth.",
    avoid: "Not on text fields, whose bottom stroke must reach 3:1: use color.border.control-bottom. Never the only thing that identifies a control.",
  },
  {
    path: "color.border.focus-underline",
    type: "color",
    value: ref("color.accent.bg"),
    tailwind: "--color-border-focus-underline",
    use: "The 2 px underline of a focused text field, in the accent colour (shadow.focus-underline draws it).",
    avoid: "Not the focus indicator of buttons and other controls: use the double ring (color.ring outside color.ring-inner).",
  },
];

const focus: RoleDef[] = [
  {
    path: "color.ring-inner",
    type: "color",
    value: byTheme(ref("color.base.white"), ref("color.base.black")),
    tailwind: "--color-ring-inner",
    use: "The inner stroke of the double focus ring, between the control and color.ring, so the ring reads on any fill (white in light, black in dark).",
    avoid: "Not a focus indicator on its own: it is always drawn with color.ring outside it.",
  },
  {
    path: "ring.inner-width",
    type: "dimension",
    value: px(1),
    use: "Thickness of the inner stroke of the double focus ring (ring.inner-color), inside the ring.width of ring.color: outline for the outer stroke, box-shadow for the inner one.",
    avoid: "Not a border width: use border.width.*.",
  },
  {
    path: "ring.inner-color",
    type: "color",
    value: ref("color.ring-inner"),
    use: "Colour of the inner stroke of the double focus ring: box-shadow: 0 0 0 var(--by-ring-inner-width) var(--by-ring-inner-color), with the outline in ring.color outside it.",
    avoid: "Not a border or a selection colour, and not without the outer ring.",
  },
  {
    path: "shadow.focus-underline",
    type: "shadow",
    value: [insetLayer(ref("color.border.focus-underline"), 0, -2, 0)],
    tailwind: "--shadow-focus-underline",
    use: "Draws the 2 px accent underline of a focused text field inside its box (inset 0 -2px 0), over its bottom stroke.",
    avoid: "Not for buttons or a whole-box focus ring: use the double ring (ring.color and ring.inner-color).",
  },
];

/**
 * Fluent's depth scale: a key shadow (offset half the blur) and an ambient one. The number is the
 * key shadow's blur. The tokens are `depth.<n>`, not `shadow.depth.<n>`: Figma's output lists
 * shadows under `"token": "<path>"`, and gitleaks' generic-api-key rule (CI) reads the longer
 * paths with two digits as a secret. Light: 14 % and 12 % black. Dark: 26 % and 40 %, from the reference canvas.
 */
const DEPTHS: readonly (readonly [number, number, number])[] = [
  // depth, key offset y, ambient blur
  [2, 1, 2],
  [4, 2, 2],
  [8, 4, 2],
  [16, 8, 2],
  [28, 14, 8],
  [64, 32, 8],
];

const DEPTH_USE: Readonly<Record<number, string>> = {
  2: "the faintest lift: a control or card that sits just above its layer",
  4: "a card that is hovered or dragged",
  8: "tooltips and small flyouts",
  16: "flyouts: menus, popovers, select and combobox lists, toasts",
  28: "large flyouts and teaching popups",
  64: "dialogs and other windows above the page",
};

const depthShadow = (depth: number, offset: number, ambient: number, key: string, ambientColor: string): ShadowLayer[] => [
  layer(ref(key), 0, offset, depth),
  layer(ref(ambientColor), 0, 0, ambient),
];

const depths: RoleDef[] = DEPTHS.map(([depth, offset, ambient]): RoleDef => ({
  path: `depth.${depth}`,
  type: "shadow",
  value: byTheme(
    depthShadow(depth, offset, ambient, "color.black.alpha-14", "color.black.alpha-12"),
    depthShadow(depth, offset, ambient, "color.black.alpha-26", "color.black.a6"),
  ),
  use: `Fluent depth ${depth}: ${DEPTH_USE[depth]}. A key and an ambient shadow; dark themes keep both, darker.`,
  avoid: "Not on a component directly: use the elevation role (elevation.layer, elevation.flyout, elevation.dialog) that bundles shadow, border and surface.",
}));

interface LayerElevation {
  readonly name: string;
  readonly shadow: RoleDef["value"];
  readonly border: RoleDef["value"];
  readonly bg: string;
  readonly tailwind: string;
  readonly use: string;
  readonly avoid: string;
}

const LAYER_ELEVATIONS: readonly LayerElevation[] = [
  {
    name: "layer",
    shadow: byTheme([layer(black(4), 0, 2, 4)], [layer(ref("color.white.a1"), 0, 0, 0)]),
    border: byTheme(black(6), white(7)),
    bg: "color.bg.layer",
    tailwind: "--shadow-layer",
    use: "Cards and panels laid on the backdrop: a translucent fill, a hairline and (light only) a faint shadow.",
    avoid: "Not for anything that floats: use elevation.flyout or elevation.dialog.",
  },
  {
    name: "flyout",
    shadow: ref("depth.16"),
    border: ref("color.border.subtle"),
    bg: "color.bg.overlay",
    tailwind: "--shadow-flyout",
    use: "Layers that float over the page and close on an outside click, in the layered look: menus, popovers, select and combobox lists, tooltips, toasts.",
    avoid: "Not for dialogs that block the page: use elevation.dialog.",
  },
  {
    name: "dialog",
    shadow: ref("depth.64"),
    border: ref("color.border.subtle"),
    bg: "color.bg.overlay",
    tailwind: "--shadow-dialog",
    use: "The top layer of the layered look, over a scrim: dialogs, alert dialogs, sheets and the command palette.",
    avoid: "Not for anything that does not block the page: use elevation.flyout.",
  },
];

/** Three tokens per elevation, as the other elevation roles (elevation.ts). */
const elevations: RoleDef[] = LAYER_ELEVATIONS.flatMap((e): RoleDef[] => [
  {
    path: `elevation.${e.name}.shadow`,
    type: "shadow",
    value: e.shadow,
    tailwind: e.tailwind,
    use: `Shadow of the ${e.name} elevation. ${e.use}`,
    avoid: `Use the three tokens of the role together (shadow, border, bg). ${e.avoid}`,
  },
  {
    path: `elevation.${e.name}.border`,
    type: "color",
    value: e.border,
    use: `Hairline border of the ${e.name} elevation. ${e.use}`,
    avoid: `Use the three tokens of the role together (shadow, border, bg). ${e.avoid}`,
  },
  {
    path: `elevation.${e.name}.bg`,
    type: "color",
    value: ref(e.bg),
    use: `Surface colour of the ${e.name} elevation. ${e.use}`,
    avoid: `Use the three tokens of the role together (shadow, border, bg). ${e.avoid}`,
  },
]);

const material: RoleDef[] = [
  {
    path: "blur.acrylic",
    type: "dimension",
    value: px(30),
    tailwind: "--blur-acrylic",
    use: "Blur of what shows through a translucent flyout or layer (backdrop-filter: blur(), the backdrop-blur-acrylic utility), so text on it stays legible.",
    avoid: "Not a shadow blur, and not on opaque surfaces, where it costs paint time and shows nothing.",
  },
];

export const LAYER_ROLES: readonly RoleDef[] = [...backdrop, ...layers, ...strokes, ...focus, ...depths, ...elevations, ...material];

const BACKDROP = ["gradient.backdrop"];
const ON_LAYER = ["gradient.backdrop", "color.bg.layer"];
const TEXT = ["color.fg.default", "color.fg.muted", "color.fg.subtle", "color.fg.link"];
const STATUS_TEXT = ["danger", "warning", "success", "info"].map((name) => `color.status.${name}.fg`);

/** The pairs of the layered look; `surfaces` are the opaque surfaces a field may also sit on. */
export function layerPairs(surfaces: readonly string[]): ContrastPair[] {
  return [
    // Text straight on the backdrop: an app's title area and status bar (TSK-64, Fluent 2's base
    // layer). The backdrop is a blend of its two glows and the canvas, so text that holds on each of
    // the three holds everywhere on it.
    ...pairs("text", ["color.fg.default", "color.fg.muted"], ["color.backdrop.glow-1", "color.backdrop.glow-2", "color.bg.canvas"]),
    // Text on a layer over the backdrop, and on a field or striped row inside that layer.
    ...pairs("text", [...TEXT, ...STATUS_TEXT], ["color.bg.layer"], BACKDROP),
    ...pairs("text", TEXT, ["color.bg.layer-alt"], ON_LAYER),
    // What identifies a field, the focus indicators, and the filled controls.
    ...pairs("ui", ["color.border.control-bottom", "color.border.focus-underline", "color.ring"], ["color.bg.layer-alt"], ON_LAYER),
    ...pairs("ui", ["color.border.control-bottom", "color.ring", "color.accent.bg", "color.status.danger.solid"], ["color.bg.layer"], BACKDROP),
    ...pairs("ui", ["color.border.control-bottom", "color.border.focus-underline"], surfaces),
    // The bottom edge of an invalid field (TSK-53), on every fill a field takes.
    ...pairs("ui", ["color.status.danger.solid"], ["color.bg.layer-alt"], ON_LAYER),
    ...pairs("ui", ["color.status.danger.solid"], surfaces),
  ];
}
