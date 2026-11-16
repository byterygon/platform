# @byterygon/theme-studio

The Theme Studio of Byterygon UI (spec "Byterygon UI: design tokens, Theme Studio and component
set", section 5 and 9a; task TSK-48). Change the seeds or any token, see the effect on real
components, and take the result away as a theme file or an export. A static React app built with
Byterygon UI itself: no backend, no network, runs from a folder (`file://`) or any static server.
MIT OR Apache-2.0.

```
theme file (seeds + overrides)  +  view (colour mode, density)        src/state/
  -> generateTokens + validate   (@byterygon/design-tokens)            src/engine.ts
  -> renderTokensCss -> <style data-studio-theme>  (byte for byte the exported tokens.css)
  -> the Studio and the preview, built from packages/ui/src through `@/` src/app.tsx, src/panels/
  -> URL hash + browser storage  (encodeState/decodeState, versioned)  src/state/persist.ts
```

## Commands

```sh
pnpm --filter @byterygon/design-tokens build     # once: the Studio imports the engine's dist/
pnpm --filter @byterygon/theme-studio dev        # Vite dev server
pnpm --filter @byterygon/theme-studio build      # dist/: index.html, studio.js, studio.css
pnpm --filter @byterygon/theme-studio test       # Vitest (jsdom): state, persistence, the app, dist/
pnpm --filter @byterygon/theme-studio typecheck
pnpm --filter @byterygon/theme-studio check:browser   # the built Studio in Chromium: file://, server, every export
```

`check:browser` builds `dist/`, then drives a Chromium-family browser over the DevTools protocol
from `file://` and from a loopback server. It fails on any request outside the Studio's own files,
any script error, an edit that does not apply or persist, Monaco not starting, or an export
(downloaded through the Export dialog for every preset and format) that differs from
`by-tokens export`, a gallery card that does not show its preset's own tokens, a Duplicate that
does not open and save the copy, or a share link that does not reopen the same theme and view.
Without a browser it skips unless `BYTERYGON_REQUIRE_BROWSER=1` (CI, in a
network namespace); `BYTERYGON_BROWSER` names one; `--presets a,b` and `--screenshot <dir>` help
locally.

Open `dist/index.html` directly, or serve `dist/` from any static server. Nothing else is needed.

Typecheck reads `@byterygon/design-tokens` from its TypeScript source (`paths` in `tsconfig.json`),
because CI typechecks before it builds; Vite, the tests and the build use its `dist/`.

## Everything the Studio does, without the Studio (spec 9a.1)

The Studio's whole state is a theme file and a view, so every edit is a change to a file that
`by-tokens` reads, and the same engine answers:

| In the Studio | Headless |
| --- | --- |
| Seeds panel, token editor | edit `<name>.theme.json` (`seeds`, `overrides`), or `by-tokens preset create <name> --set seeds.radius=8 --set overrides.color.fg.link={color.brand.12}` |
| Problems tab, a token's contrast pairs | `by-tokens validate --theme <file> --contrast --json` |
| A token's resolved values and alias chain | `by-tokens explain <token> --theme <file>` |
| The address bar (state) | `by-tokens hash encode --theme <file> --mode dark` / `by-tokens hash decode '<hash or url>'` |
| Themes dialog: the presets and their order | `by-tokens preset list` (same order and labels, from `PRESET_LABELS`), `by-tokens preset show <name>` |
| Themes dialog: Duplicate | `by-tokens preset create <name> --from <preset>` (the engine's `duplicateTheme`: same file) |
| Themes dialog: Export of a card | `by-tokens export theme --theme <name>` |
| Share link | `by-tokens hash encode --theme <file> [--mode] [--density]`, appended to the Studio's address |
| Export dialog (Copy, Download, install note) | `by-tokens export <css\|tailwind\|shadcn\|dtcg\|figma\|ts\|monaco\|registry\|theme> --theme <name>.theme.json` (`--json` adds the same install note) |

The hash and the theme file are versioned and documented in
`packages/design-tokens/AGENTS.md` ("Studio state"). To open a theme in the Studio, append its
hash to the Studio URL: `file:///opt/theme-studio/index.html#by=1&theme=...`.

## Export

The Export dialog lists `EXPORT_FORMATS` of `@byterygon/design-tokens` (label, file name, install
note) and shows `exportTheme(theme, format)`, the function `by-tokens export` calls. Generated
headers name the source `<name>.theme.json`, which is what the theme-file export saves, so
`by-tokens export <format> --theme <name>.theme.json` on that file prints the same bytes.
`test/parity.test.ts` proves it for every preset, a new theme and an edited one, in every format
(in-process and through the installed binary); `check:browser` proves it for the real downloads.
A theme that breaks a rule exports nothing, as with `by-tokens` (exit 1). Copy uses the Clipboard
API with a selected-textarea fallback; Download is a blob URL, which works from `file://`.
Never format an export in the Studio: add the format to `src/export.ts` of the token package.

## Themes (presets gallery and saved themes)

The Themes dialog (header) lists the theme files of `packages/design-tokens/themes/`, bundled at
build time with `import.meta.glob` (`src/state/presets.ts`), in the engine's order with the engine's
labels (`presetOrder`, `presetLabel`; `default` shows as Aurora). The Studio names no preset: a new
file in `themes/` appears after a build, and the engine's test fails until it has a label.

- Each card is drawn by the theme's own `tokens.css`, from `renderTokensCss(set, source, { scope })`
  of the engine: the variables are declared on `[data-studio-preview="<id>"]` instead of `:root`,
  and the card carries `data-theme` of the current view, so every card shows its theme in the
  Studio's colour mode next to the edited theme.
- Open replaces the edited theme with the preset (its `$schema` pointer dropped) and switches the
  view to the theme's own `colorScheme` and `density`. Duplicate is `duplicateTheme` under
  `copyName` (`<name>-copy`, `-copy-2`...): the copy is saved and opened. Export downloads the theme
  file through `exportTheme(theme, "theme")`.
- Saved themes live in `localStorage["byterygon.theme-studio.library"]` as
  `{"version":1,"themes":[{"savedAt","theme"}]}` (`src/state/library.ts`), newest first, one per
  theme name: saving a name that is saved replaces it. Each theme is read through
  `readThemeFile`; a newer `version` is read leniently with a warning; unreadable JSON is reported
  and a later save writes a new list. Delete has Undo. Without storage the dialog says so and
  Duplicate still opens the copy.

## Share link

Share (header) shows the Studio's address with the state's hash (`encodeState`, the same
`#by=1&theme=...&mode=...&density=...` the address bar holds) and copies it (Clipboard API, then a
selected textarea, then the link stays selected in its field). The theme travels in the link;
nothing is uploaded. Above `SHARE_LINK_WARN` (2,000 characters) it warns that mail and chat tools
may cut it; above `SHARE_LINK_MAX` (32,000) it offers no link and points to the theme-file export.
From `file://` it notes that the part from `#` works with any copy of the Studio. The presets'
links are 430 to 750 characters.

## State

- `theme` is a theme file (`schemaVersion`, `name`, `seeds?`, `overrides?`), edited only through
  the pure functions of `src/state/theme-edit.ts`. A new theme is `{ schemaVersion: 1, name:
  "my-theme" }`: no seeds, so every value is the engine default and each edit is one line of the
  file. The engine defaults are the `default` preset's seeds (Aurora's violet brand and cool grey,
  radius 4) but not its overrides, so a new theme has no backdrop glows, a brand focus ring and
  the canvas on step 1; open the Aurora card in Themes to start from the full Aurora look (DOC-17
  open question 108 asks whether a new theme should start from it). Reset deletes a seed or an override; it never writes a default.
- `view` is `{ mode, density }`: `data-theme` and `data-density` on `<html>`.
- Persistence: the state is the versioned hash, written to the address bar (`replaceState`, no
  history entries) and to `localStorage["byterygon.theme-studio.state"]`, 150 ms after the last
  edit. On load: the URL hash, else storage, else a new theme. A hash that does not decode, or a
  newer version, opens with a notice listing what happened. Storage may be missing or throw
  (private windows, some `file://` setups); the Studio then only uses the hash.
- The edited theme is applied to the whole page, the Studio's own controls included. That is on
  purpose: popups render in a portal outside any preview region, so only a page-wide theme shows
  menus, dialogs and toasts as they will look.
- The page, the component preview and the role board paint `gradient.backdrop` (over
  `color.bg.canvas`), as an app root does in the layered look: Aurora shows its glows there, and a
  theme whose glows are the canvas colour looks flat, as before. The role board shows gradient
  roles as wide swatches next to the colour roles.

## Offline and `file://`

Browsers refuse ES modules, module workers, `fetch` and cross-file fonts on `file://`, so the
build (`vite.config.ts`) is: one IIFE script with every dynamic import inlined, loaded by a classic
`<script defer>`, one stylesheet, every asset (fonts, the codicon font) as a `data:` URL, and
Monaco's editor worker inlined as a blob worker (the `?worker` imports of `@/lib/monaco` become
`?worker&inline`). No `crossorigin` attributes. The page's CSP has `connect-src 'none'`.
`test/dist.test.ts` checks all of it on `dist/`; the bundle is about 7 MB (Monaco, Style
Dictionary for the exports, the engine, React and Base UI) because nothing is loaded later.

