# @byterygon/design-tokens

The token engine of Byterygon UI (spec "Byterygon UI: design tokens, Theme Studio and component
set", sections 2 to 4 and 9a). A theme file of seeds plus overrides becomes DTCG tokens, and the
tokens become CSS, Tailwind, shadcn, TypeScript and Figma outputs. Pure TypeScript; no network at
any point; the build fails when a rule is broken.

```
theme file (seeds + overrides)
  -> OKLCH ramps, 12 steps per colour and scheme        src/color/ramp.ts
  -> primitive tokens (raw scales)                      src/generate.ts
  -> semantic and component roles                       src/catalog/*.ts (default.ts assembles them)
  -> overrides from the theme                           src/generate.ts
  -> rules: aliases, tiers, raw colours, contrast       src/validate.ts
  -> Style Dictionary transforms and formats            src/outputs.ts
  -> generated/<theme>/{tokens.css, tailwind-theme.css, shadcn-alias.css,
                        tokens.ts, tokens.dtcg.json, figma-variables.json}
     (the default theme commits all six, the other presets the three CSS files)
```

## Commands

Build the package once (`pnpm --filter @byterygon/design-tokens build`), then use the CLI. Every
command is non-interactive and takes `--json`.

```sh
pnpm --filter @byterygon/design-tokens tokens build            # regenerate generated/default
pnpm --filter @byterygon/design-tokens tokens build --theme paper    # a preset (see "Presets")
pnpm --filter @byterygon/design-tokens tokens build --check    # exit 3 if generated/ is stale
pnpm --filter @byterygon/design-tokens tokens build --theme paper --all   # all six files, not only the committed ones
pnpm --filter @byterygon/design-tokens tokens validate         # rules only, writes nothing
pnpm --filter @byterygon/design-tokens tokens explain color.bg.surface
pnpm --filter @byterygon/design-tokens tokens search hover background
pnpm --filter @byterygon/design-tokens tokens diff default ./my.theme.json
pnpm --filter @byterygon/design-tokens tokens preset create my-theme --set seeds.colors.brand.hue=150
pnpm --filter @byterygon/design-tokens tokens export css --theme ./my.theme.json
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
- `seeds.fontSize` (11 to 18, default 14) is the body size in px; `font.size.2xs` to `4xl` are
  derived from it (14 gives 11, 12, 13, 14, 16, 18, 20, 24, 30).
- An override is a value for every mode, or an object keyed by mode name to change some modes.
  A value is an alias in braces or a literal of the token's type (`oklch(L C H)`, `#rrggbb`,
  `12px`, `150ms`, a list of font families). A colour literal is only allowed on a primitive.
- `seeds.contrast.level` is `AA` (4.5:1 text, 3:1 UI) or `AAA` (7:1, 4.5:1). `seeds.contrast.apca`
  (`{ text, ui }`, absolute Lc) adds an APCA minimum; without it APCA is reported, not enforced.

## Presets

Six themes ship in `themes/`. All six pass every contrast pair in both colour modes (and, because
colour roles never depend on density, in both densities). The name in the first column is the
theme name; the second is how the Theme Studio will label it.

| Theme | Label | Look |
| --- | --- | --- |
| `default` | Byterygon | cool neutral, blue-teal brand (hue 230), light, comfortable. DBee sets `data-density="compact"` itself |
| `slate` | Slate | near-greyscale, muted slate-blue accent, radius 4 |
| `paper` | Paper | warm cream (neutral tint), rust accent, 15 px text with relaxed body leading, radius 8 |
| `midnight` | Midnight | dark first, deep blue neutral, periwinkle accent |
| `terminal` | Terminal | dark first, green accent, `font.sans` set to the mono stack, 13 px, radius 2, compact |
| `high-contrast` | High contrast | WCAG AAA (7:1 text, 4.5:1 UI), pure grey, 3 px focus ring, `color.neutral.11` pushed to pass AAA |

`generated/default/` holds all six outputs. The other presets commit `tokens.css`,
`tailwind-theme.css` and `shadcn-alias.css`, which is what a project copies in: the other three are
about 1.4 MB per theme together, change with every catalogue edit, and `tokens build --theme <name> --all`
or `tokens export <format> --theme <name>` produce them on demand. The drift test renders all six for
every preset and compares the committed ones byte for byte.

A theme whose brand solid is light enough to take dark text (a yellow, a lime) needs overrides the
catalogue cannot make for it: `color.accent.bg-active` points at step 11, a dark text step, so dark
text on it fails (override it to `{ "light": "{color.brand.10}" }`), and `color.ring`,
`color.accent.bg` and `grid.selection-border` are steps that are too light against a white page (alias
them to step 8). `validate` reports each with its pair and mode.

