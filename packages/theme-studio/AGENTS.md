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
```

Open `dist/index.html` directly, or serve `dist/` from any static server. Nothing else is needed.

## Everything the Studio does, without the Studio (spec 9a.1)

The Studio's whole state is a theme file and a view, so every edit is a change to a file that
`by-tokens` reads, and the same engine answers:

| In the Studio | Headless |
| --- | --- |
| Seeds panel, token editor | edit `<name>.theme.json` (`seeds`, `overrides`), or `by-tokens preset create <name> --set seeds.radius=8 --set overrides.color.fg.link={color.brand.12}` |
| Problems tab, a token's contrast pairs | `by-tokens validate --theme <file> --contrast --json` |
| A token's resolved values and alias chain | `by-tokens explain <token> --theme <file>` |
| The address bar (state) | `by-tokens hash encode --theme <file> --mode dark` / `by-tokens hash decode '<hash or url>'` |
| Export (TSK-48 batch 3) | `by-tokens export <css\|tailwind\|shadcn\|dtcg\|figma\|ts\|monaco\|registry\|theme> --theme <file>` |

The hash and the theme file are versioned and documented in
`packages/design-tokens/AGENTS.md` ("Studio state"). To open a theme in the Studio, append its
hash to the Studio URL: `file:///opt/theme-studio/index.html#by=1&theme=...`.

## State

- `theme` is a theme file (`schemaVersion`, `name`, `seeds?`, `overrides?`), edited only through
  the pure functions of `src/state/theme-edit.ts`. A new theme is `{ schemaVersion: 1, name:
  "my-theme" }`: no seeds, so every value is the engine default (the `default` preset's tokens) and
  each edit is one line of the file. Reset deletes a seed or an override; it never writes a default.
- `view` is `{ mode, density }`: `data-theme` and `data-density` on `<html>`.
- Persistence: the state is the versioned hash, written to the address bar (`replaceState`, no
  history entries) and to `localStorage["byterygon.theme-studio.state"]`, 150 ms after the last
  edit. On load: the URL hash, else storage, else a new theme. A hash that does not decode, or a
  newer version, opens with a notice listing what happened. Storage may be missing or throw
  (private windows, some `file://` setups); the Studio then only uses the hash.
- The edited theme is applied to the whole page, the Studio's own controls included. That is on
  purpose: popups render in a portal outside any preview region, so only a page-wide theme shows
  menus, dialogs and toasts as they will look.

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
- A new seed control writes the same key the theme file has (`src/state/theme-edit.ts`), with the
  range `resolveSeeds` accepts (`packages/design-tokens/src/seeds.ts`).
- Never fetch, never load from a CDN, never add a backend. Never depend on anything in `apps/`
  (`scripts/check-licenses.mjs` fails).
- Presets gallery, the contrast report with one-click fixes, import and share links are TSK-49.
