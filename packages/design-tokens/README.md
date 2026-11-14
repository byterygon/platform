# @byterygon/design-tokens

Byterygon design tokens: a theme file of seeds plus overrides becomes DTCG tokens (OKLCH ramps,
roles with light/dark and comfortable/compact modes, contrast checked in every mode) and the
outputs an app needs: `tokens.css`, `tailwind-theme.css`, `shadcn-alias.css`, `tokens.ts`,
`tokens.dtcg.json` and `figma-variables.json`.

```sh
pnpm --filter @byterygon/design-tokens build     # compile the engine and the CLI
pnpm --filter @byterygon/design-tokens tokens help
```

Six presets (Byterygon `default`, Slate, Paper, Midnight, Terminal, High contrast) are checked for
WCAG 2.2 contrast in both colour modes, and Inter and JetBrains Mono ship in `fonts/` under the SIL
Open Font License (the package's code is MIT OR Apache-2.0; the fonts are not, see
[fonts/README.md](./fonts/README.md)).

Everything a contributor or an agent needs (commands, the theme file, the tiers, the rules, how
to add a role or a preset, what never to do) is in [AGENTS.md](./AGENTS.md).

Licensed under either of MIT or Apache-2.0, at your option.
