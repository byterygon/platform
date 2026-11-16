# @byterygon/design-tokens

The token engine of Byterygon UI (spec "Byterygon UI: design tokens, Theme Studio and component
set", sections 2 to 4 and 9a). A theme file of seeds plus overrides becomes DTCG tokens, and the
tokens become CSS, Tailwind, shadcn, TypeScript, Figma and Monaco outputs and a shadcn registry
theme item. The Theme Studio (`packages/theme-studio`) runs this same code in the browser, so
everything it exports is what `by-tokens export` prints, byte for byte. Pure TypeScript; no network at
any point; the build fails when a rule is broken.

```
theme file (seeds + overrides)
  -> OKLCH ramps, 12 steps per colour and scheme        src/color/ramp.ts
  -> primitive tokens (raw scales)                      src/generate.ts
  -> semantic and component roles                       src/catalog/*.ts (default.ts assembles them)
  -> overrides from the theme                           src/generate.ts
  -> rules: aliases, tiers, raw colours, contrast       src/validate.ts
  -> Style Dictionary transforms and formats            src/outputs.ts
     Monaco theme (one source with @byterygon/ui)       src/monaco.ts
     shadcn registry:theme item (same)                  src/registry-theme.ts
  -> generated/<theme>/{tokens.css, tailwind-theme.css, shadcn-alias.css,
                        tokens.ts, tokens.dtcg.json, figma-variables.json,
                        monaco-theme.ts, registry-theme.json}
     (the default theme commits all eight, the other presets the three CSS files)
```

## Commands

Build the package once (`pnpm --filter @byterygon/design-tokens build`), then use the CLI. Every
command is non-interactive and takes `--json`.

```sh
pnpm --filter @byterygon/design-tokens tokens build            # regenerate generated/default
pnpm --filter @byterygon/design-tokens tokens build --theme paper    # a preset (see "Presets")
pnpm --filter @byterygon/design-tokens tokens build --check    # exit 3 if generated/ is stale
pnpm --filter @byterygon/design-tokens tokens build --theme paper --all   # all eight files, not only the committed ones
pnpm --filter @byterygon/design-tokens tokens validate         # rules only, writes nothing
pnpm --filter @byterygon/design-tokens tokens explain color.bg.surface
pnpm --filter @byterygon/design-tokens tokens search hover background
pnpm --filter @byterygon/design-tokens tokens diff default ./my.theme.json
pnpm --filter @byterygon/design-tokens tokens preset create my-theme --set seeds.colors.brand.hue=150
pnpm --filter @byterygon/design-tokens tokens export css --theme ./my.theme.json
pnpm --filter @byterygon/design-tokens tokens export monaco --theme paper      # also registry, ts, dtcg, figma, tailwind, shadcn, theme
pnpm --filter @byterygon/design-tokens tokens hash encode --theme ./my.theme.json --mode dark   # a Theme Studio URL hash
pnpm --filter @byterygon/design-tokens tokens hash decode '#by=1&theme=...' --out my.theme.json # what a human tuned
pnpm --filter @byterygon/design-tokens tokens help --json      # commands, options, exit codes
pnpm --filter @byterygon/design-tokens test                    # includes the drift test
```

Inside the package directory the same commands are `node bin/by-tokens.js <command>`.

`--json` prints exactly one document to stdout and nothing to stderr:

```json
{ "schemaVersion": 1, "command": "build", "ok": false, "exitCode": 1, "theme": "my-theme",
  "diagnostics": [ { "severity": "error", "rule": "contrast", "token": "color.fg.subtle",
    "related": "color.bg.surface", "mode": { "theme": "light" }, "measured": 2.17, "required": 4.5,
    "message": "...", "fix": { "summary": "...", "overrides": { "color.neutral.7": "oklch(...)" },
      "alternatives": [ { "summary": "...", "overrides": { "color.fg.subtle": { "light": "{color.neutral.10}" } } } ] } } ] }
```

`fix.overrides` and `fix.seeds` are ready to merge into the theme file. A contrast fix is solved
against every background the role is paired with in that mode, so applying it once clears all of
that role's failures. Command-line mistakes come back as `"error": { "code", "message", "fix" }`.

| Exit code | Meaning |
| --- | --- |
| 0 | success |
| 1 | the theme or the tokens broke a rule; see `diagnostics` |
| 2 | bad command line, unknown token or preset, unreadable or malformed file |
| 3 | `build --check` found stale outputs, or `diff --exit-code` found differences |
| 70 | a bug in by-tokens |

## A theme is a file

`themes/<name>.theme.json`, described by `theme.schema.json`. Plain data, nothing else:

```json
{
  "schemaVersion": 1,
  "name": "my-theme",
  "seeds": {
    "colors": { "brand": { "hue": 150, "chroma": 0.12 } },
    "radius": 8, "colorScheme": "dark", "density": "compact", "contrast": { "level": "AA" }
  },
  "overrides": {
    "color.fg.link": { "dark": "{color.brand-dark.12}" },
    "radius.lg": "12px"
  }
}
```

- Every seed is optional; a missing one takes the default (`src/seeds.ts`). `by-tokens export
  theme` prints a theme with all of them spelled out.
- `seeds.colors.<ramp>` is `{ hue, chroma, solid?, tint? }`. `neutral` follows the brand hue unless
  it has its own. Ramps that exist by default: `neutral`, `brand`, `red`, `amber`, `green`,
  `blue` and the hues the domain tokens need, `violet`, `orange`, `teal`, `pink`. Any new name adds a
  ramp (`color.<name>.1..12`, `a1..a12`, `contrast`, and the same under `color.<name>-dark`).
- `tint` is the chroma of the background steps 1-5 of a ramp (`neutral` only, in practice). Without
  it those steps follow `chroma`, which leaves a low-chroma neutral almost grey: Paper asks for a
  warm cream with `"neutral": { "hue": 85, "chroma": 0.03, "tint": 0.011 }`, Midnight for a deep
  blue the same way. Steps 6-12 ignore it.
- `seeds.fontSize` (11 to 18, default 14) is the body size in px: the size of `text.body-1`, Fluent's
  step 300. Every step of Fluent's ramp (`font.size.100` to `font.size.1000`) is Fluent's size
  times fontSize / 14, rounded to a whole px (at least 10), and its line height is that size times
  Fluent's ratio for the step, rounded to a whole px (`font.leading.<step>` holds the ratio, so it
  stays unitless). 14 gives Fluent's values exactly; 13 gives 10, 11, 13, 15, 19, 22, 26, 30, 37,
  63. The legacy scale `font.size.2xs` to `4xl` is still derived as before (14 gives 11, 12, 13,
  14, 16, 18, 20, 24, 30); no role uses it.