## Rules

- Byterygon UI components only, imported from `@/components/<name>/<name>` (the alias points at
  `packages/ui/src`); Base UI only underneath, never Radix or another primitive library. Style with
  the token roles (`bg-surface`, `text-fg-muted`, `p-inset-lg`), as `packages/ui/AGENTS.md` says.
- The preview uses the components' own `*.example.tsx` (the Realistic ones), so it shows exactly
  what the component tests render. To add a group, add it to `PREVIEW_GROUPS` in
  `src/panels/preview.tsx`.
- Every check comes from the engine (`derive` in `src/engine.ts`): never compute a contrast ratio,
  resolve an alias or validate a value in the Studio. If the Studio needs a new answer, add it to
  `@byterygon/design-tokens` and use it from both the Studio and `by-tokens`.
- A ramp's colour is picked by eye (`src/panels/color-picker.tsx`): a palette, a hue x chroma plane
  painted at the ramp's solid lightness, a field for a pasted `#hex`/`oklch()`, and exact values. It
  writes only `hue` and `chroma`; lightness stays with the ramp so contrast holds. The colour maths is
  the engine's (`oklchToDisplayRgb`, `maxChroma`, `parseColor`). Studio-only: Base UI has no picker.
- A new seed control writes the same key the theme file has (`src/state/theme-edit.ts`), with the
  range `resolveSeeds` accepts (`packages/design-tokens/src/seeds.ts`).
- Never fetch, never load from a CDN, never add a backend. Never depend on anything in `apps/`
  (`scripts/check-licenses.mjs` fails).
- Never hard-code a preset name or label: take `PRESETS` (`src/state/presets.ts`), which comes from
  the engine's `themes/` and `presetOrder`/`presetLabel`.
- The contrast report with one-click fixes and import are the next TSK-49 batches.