## Three tiers, one direction

| Tier | Holds | Example | Who uses it |
| --- | --- | --- | --- |
| primitive | raw values: the generated ramps, black and white overlays | `color.neutral.8` | semantic tokens only |
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
a translucent background is composited over the surface under it first.

## How to add things (data, not mechanism)

- **A role**: add a `RoleDef` to the catalogue file it belongs to (`default.ts`: colour, shape, density,
  assembly; `scales.ts`: primitive scales; `type.ts`: text roles; `space.ts`: density space;
  `elevation.ts`: shadows, elevation, focus ring; `domain.ts`: syntax, editor, data, grid, chart,
  diff) with `path`, `type`, `value`, `use`
  (when to use it), `avoid` (when not to, and what to use instead) and, if components need a
  utility, `tailwind`. Use `ramp()`, `byTheme()`, `byDensity()`, `ref()`, `px()`, `layer()` from
  `src/catalog/authoring.ts`. A value may be a function of the seeds.
- **A contrast pair**: add it to `pairs` in the same file. Every text role needs a pair for each
  background it is used on; every control outline and focus ring needs a `ui` pair.
- **A shadcn alias**: add it to `shadcn` in the same file.
- **A preset**: add `themes/<name>.theme.json`, run `tokens validate --theme <name>` (it prints each
  failing pair with a fix that can be pasted into the theme file), then `tokens build --theme <name>`
  and commit `generated/<name>/`. The drift test, the contrast test and the output-directory test
  pick up every file in `themes/`.
- **A text role**: five tokens, `text.<role>.{family,size,weight,leading,tracking}`, aliasing the
  `font.*` scales (`type.ts`). It is five tokens and not a DTCG `typography` composite because the
  engine handles every type it has in all six outputs and Figma has no typography variable.
  Tracking is a px dimension (DTCG has no em).
- **A token type**: add it to `ValueByType` in `src/model.ts` and to the switches in
  `src/values.ts` (parse, check, CSS) and `figmaTransform` in `src/outputs.ts`.
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
  engine runs in the browser (Theme Studio). Node and Style Dictionary belong in `src/outputs.ts`,
  `src/build.ts` and `src/cli/`. A test enforces this.
- Never fetch anything at build or run time.

## Catalogue notes

- A half step of the space scale is written `0-5`, `1-5` (a path segment cannot hold a dot).
- Shadows and colours vary by `theme`; size and space roles vary by `density`. A token never varies
  by both (`mode-cross-axis`): an elevation role is an alias to a themed shadow, not a role that also
  picks a density.
- `shadow.0` to `shadow.5` are semantic, not primitive, because a shadow layer aliases the black and
  white overlays. `shadow.raised` predates them and is kept as it was.
- Status colours: `color.status.<name>.{bg,border,fg,solid,solid-hover,solid-fg}`. Put `solid-fg` on
  `solid`, never `color.fg.on-accent`: the red solid takes white text where a yellow one takes ink.
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
| `@byterygon/design-tokens` | the engine: `generateTokens`, `validate`, `resolve`, `toDtcg`, the catalogue vocabulary, and the colour module |
| `@byterygon/design-tokens/color` | the colour module alone: OKLCH conversion, sRGB gamut mapping, WCAG and APCA contrast, the lightness solver, `generateRamp` |
| `@byterygon/design-tokens/build` | `buildTheme` and `renderOutputs` (Node, Style Dictionary) |
| `@byterygon/design-tokens/default/*` | the committed outputs of the default theme (`tokens.css`, `tailwind-theme.css`, `shadcn-alias.css`, `tokens.dtcg.json`, `figma-variables.json`) |
| `@byterygon/design-tokens/presets/<name>/*` | the committed outputs of a preset (the three CSS files; all six for `default`) |
| `@byterygon/design-tokens/fonts/*` | `fonts.css` and the vendored font files |
| `@byterygon/design-tokens/default/tokens` | `tokens.ts`: typed paths, CSS variables, descriptions and resolved values |

In an app: import `fonts/fonts.css`, then `tokens.css`, then `tailwind-theme.css` (after `@import "tailwindcss"`), then
`shadcn-alias.css` if stock shadcn components are used. Components use the Tailwind utilities
(`bg-surface`, `text-fg-muted`, `border-border-strong`, `h-control-md`, `rounded-md`).