- An override is a value for every mode, or an object keyed by mode name to change some modes.
  A value is an alias in braces or a literal of the token's type (`oklch(L C H)`, `#rrggbb`,
  `12px`, `150ms`, a list of font families, a list of shadow or gradient layers). A colour literal
  is only allowed on a primitive, inside a shadow or a gradient too.
- `seeds.contrast.level` is `AA` (4.5:1 text, 3:1 UI) or `AAA` (7:1, 4.5:1). `seeds.contrast.apca`
  (`{ text, ui }`, absolute Lc) adds an APCA minimum; without it APCA is reported, not enforced.

## Studio state (URL hash), versioned

The Theme Studio keeps its state in the URL hash and in browser storage, and both hold a theme
file (above), so an agent can open a Studio state, generate one, or read back what a human tuned.
`src/state.ts` is the only implementation; the Studio and `by-tokens hash` call it.

```
#by=1&theme=<payload>[&mode=light|dark][&density=comfortable|compact]

by        hash schema version, an integer (now 1); required
theme     base64url, no padding, of the deflate-raw compressed UTF-8 JSON of a theme file; required
mode      the colour mode the Studio shows; optional
density   the density the Studio shows; optional
```

- Readers ignore parameters they do not know, so a later version can add view state (a panel, a
  selected token) without breaking this one. A bad `mode` or `density` is ignored with a
  `state-value-ignored` warning.
- A hash with a newer `by` still opens: the payload encoding never changes, and the decoder
  reports a `state-newer-version` warning. Change the payload encoding only together with a new
  parameter name, never under `theme`.
- A theme file with a newer `schemaVersion` opens through `readThemeFile`: the top-level keys,
  seeds, ramp fields and contrast fields this version knows are kept, the file is labelled
  `schemaVersion` 1, and each dropped key is a `theme-key-dropped` warning. `by-tokens build`
  and the other commands still reject such a file (exit 1); only the hash is lenient.
