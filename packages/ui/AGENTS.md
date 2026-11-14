# @byterygon/ui

The component set of Byterygon UI (spec "Byterygon UI: design tokens, Theme Studio and component
set", sections 2, 6, 8 and 9a). Components are built on Base UI, styled only with the Tailwind
names of the design-token roles from `@byterygon/design-tokens`, and distributed as a static,
self-hostable shadcn registry. Copy-in, like shadcn: there is no npm package of the components.
Nothing touches the network at build, test or install time.

```
src/components/<name>/<name>.tsx            the component (Base UI part + token classes)
                     /<name>.manifest.json  props, variants, slots, states, tokens, examples, a11y
                     /<name>.example.tsx    a minimal and a realistic example (rendered by tests)
                     /<name>.test.tsx       behaviour tests (keyboard, events, ARIA)
src/lib/cn.ts                               class merging that knows the role names
src/lib/theme-scope.ts                      a popup in a portal takes its trigger's theme and density
gallery/                                    every example in Light/Dark x Comfortable/Compact
scripts/registry.ts                         writes registry/ (committed, drift-tested)
scripts/new-component.ts                    pnpm ui:new
scripts/verify-install.ts                   shadcn CLI install into a blank Vite app, offline
registry/                                   <name>.json, cn.json, theme-scope.json, theme-<preset>.json, registry.json, llms.txt
component.manifest.schema.json              the manifest schema (editors); scripts/lib/manifest.ts validates
```

## Commands

```sh
pnpm ui:new <name> [--part <base-ui-part>] [--json]   # from the repo root: scaffold a component
pnpm --filter @byterygon/ui test                     # Vitest: conventions, behaviour, axe, registry drift
pnpm --filter @byterygon/ui typecheck
pnpm --filter @byterygon/ui registry                 # rewrite registry/ (commit it)
pnpm --filter @byterygon/ui registry:check           # exit 3 if registry/ is stale
pnpm --filter @byterygon/ui verify:install           # real shadcn CLI, offline, folder and static server
pnpm --filter @byterygon/ui gallery                  # serve the gallery (vite)
pnpm --filter @byterygon/ui build                    # build the gallery into dist/gallery
```

`registry`, `ui:new` and `verify:install` take `--json` (one document on stdout). Exit codes: 0 ok,
1 a rule is broken (the document lists the problems), 2 bad command line, 3 stale registry/.

## Adding a component

1. `pnpm ui:new toggle-group --part toggle-group` (a Base UI part; the folder names under
   `node_modules/@base-ui/react`), or `pnpm ui:new kbd` for a styled element on Base UI's
   `useRender`. It writes the four files, a gallery entry (`gallery/entries.ts`, between the
   markers) and the registry item. The result passes every test as generated.
2. Edit `<name>.tsx`: compose the Base UI parts, keep `data-slot`, put every class in
   `<name>Variants` (one key per variant prop) or the `base` list, style states with the Base UI
   data attributes (`data-disabled:`, `data-pressed:`, `data-open:`) and `aria-invalid:`.
   React 19 passes `ref` as a prop: spread `...props` onto the Base UI part and the ref arrives.
3. Fill in the manifest: every prop with its type, default and a sentence; `usage`, a short note
   on when to use it, how to compose it and what to use instead (the gallery and `llms.txt` show
   it); the variants exactly as `<name>Variants`; each state with the variant that styles it and
   the props that cause it; the accessibility checklist. Run the tests: the token test prints the
   exact `tokens` list.
   A component with parts (Field: FieldLabel, FieldDescription, FieldError) keeps the four files
   and exports every part from `<name>.tsx`; list them in `parts` (export name = title + suffix,
   `data-slot` = name + suffix). Parts only render inside the main component, so the examples must
   render each one: the tests take part classes, tokens and states from the elements of the
   examples whose nearest `data-slot` is the component's or a part's. Parts have no variant props.
4. Write behaviour tests in `<name>.test.tsx` (keyboard, events, ARIA, ref).
5. `pnpm --filter @byterygon/ui registry`, then commit the component and `registry/`.

What `test/conventions.test.tsx` enforces for every component:

- exactly the four files; the manifest is valid and its name, title and variants match the code;
- imports: React, `@base-ui/react/*`, the manifest's `dependencies`, and `@/lib/cn`,
  `@/lib/theme-scope` or `@/components/<other>/<other>` only (`LIBS` in scripts/registry.ts lists
  the lib items); no URLs, `fetch` or sockets;
- every class of every variant and state compiles under the token theme alone (Tailwind's default
  theme is not loaded, so `bg-blue-500`, `font-medium` or `max-w-sm` fail), arbitrary values are
  token variables only (`opacity-[var(--by-opacity-disabled)]`), no colour primitive and no raw
  space step (`p-2` resolves to `space.1`: use `p-inset-sm`), and `manifest.tokens` is exactly the
  set of tokens the classes resolve to;
- every listed state is styled (a class uses its variant) and its props set its attribute; classes
  are read from the whole document, so popups in a portal count: give a popup component an
  `open` state with `{ "defaultOpen": true }`, and the suite also clicks each closed
  `aria-haspopup` trigger in the examples so the parts inside the popup are checked;
- the examples render without axe violations (WCAG 2.x A/AA) in Light and Dark, Comfortable and
  Compact. Colour contrast is not measured in jsdom: the token build checks every pair.

## Forms

- Every control goes in a `Field` (`FieldLabel`, the control, `FieldDescription`, `FieldError`) on
  Base UI's Field parts; controls are Base UI `Input` (Field.Control), so Input, Textarea and
  InputGroupInput take the label, description and validity. A new input must work inside Field
  (test it: label, `aria-invalid`, `aria-describedby`).
- Checkbox and Switch go inside their `FieldLabel` with the text (Base UI renders them as a
  `<span role>` beside a hidden input, made to be wrapped by a label). A group of options is one
  Field: RadioGroup and CheckboxGroup are fieldsets (Base UI's `Fieldset.Root` rendered as the
  group), so `FieldLegend` goes first inside them, then a `FieldItem` per option with its
  `FieldLabel` and optional `FieldDescription`. `FieldSet` with `FieldLegend` groups whole Fields.
  An invalid group colours its legend and the controls' borders, not every option's text.
- FieldLabel and the other Field parts need a `Field` around them (Base UI throws otherwise).
- Inputs composed from InputGroup (PasswordInput, SearchInput) and FileInput put `ref` on the
  `<input>` and `className` on the frame; NumberInput and Slider keep Base UI's root ref (`inputRef`
  reaches NumberInput's text control). FileInput is a native `<input type="file">` kept focusable
  and visually hidden; files reach the app through `onFilesChange` and never leave the browser.
- Select, Combobox and MultiSelect render their trigger or frame and their popup themselves; the
  children are the popup's content (SelectItem, or a function from each item to a ComboboxItem).
  Pass Select `items` so the trigger shows the chosen label before the popup has opened. Wire
  TanStack Form's blur to `onOpenChange` (on close). MultiSelect keeps its list open after a
  choice and uses Combobox's items and popup.
- Form state and validation are TanStack Form: `useForm`, `<Form form={form}>`, `form.Field`, and
  `<Field field={field}>`, which maps `isTouched && !isValid`, `isTouched`, `isDirty` and `name`
  to Base UI's controlled `invalid`, `touched`, `dirty`, `name` and gives FieldError the errors.
  Wire the control's `value`, `onValueChange` and `onBlur` to the field. `Form` submits through
  `form.handleSubmit()` (no native validation) and focuses the first invalid control.
- Field itself does not import TanStack Form (a structural `FieldState` type), so it also works
  with Base UI's `validate` or a hand-set `invalid`.

## Styling rules

- Roles, not primitives. Colours: `bg-surface`, `bg-inset`, `text-fg`, `text-fg-muted`,
  `border-border`, `border-border-strong`, `bg-hover`, `bg-pressed`, `bg-selected`, the status
  names (`bg-danger`, `text-danger-solid-fg`, `border-danger-border`, `text-danger-fg`). Size and
  space: `h-control-{xs,sm,md,lg}`, `px-control-x`, `p-inset-*`, `gap-inline-*`, `gap-stack-*`,
  `size-icon-*`, `h-track` (a slider track or thin bar). Type: `text-body`, `text-label`, `text-caption`, `text-code`. Radius:
  `rounded-{xs..xl}`. Elevation: `shadow-raised`, `shadow-overlay`, `shadow-modal`.
- The accent solid is `bg-accent-solid`, `hover:bg-accent-solid-hover`,
  `active:bg-accent-solid-active`, `text-accent-solid-fg`. Never bare `bg-accent`: in a project
  with stock shadcn components (and in every project that installs a theme item) `accent` is
  shadcn's hover background. The test rejects it.
- Secondary actions use the neutral solid (`bg-neutral-solid`, `text-neutral-solid-fg`);
  destructive ones `bg-danger` with `text-danger-solid-fg`, never `text-fg-on-accent`.
- No role exists for motion, opacity, z-index, ring width and offset: use the token variable
  (`duration-[var(--by-motion-duration-fast)]`, `ease-standard`, `z-[var(--by-z-modal)]`,
  `outline-[length:var(--by-ring-width)]`). Breakpoints are not CSS variables; read
  `tokens.ts` if you need the number.
- Focus: `outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)]
  focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring`.
- When no role fits, add one to `@byterygon/design-tokens` (its AGENTS.md), never a raw value here.
- Write every class out in full in the source, never assembled from template strings: Tailwind
  finds classes by scanning the installed files as text.
- Popups (Select, Combobox, menus later) render in a portal: put `useThemeScope`'s `ref` on the
  trigger, spread its `scope` on the positioner and call `refresh` when it opens, so a popup opened
  in a dark or compact region is dark or compact too. Base UI's run-time variables
  (`--anchor-width`, `--available-height`, `--transform-origin`) are not tokens: set them in
  `style` (`popupStyle` in select.tsx), not as arbitrary classes. Numeric props that stand for a
  length (`sideOffset`) read the token at the trigger with `tokenPx`.
- `cn` must know every Tailwind role name (`roleNames` in `src/lib/cn.ts`); a test fails when the
  tokens add one it does not know.

## The registry

`registry/` is a plain folder of shadcn registry items; serve it from any static server or read it
from disk. A project installs from it with the stock shadcn CLI:

```jsonc
// components.json of the project
{
  "tailwind": { "css": "src/index.css", "baseColor": "", "cssVariables": true },
  "aliases": { "components": "@/components", "ui": "@/components/ui", "lib": "@/lib", "utils": "@/lib/utils" },
  "registries": { "@byterygon": "https://ui.internal.example/{name}.json" }   // or "/path/to/registry/{name}.json"
}
```

```sh
shadcn add <base>/theme-default.json @byterygon/button   # static server: names resolve through "registries"
shadcn add /path/to/registry/theme-default.json /path/to/registry/button.json   # folder: pass file paths
```

- `baseColor: ""` stops the CLI from downloading a base colour; the theme item supplies colours.
- On the command line a namespaced name (`@byterygon/button`) is fetched over HTTP; from a folder,
  pass the file path. Dependencies between items (`@byterygon/cn`) resolve through `registries`
  either way, and so does `@byterygon/theme-scope`, which the popup components depend on.
- Items list npm dependencies by bare name; the CLI installs only those missing from the project's
  package.json, so provision them from your mirror first (`meta.dependencyVersions` gives the
  versions tested here). A versioned name would make the CLI reinstall it, and fail offline.
- `theme-<preset>` writes the `--by-*` variables (Light/Dark via `data-theme` or `.dark`,
  Comfortable/Compact via `data-density`), the shadcn aliases, the dark variant, and both Tailwind
  vocabularies into the project CSS. Stock shadcn components are themed with no change. Fonts are
  not in the item: copy `@byterygon/design-tokens/fonts/` and import `fonts.css`, or the system
  fallbacks of `font.sans` and `font.mono` are used.
- Each component item carries its manifest and example in `meta`; `registry/llms.txt` lists them.

## In this repository

Apps in the workspace import the tokens directly (order matters): `fonts/fonts.css`, `tokens.css`,
`@import "tailwindcss"`, `tailwind-theme.css`, and `shadcn-alias.css` only with stock shadcn
components. See `gallery/gallery.css`.

## Never

- Never use Radix (`radix-ui`, `@radix-ui/*`) or another primitive library: Base UI only. Stock
  shadcn references and fixtures come from the `base-nova` style, never `new-york`. Dates and
  times use `react-day-picker` with `date-fns` (as shadcn's Calendar); form state and validation
  use TanStack Form (`@tanstack/react-form`) with Base UI's Field parts. Anything else Base UI
  lacks is built on `useRender` and the existing parts.
- Never use a raw colour, a raw length, a Tailwind palette class or a default-theme scale.
- Never use bare `accent` colour utilities; use the `accent-solid` names.
- Never edit `registry/` by hand; change the component or the manifest and run `registry`.
- Never fetch, load a font or script from a CDN, or name a URL in a component.
- Never depend on AGPL code (`apps/`); this package is MIT OR Apache-2.0 and the licence check fails.
- Never skip the manifest: the registry build stops on an invalid one.
