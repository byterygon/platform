# Stock shadcn/ui items (base-nova style)

`button.json`, `card.json` and `input.json` are the registry items of shadcn/ui's `base-nova`
style (Base UI primitives), downloaded unmodified on 2026-11-14 from
`https://ui.shadcn.com/r/styles/base-nova/<name>.json`. They are MIT licensed
(`LICENSE.md`, copyright shadcn).

`scripts/verify-install.ts` installs them, offline, into a blank Vite app next to a Byterygon theme
item and checks that the theme reaches them: `bg-primary`, `bg-card`, `border-input` and the
rest resolve to the Byterygon roles in Light and Dark. They are test data, not shipped code.