- A malformed hash is one `state-invalid` error with a fix (exit 2 from `hash decode`).
- `encodeState` is deterministic: the same theme object and view give the same hash. Key order
  is the theme object's own.

## Presets

Seven themes ship in `themes/`. All seven pass every contrast pair in both colour modes (and, because
colour roles never depend on density, in both densities). The name in the first column is the
theme name; the second is how the Theme Studio will label it.

| Theme | Label | Look |
| --- | --- | --- |
| `default` | Byterygon | cool neutral, blue-teal brand (hue 230), light, comfortable. DBee sets `data-density="compact"` itself |
| `slate` | Slate | near-greyscale, muted slate-blue accent, radius 4 |
| `paper` | Paper | warm cream (neutral tint), rust accent, 15 px text with relaxed body leading, radius 8; its orange (the warning colour) at hue 65, so warning stays apart from the rust brand |
| `midnight` | Midnight | dark first, deep blue neutral, periwinkle accent |
| `terminal` | Terminal | dark first, green accent, `font.sans` set to the mono stack, 13 px, radius 2, compact |
| `aurora` | Aurora | the Fluent 2 layered look chosen on 2026-11-16 (TSK-52): violet brand `#6b4eff` (hue 282.5; light steps 9-11 overridden to the full chroma 0.2474, which the dark solid cannot show, so the seed chroma is 0.165), cool near-grey neutral (hue 275, chroma 0.012, tint 0.006), backdrop glows `brand.4`/`teal.3` (dark `brand-dark.6`/`teal-dark.6`) over a canvas one step up (`neutral.2`, dark `neutral-dark.3`, with surface, raised and overlay following), radius 4 with `radius.lg` 8, a black and white focus ring (`color.ring`), `color.border.focus` and `grid.selection-border` on the accent, `color.neutral-dark.10` lifted by the printed fix so subtle text holds on a field over the brightest glow |
| `high-contrast` | High contrast | WCAG AAA (7:1 text, 4.5:1 UI), pure grey, 3 px focus ring, `color.neutral.11` pushed to pass AAA, the field's bottom stroke at 55 % black (`color.black.alpha-55`) to reach 4.5:1 |

`generated/default/` holds all eight outputs. The other presets commit `tokens.css`,
`tailwind-theme.css` and `shadcn-alias.css`, which is what a project copies in: the other three are
about 1.4 MB per theme together, change with every catalogue edit, and `tokens build --theme <name> --all`
or `tokens export <format> --theme <name>` produce them on demand. The drift test renders all eight for
every preset and compares the committed ones byte for byte. `registry-theme.json` of every preset
is also `packages/ui/registry/theme-<preset>.json`, made by the same function from the committed
CSS; a test compares the two.

A theme whose brand solid is light enough to take dark text (a yellow, a lime) needs overrides the
catalogue cannot make for it: `color.accent.bg-active` points at step 11, a dark text step, so dark
text on it fails (override it to `{ "light": "{color.brand.10}" }`), and `color.ring`,
`color.accent.bg` and `grid.selection-border` are steps that are too light against a white page (alias
them to step 8). `validate` reports each with its pair and mode.

## Three tiers, one direction

