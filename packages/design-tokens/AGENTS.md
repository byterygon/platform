# @byterygon/design-tokens

The token engine of Byterygon UI (spec "Byterygon UI: design tokens, Theme Studio and component
set", sections 2 to 4 and 9a). A theme file of seeds plus overrides becomes DTCG tokens, and the
tokens become CSS, Tailwind, shadcn, TypeScript and Figma outputs. Pure TypeScript; no network at
any point; the build fails when a rule is broken.

```
theme file (seeds + overrides)
  -> OKLCH ramps, 12 steps per colour and scheme        src/color/ramp.ts
  -> primitive tokens (raw scales)                      src/generate.ts
  -> semantic and component roles                       src/catalog/default.ts
  -> overrides from the theme                           src/generate.ts
  -> rules: aliases, tiers, raw colours, contrast       src/validate.ts
  -> Style Dictionary transforms and formats            src/outputs.ts
  -> generated/<theme>/{tokens.css, tailwind-theme.css, shadcn-alias.css,
                        tokens.ts, tokens.dtcg.json, figma-variables.json}
```

## Commands

Build the package once (`pnpm --filter @byterygon/design-tokens build`), then use the CLI. Every
command is non-interactive and takes `--json`.

```sh
pnpm --filter @byterygon/design-tokens tokens build            # regenerate generated/default
pnpm --filter @byterygon/design-tokens tokens build --check    # exit 3 if generated/ is stale
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
- `seeds.colors.<ramp>` is `{ hue, chroma, solid? }`. `neutral` follows the brand hue unless it
  has its own. Any new name adds a ramp (`color.<name>.1..12`, `a1..a12`, `contrast`, and the
  same under `color.<name>-dark`).
- An override is a value for every mode, or an object keyed by mode name to change some modes.
  A value is an alias in braces or a literal of the token's type (`oklch(L C H)`, `#rrggbb`,
  `12px`, `150ms`, a list of font families). A colour literal is only allowed on a primitive.
- `seeds.contrast.level` is `AA` (4.5:1 text, 3:1 UI) or `AAA` (7:1, 4.5:1). `seeds.contrast.apca`
  (`{ text, ui }`, absolute Lc) adds an APCA minimum; without it APCA is reported, not enforced.

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

- **A role**: add a `RoleDef` to `src/catalog/default.ts` with `path`, `type`, `value`, `use`
  (when to use it), `avoid` (when not to, and what to use instead) and, if components need a
  utility, `tailwind`. Use `ramp()`, `byTheme()`, `byDensity()`, `ref()`, `px()`, `layer()` from
  `src/catalog/authoring.ts`. A value may be a function of the seeds.
- **A contrast pair**: add it to `pairs` in the same file. Every text role needs a pair for each
  background it is used on; every control outline and focus ring needs a `ui` pair.
- **A shadcn alias**: add it to `shadcn` in the same file.
- **A preset**: add `themes/<name>.theme.json`, run `tokens build --theme <name>`, commit
  `generated/<name>/`.
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

## Exports

| Import | What |
| --- | --- |
| `@byterygon/design-tokens` | the engine: `generateTokens`, `validate`, `resolve`, `toDtcg`, the catalogue vocabulary, and the colour module |
| `@byterygon/design-tokens/color` | the colour module alone: OKLCH conversion, sRGB gamut mapping, WCAG and APCA contrast, the lightness solver, `generateRamp` |
| `@byterygon/design-tokens/build` | `buildTheme` and `renderOutputs` (Node, Style Dictionary) |
| `@byterygon/design-tokens/default/*` | the committed outputs of the default theme (`tokens.css`, `tailwind-theme.css`, `shadcn-alias.css`, `tokens.dtcg.json`, `figma-variables.json`) |
| `@byterygon/design-tokens/default/tokens` | `tokens.ts`: typed paths, CSS variables, descriptions and resolved values |

In an app: import `tokens.css`, then `tailwind-theme.css` (after `@import "tailwindcss"`), then
`shadcn-alias.css` if stock shadcn components are used. Components use the Tailwind utilities
(`bg-surface`, `text-fg-muted`, `border-border-strong`, `h-control-md`, `rounded-md`).
