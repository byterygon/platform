# @byterygon/design-tokens

Byterygon design tokens: a theme file of seeds plus overrides becomes DTCG tokens (OKLCH ramps,
roles with light/dark and comfortable/compact modes, contrast checked in every mode) and the
outputs an app needs: `tokens.css`, `tailwind-theme.css`, `shadcn-alias.css`, `tokens.ts`,
`tokens.dtcg.json`, `figma-variables.json`, `monaco-theme.ts` and a shadcn registry theme item
(`registry-theme.json`). The same code runs in the browser for the Theme Studio.

```sh
pnpm --filter @byterygon/design-tokens build     # compile the engine and the CLI
pnpm --filter @byterygon/design-tokens tokens help
```

Seven presets (Byterygon `default`, Slate, Paper, Midnight, Terminal, High contrast, Aurora) are checked for
WCAG 2.2 contrast in both colour modes. The interface font is the system's Segoe UI Variable where
it is installed (it is never shipped), else Selawik; Selawik, JetBrains Mono and Inter ship in
`fonts/` under the SIL Open Font License (the package's code is MIT OR Apache-2.0; the fonts are not, see
[fonts/README.md](./fonts/README.md)).

Every theme also carries the roles of the layered look (Fluent 2): a backdrop gradient for the
app root, translucent layers on it, control strokes with a darker bottom edge, a focus underline
for fields, a double focus ring, Fluent depth shadows for flyouts and dialogs, and a blur for what
shows through. Contrast on a layer is checked over the backdrop at its least favourable point.

The text roles are Fluent 2's type ramp (caption, body, subtitle, title, large title, display,
scaled by the `fontSize` seed) and the motion tokens Fluent 2's durations and curves; the older
role names remain as aliases.

Everything a contributor or an agent needs (commands, the theme file, the tiers, the rules, how
to add a role or a preset, what never to do) is in [AGENTS.md](./AGENTS.md).

Licensed under either of MIT or Apache-2.0, at your option.
