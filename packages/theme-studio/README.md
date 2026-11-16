# @byterygon/theme-studio

Byterygon Theme Studio: tune the design tokens visually. Change the seeds (hue, chroma, tint,
radius, font size, fonts, default mode, density, contrast level) or any token, see real Byterygon
UI components and every colour ramp and role change at once in Light, Dark, Comfortable and
Compact, and keep the result as a theme file that `by-tokens` builds.

A static app: build it once, then open `dist/index.html` from a folder or serve `dist/` from any
web server. It makes no network requests.

```sh
pnpm --filter @byterygon/design-tokens build
pnpm --filter @byterygon/theme-studio build      # writes dist/
pnpm --filter @byterygon/theme-studio dev        # development server
```

See `AGENTS.md` for how it works and the headless equivalent of every action.

License: MIT OR Apache-2.0.
