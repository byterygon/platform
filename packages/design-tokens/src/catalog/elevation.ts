/**
 * Elevation (spec section 3): the shadow scale `shadow.0..5`, the four elevation roles
 * `elevation.{flat,raised,overlay,modal}` (shadow, border and surface together) and the focus
 * ring `ring.{width,offset,color}`.
 *
 * Shadows differ by theme and never by density. Light themes lift with soft black shadows. Dark
 * themes cannot show a dark shadow on a dark surface, so they lift with a lighter surface and a
 * hairline ring, and keep a black shadow only for the layers that float.
 *
 * `shadow.raised` (the first role the components were written against) is kept as it was.
 */
import type { ShadowLayer } from "../model.js";
import { type RoleDef, byTheme, layer, px, ref } from "./authoring.js";

const black = (step: number) => ref(`color.black.a${step}`);
const white = (step: number) => ref(`color.white.a${step}`);

/** [light layers, dark layers] for shadow.0 .. shadow.5. */
const SHADOWS: readonly (readonly [readonly ShadowLayer[], readonly ShadowLayer[]])[] = [
  // 0: flat. A layer that draws nothing, so the token is a valid shadow list.
  [[layer(black(1), 0, 0, 0)], [layer(white(1), 0, 0, 0)]],
  // 1: raised one step: buttons, cards.
  [
    [layer(black(2), 0, 1, 2), layer(black(1), 0, 1, 1)],
    [layer(white(1), 0, 0, 0, 1)],
  ],
  // 2: raised.
  [
    [layer(black(2), 0, 2, 4), layer(black(1), 0, 1, 2)],
    [layer(white(1), 0, 0, 0, 1), layer(black(4), 0, 2, 4)],
  ],
  // 3: floating: popovers, menus.
  [
    [layer(black(2), 0, 4, 8), layer(black(1), 0, 2, 4)],
    [layer(white(1), 0, 0, 0, 1), layer(black(4), 0, 4, 8)],
  ],
  // 4: dropdowns that carry a lot of content, command palettes.
  [
    [layer(black(2), 0, 8, 16), layer(black(2), 0, 4, 6)],
    [layer(white(2), 0, 0, 0, 1), layer(black(5), 0, 8, 16)],
  ],
  // 5: modal dialogs and drawers.
  [
    [layer(black(3), 0, 16, 32), layer(black(2), 0, 8, 12)],
    [layer(white(2), 0, 0, 0, 1), layer(black(5), 0, 16, 32)],
  ],
];

const SHADOW_USE = [
  "No shadow: a surface that sits flat on the canvas.",
  "The faintest lift: buttons and cards one step above their background.",
  "A clear lift: sticky headers, hovered cards, toasts.",
  "A floating layer: popovers, dropdown menus, tooltips.",
  "A large floating layer: command palettes and menus with a lot of content.",
  "The deepest shadow: modal dialogs and drawers.",
];

const shadows: RoleDef[] = SHADOWS.map(([light, dark], index): RoleDef => ({
  path: `shadow.${index}`,
  type: "shadow",
  value: byTheme(light, dark),
  use: `${SHADOW_USE[index]} Light themes use soft black shadows; dark themes use a lighter surface and a hairline ring instead.`,
  avoid: "Not on a component directly: use the elevation role (elevation.raised, elevation.overlay) that bundles shadow, border and surface.",
}));

interface Elevation {
  readonly name: string;
  readonly shadow: number;
  /** The surface role the layer is painted with. */
  readonly bg: string;
  readonly use: string;
  readonly avoid: string;
  readonly tailwind?: string;
}

const ELEVATIONS: readonly Elevation[] = [
  {
    name: "flat",
    shadow: 0,
    bg: "color.bg.surface",
    use: "Cards, panels and table bodies that sit on the canvas without a lift.",
    avoid: "Not for anything that floats above other content.",
  },
  {
    name: "raised",
    shadow: 1,
    bg: "color.bg.surface",
    use: "Content one step above its surroundings: buttons, hovered cards, sticky bars.",
    avoid: "Not for popovers and menus: use elevation.overlay.",
  },
  {
    name: "overlay",
    shadow: 3,
    bg: "color.bg.raised",
    tailwind: "--shadow-overlay",
    use: "Layers that float above the page and close on an outside click: popovers, dropdown menus, tooltips, the command palette.",
    avoid: "Not for dialogs that block the page: use elevation.modal.",
  },
  {
    name: "modal",
    shadow: 5,
    bg: "color.bg.overlay",
    tailwind: "--shadow-modal",
    use: "The top layer, over a scrim: dialogs, alert dialogs, drawers and sheets.",
    avoid: "Not for anything that does not block the page.",
  },
];

/** An elevation is three tokens, `.shadow`, `.border` and `.bg`: the composite is not a DTCG type the outputs share. */
const elevations: RoleDef[] = ELEVATIONS.flatMap((e): RoleDef[] => [
  {
    path: `elevation.${e.name}.shadow`,
    type: "shadow",
    value: ref(`shadow.${e.shadow}`),
    ...(e.tailwind ? { tailwind: e.tailwind } : {}),
    use: `Shadow of the ${e.name} elevation. ${e.use}`,
    avoid: `Use the three tokens of the role together (shadow, border, bg). ${e.avoid}`,
  },
  {
    path: `elevation.${e.name}.border`,
    type: "color",
    value: ref("color.border.default"),
    use: `Hairline border of the ${e.name} elevation: in dark themes it carries most of the separation. ${e.use}`,
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

const ring: RoleDef[] = [
  {
    path: "ring.width",
    type: "dimension",
    value: px(2),
    use: "Thickness of the focus ring drawn around any focused element (the high-contrast preset makes it thicker).",
    avoid: "Not a border width: use border.width.*.",
  },
  {
    path: "ring.offset",
    type: "dimension",
    value: px(2),
    use: "The gap between a focused element and its focus ring, so the ring never hides the element's own border.",
    avoid: "Not for spacing between elements: use space.gap.*.",
  },
  {
    path: "ring.color",
    type: "color",
    value: ref("color.ring"),
    use: "Colour of the focus ring: outline: var(--by-ring-width) solid var(--by-ring-color).",
    avoid: "Not a selection or accent colour: use color.interactive.selected or color.accent.bg.",
  },
];

export const ELEVATION_ROLES: readonly RoleDef[] = [...shadows, ...elevations, ...ring];
