# @byterygon/ui

Byterygon UI components: Base UI primitives styled with the roles of `@byterygon/design-tokens`,
shipped as a self-hostable shadcn registry (`registry/`). Works offline end to end.

- Components: Button, IconButton, ToggleButton, ToggleGroup, Input, Textarea, NumberInput, PasswordInput, SearchInput, InputGroup, Checkbox, RadioGroup, Switch, Slider, FileInput, Field, Form (TanStack Form), Kbd (more in waves 1 to 3 of the spec).
- Theme items: `theme-default`, `theme-slate`, `theme-paper`, `theme-midnight`, `theme-terminal`,
  `theme-high-contrast`. Installed into a shadcn project, they theme stock shadcn components too.
- `pnpm ui:new <name>` scaffolds a component that passes every convention test.

See [AGENTS.md](AGENTS.md) for the layout, commands, styling rules and how to install from the
registry. Licence: MIT OR Apache-2.0. `test/fixtures/shadcn-base-nova/` holds unmodified stock
shadcn/ui items (MIT, see its LICENSE.md) used only by `verify:install`.