| Tier | Holds | Example | Who uses it |
| --- | --- | --- | --- |
| primitive | raw values: the generated ramps, black and white overlays (`a1`..`a12`, Radix's scale, and `alpha-<percent>` for the exact percentages of the layered look) | `color.neutral.8` | semantic tokens only |
| semantic | roles, by mode | `color.border.strong` | components |
| component | a value a component needs that no role gives | `button.height` (none yet) | that component |

A token references its own tier or a lower one. Names are dot paths; the CSS variable is `--by-`
plus the path with dashes (`color.bg.surface` -> `--by-color-bg-surface`).

Two mode axes: `theme` (`data-theme="light|dark"`, also `.light` and `.dark`) and `density`
(`data-density="comfortable|compact"`). A token varies along at most one axis. Ramps exist once
per scheme (`color.brand.*` and `color.brand-dark.*`), so a role picks a different step per scheme
when it needs to (`ramp("neutral", 1, 2)`).

Ramp steps follow the Radix model: 1-2 app backgrounds, 3-5 component backgrounds (rest, hover,
pressed), 6-7 borders, 8 strong border (solved to 3:1 on the background steps), 9-10 solid and its hover
(solved to 4.5:1 against the ramp's `contrast` colour), 11 low-contrast text (solved to 4.5:1 on
steps 1-5, and on the same steps of the neutral ramp), 12 high-contrast text. `by-tokens explain color.brand.9` shows each step's job.

## Rules the build enforces

`description-missing`, `value-invalid`, `mode-invalid`, `mode-cross-axis`, `alias-missing`,
`alias-cycle`, `alias-type-mismatch`, `tier-direction`, `path-collision`,
`raw-color-outside-primitive`, `contrast`, `contrast-apca`, `contrast-pair-unknown-token`,
`output-mapping`, and for the theme file `theme-schema`, `seed-invalid`,
`override-unknown-token`, `override-invalid-value`, `ramp-contrast-unreachable`. `gamut` is a
warning: a seed chroma that sRGB cannot show was reduced (hue and lightness are kept).

Contrast is measured on the 8-bit sRGB colours a screen shows, in every mode a pair depends on;
a translucent background is composited over the surface under it first. A pair's `over` may be a
stack, bottom first (`["gradient.backdrop", "color.bg.layer"]`: a field on a translucent card on
the backdrop), and its bottom may be a gradient: the pair is then measured at every point of the
gradient (each glow at nine strengths, glows combined), the reported ratio is the worst one, and a
fix must hold on all of them. A failing translucent stroke (black or white at some alpha) gets the
nearest alpha of the same colour that passes as its fix.

## How to add things (data, not mechanism)

- **A role**: add a `RoleDef` to the catalogue file it belongs to (`default.ts`: colour, shape, density,
  assembly; `scales.ts`: primitive scales; `type.ts`: text roles; `space.ts`: density space;
  `elevation.ts`: shadows, elevation, focus ring; `domain.ts`: syntax, editor, data, grid, chart,
  diff) with `path`, `type`, `value`, `use`
  (when to use it), `avoid` (when not to, and what to use instead) and, if components need a
  utility, `tailwind` (plus `tailwindAliases` for more names of the same role, when the first one
  collides with another library's). Use `ramp()`, `byTheme()`, `byDensity()`, `ref()`, `px()`, `layer()` from
  `src/catalog/authoring.ts`. A value may be a function of the seeds.
- **A contrast pair**: add it to `pairs` in the same file. Every text role needs a pair for each
  background it is used on; every control outline and focus ring needs a `ui` pair.
- **A shadcn alias**: add it to `shadcn` in the same file.
- **A preset**: add `themes/<name>.theme.json`, run `tokens validate --theme <name>` (it prints each
  failing pair with a fix that can be pasted into the theme file), then `tokens build --theme <name>`
  and commit `generated/<name>/`. The drift test, the contrast test and the output-directory test
  pick up every file in `themes/`.
- **A text role**: five tokens, `text.<role>.{family,size,weight,leading,tracking}`, aliasing the
  `font.*` scales (`type.ts`: an entry in `TEXT_ROLES` with a Fluent ramp step and a weight). It is five tokens and not a DTCG `typography` composite because the
  engine handles every type it has in all its outputs and Figma has no typography variable.
  Tracking is a px dimension (DTCG has no em).
- **A token type**: add it to `ValueByType` in `src/model.ts` and to the switches in
  `src/values.ts` (parse, check, CSS) and `figmaTransform` in `src/outputs.ts`. A composite whose
  fields may be aliases (shadow, gradient) also needs a transitive Style Dictionary value
  transform (it runs after references resolve) and the branch in `renderTokensCss`. `gradient` is
  the worked example, including what an output without the type does with it (Figma: a colour
  variable aliasing the solid colour; `tokens.dtcg.json`: a `color` token with the layers under
  the extension).
- **A ramp recipe change** (lightness curve, chroma curve, which steps are solved): edit
  `DEFAULT_RECIPE` in `src/color/ramp.ts`; it is data.

After any of these: `tokens build`, then commit the changed files under `generated/`. The drift
test fails otherwise.

## Never

- Never edit a file under `generated/`; change the theme or the catalogue and rebuild.
- Never put a colour literal in a semantic or component token; alias a primitive.
- Never reference a primitive from a component; use a role, and add one if none fits.
- Never lower a contrast target or delete a pair to make a build pass; apply the suggested fix
  or change the colours.
- Never add a token without `use` and `avoid` sentences.
- Never import Node APIs or a package into `src/color/` or anything `src/index.ts` exports: the
  engine runs in the browser (Theme Studio). Style Dictionary belongs in `src/outputs.ts` and
  `src/build.ts`, which also run in the browser (Style Dictionary reads nothing from disk here; the
  Studio bundles it), so they import no Node API either. Node belongs in `src/cli/`. Tests enforce
  both.
- Never add an import to `src/monaco.ts` or `src/registry-theme.ts`: `@byterygon/ui` imports them
  as TypeScript source and its registry ships `monaco.ts` as the `@byterygon/monaco-theme` item.
- Never fetch anything at build or run time.

## The layered look (Fluent 2 "Aurora")

`src/catalog/layers.ts`. Every theme has these roles; their defaults keep a theme's own look (the
backdrop's two glows are the canvas colour, so it paints a flat canvas; near-white or faint white
layers). A preset colours the glows by overriding `color.backdrop.glow-1` and `glow-2` (an alias
per mode), or replaces the whole `gradient.backdrop` with its own list of layers. Values that are not ramp steps are the reference canvas's
(https://claude.ai/artifact/Re3tNwGGy65nfHRB2MLLK9, board "Fluent · Aurora").

| Token | Tailwind | Light / dark | Use |
| --- | --- | --- | --- |
| `gradient.backdrop` | `bg-(image:--by-gradient-backdrop)` | glow 1 (1100 x 700 px at 8 % 0 %) and glow 2 (1000 x 800 px at 100 % 35 %), fading out at 60 %, over `color.bg.canvas` | once, on the app root |
| `color.backdrop.glow-1`, `glow-2` | (none) | `color.bg.canvas` unless a theme colours them | the glows' colours |
| `color.bg.layer` | `bg-layer` | white 72 % / white 5 % | cards, panels, toolbars, secondary buttons |
| `color.bg.layer-alt` | `bg-layer-alt` | white / white 6 % | field fills, segmented tracks, striped rows |
| `color.border.subtle` | `border-border-subtle` | black 8 % / white 8 % | hairline of controls and flyouts on layers |
| `color.border.control-bottom` | `border-b-border-control-bottom` | black 45 % / white 55 % | bottom edge of a field: what makes it 3:1 |
| `color.border.control-bottom-subtle` | `border-b-border-control-bottom-subtle` | black 18 % / white 4 % | bottom edge of a button (depth, not identity) |
| `color.border.focus-underline`, `shadow.focus-underline` | `shadow-focus-underline` | the accent solid, inset 0 -2px 0 | a focused field |
| `color.ring-inner`, `ring.inner-width`, `ring.inner-color` | `ring-ring-inner` | white / black, 1 px | the inner stroke of the double focus ring |
| `depth.{2,4,8,16,28,64}` | (none) | key 14 % + ambient 12 % / 26 % + 40 % black | Fluent's depth scale, through an elevation |
| `elevation.{layer,flyout,dialog}.{shadow,border,bg}` | `shadow-layer`, `shadow-flyout`, `shadow-dialog` | 0 2px 4px black 4 % (light only); depth 16; depth 64 | cards on the backdrop, flyouts, dialogs |
| `blur.acrylic` | `backdrop-blur-acrylic` | 30 px | what shows through a translucent flyout |

- The double focus ring is the outline in `ring.color` (`ring.width`, offset by
  `ring.inner-width`) with a `box-shadow: 0 0 0 var(--by-ring-inner-width)
  var(--by-ring-inner-color)` inside it. The outline survives forced-colours mode; the shadow
  does not need to.
- Contrast: text on `color.bg.layer` over the backdrop, text and the field strokes on
  `color.bg.layer-alt` over the backdrop and a layer, the focus ring and the solids on a layer.
- `elevation.flyout` and `elevation.dialog` use `color.bg.overlay`, opaque: a component that wants
  acrylic lays `color.bg.layer` and `backdrop-blur-acrylic` itself.

## Type ramp and motion (Fluent 2)

Values from `@fluentui/tokens` 1.0.0-alpha.24 (MIT, gitHead `2dd2a9a96210919c35b210a1aa8e873ab67dbada`):
`typographyStyles`, `fontSizes`, `lineHeights`, `durations` and `curves` in `lib/global/`. The
package is a reference, never a dependency. `test/catalog.test.ts` pins every value.

| Role (`text.<role>`, `text-<role>`) | Fluent style | Size / line height (px, at 14) | Weight |
| --- | --- | --- | --- |
| `caption-2`, `caption-2-strong` | caption2, caption2Strong | 10 / 14 | 400, 600 |
| `caption-1`, `caption-1-strong`, `caption-1-stronger` | caption1 (+ Strong, Stronger) | 12 / 16 | 400, 600, 700 |
| `body-1`, `body-1-strong`, `body-1-stronger` | body1 (+ Strong, Stronger) | 14 / 20 | 400, 600, 700 |
| `body-2` | body2 | 16 / 22 | 400 |
| `subtitle-2`, `subtitle-2-stronger` | subtitle2 (+ Stronger) | 16 / 22 | 600, 700 |
| `subtitle-1` | subtitle1 | 20 / 28 | 600 |
| `title-3`, `title-2`, `title-1` | title3, title2, title1 | 24 / 32, 28 / 36, 32 / 40 | 600 |
| `large-title` | largeTitle | 40 / 52 | 600 |
| `display` | display | 68 / 92 | 600 |
| `code`, `code-sm` | (Byterygon: `font.mono`) | 14 / 20, 12 / 16 | 400 |

- Fluent has no letter spacing: every role tracks at `font.tracking.normal` (0).
- The names from before TSK-57 alias a Fluent role, field by field (`text.body.size` is
  `{text.body-1.size}`), so components and theme overrides keep working: `heading-1` -> `title-2`,
  `heading-2` -> `title-3`, `heading-3` -> `subtitle-1` (Fluent's dialog title), `heading-4` ->
  `subtitle-2`, `body` -> `body-1`, `body-strong` -> `body-1-strong`, `label` -> `body-1`
  (Fluent's Label), `caption` -> `caption-1`. Headings moved one step up the ramp from their old
  size. New code uses the Fluent names; TSK-53/55 move the components.
- Text roles do not vary by density (compact shrinks controls and gaps, not the reading size).

| Duration (`motion.duration.<name>`) | ms | | Curve (`motion.easing.<name>`, `ease-<name>`) | cubic-bezier |
| --- | --- | --- | --- | --- |
| `instant` (Byterygon) | 0 | | `accelerate-max`, `-mid`, `-min` | 0.9,0.1,1,0.2 · 1,0,1,1 · 0.8,0,0.78,1 |
| `ultra-fast` | 50 | | `decelerate-max`, `-mid`, `-min` | 0.1,0.9,0.2,1 · 0,0,0,1 · 0.33,0,0.1,1 |
| `faster` | 100 | | `easy-ease-max` | 0.8,0,0.2,1 |
| `fast` | 150 | | `easy-ease` | 0.33,0,0.67,1 |
| `normal` | 200 | | `linear` (Tailwind's own `ease-linear`) | 0,0,1,1 |
| `gentle`, `slow`, `slower`, `ultra-slow` | 250, 300, 400, 500 | | | |

- Fluent's guidance: decelerate (ease-out) for what enters, accelerate (ease-in) for what leaves,
  easy ease for what moves between two places, linear only for a constant rate.
- Kept names, as semantic aliases (a primitive holds a literal): `motion.duration.base` ->
  `normal` (was 160 ms), `motion.easing.standard` -> `easy-ease`, `enter` -> `decelerate-mid`,
  `exit` -> `accelerate-mid`, `emphasized` -> `easy-ease-max`. `fast` and `slow` are Fluent's own
  names, so they took Fluent's values (100 -> 150 ms, 240 -> 300 ms); the old `fast` is `faster`.
- `@byterygon/ui`'s `src/lib/motion.ts` mirrors these (`MOTION_DURATION_MS`, `MOTION_EASING`,
  `durationVar`, `easingVar`, `tokenEasing`); its test keeps them equal to the tokens.
- Curves have no Figma variable (they are in `figma-variables.json`'s `skipped` list). A new token
  name that lands there must not look like a secret to gitleaks' generic-api-key rule: no digits
  and an entropy below that of the names already there (DOC-17 open question 99).

## Catalogue notes

- A half step of the space scale is written `0-5`, `1-5` (a path segment cannot hold a dot).
- Shadows and colours vary by `theme`; size and space roles vary by `density`. A token never varies
  by both (`mode-cross-axis`): an elevation role is an alias to a themed shadow, not a role that also
  picks a density.
- `shadow.0` to `shadow.5` are semantic, not primitive, because a shadow layer aliases the black and
  white overlays. `shadow.raised` predates them and is kept as it was.
- Status colours: `color.status.<name>.{bg,border,fg,solid,solid-hover,solid-fg}`. Put `solid-fg` on
  `solid`, never `color.fg.on-accent`: the red solid takes white text where a yellow one takes ink.
  Warning is the `orange` ramp (hue 55; before TSK-52 it was `amber`), apart from danger's red and
  from the brand; a theme whose brand is orange or rust moves its `orange` seed (Paper: hue 65). A
  test checks warning stays at least 20 degrees of hue from danger and from every preset's brand.
- `color.accent.{bg,bg-hover,bg-active,fg}` are also `accent-solid`, `accent-solid-hover`,
  `accent-solid-active` and `accent-solid-fg` in Tailwind (`tailwindAliases`). shadcn/ui's
  `bg-accent` is a hover background (its `--accent`), so Byterygon components use the
  `accent-solid` names and a project with stock shadcn components keeps shadcn's meaning.
- `font.sans` and `font.mono` are the font family tokens (the spec calls them `font.family.*`).
  Override them to change the fonts; `fonts/fonts.css` declares the vendored files.

## Fonts

`fonts/` holds Inter (variable, one file) and JetBrains Mono (400, 500, 600, 700), both SIL OFL 1.1,
with their licence texts, `manifest.json` (version, source URL, sha256 of every file) and `fonts.css`
(`@font-face`, hand-written, the same for every theme). `node scripts/check-licenses.mjs` fails on a
missing licence text, a changed file or an unlisted font file. Nothing is fetched at build or run time.

## Exports

| Import | What |
| --- | --- |
| `@byterygon/design-tokens` | the engine: `generateTokens`, `validate`, `resolve`, `toDtcg`, the catalogue vocabulary, the colour module, the Studio state (`encodeState`, `decodeState`, `readThemeFile`), and the Monaco and registry modules |
| `@byterygon/design-tokens/color` | the colour module alone: OKLCH conversion, sRGB gamut mapping, WCAG and APCA contrast, the lightness solver, `generateRamp` |
| `@byterygon/design-tokens/build` | `buildTheme`, `renderOutputs`, `monacoThemeFor`, and `renderTokensCss` (`tokens.css` alone, synchronous, in a few milliseconds, byte for byte the `renderOutputs` one: the Theme Studio's live preview), and `exportTheme` with `EXPORT_FORMATS` (`src/export.ts`: every export, its file name and install note; `by-tokens export` and the Studio's Export dialog both call it) (Style Dictionary; runs in Node and in the browser) |
| `@byterygon/design-tokens/monaco` | `src/monaco.ts` as source: `MONACO_COLORS`, `MONACO_TOKENS`, `monacoTheme(read)` |
| `@byterygon/design-tokens/registry-theme` | `src/registry-theme.ts` as source: `registryThemeItem`, `formatRegistryThemeItem`, the small CSS reader |
| `@byterygon/design-tokens/default/*` | the committed outputs of the default theme (`tokens.css`, `tailwind-theme.css`, `shadcn-alias.css`, `tokens.dtcg.json`, `figma-variables.json`, `monaco-theme.ts`, `registry-theme.json`) |
| `@byterygon/design-tokens/presets/<name>/*` | the committed outputs of a preset (the three CSS files; all eight for `default`) |
| `@byterygon/design-tokens/fonts/*` | `fonts.css` and the vendored font files |
| `@byterygon/design-tokens/default/tokens` | `tokens.ts`: typed paths, CSS variables, descriptions and resolved values |

In an app: import `fonts/fonts.css`, then `tokens.css`, then `tailwind-theme.css` (after `@import "tailwindcss"`), then
`shadcn-alias.css` if stock shadcn components are used. Components use the Tailwind utilities
(`bg-surface`, `text-fg-muted`, `border-border-strong`, `h-control-md`, `rounded-md`).
