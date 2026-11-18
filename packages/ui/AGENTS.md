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
src/lib/control.ts                          the double focus ring, Fluent's size names and the aliases kept for one release
src/lib/theme-scope.ts                      a popup in a portal takes its trigger's theme and density
src/lib/monaco.ts                           Monaco loaded lazily and offline, its languages (JSON with schemas, YAML, Protobuf) and its theme from the tokens
                                            (its colour mapping is @byterygon/design-tokens/monaco)
src/lib/icons.ts                            Fluent UI System Icons as path data (generated from icons/, committed)
icons/                                      the vendored Fluent icons: fluent/*.svg, manifest.json, LICENSE (MIT)
scripts/icons.ts                            icons build / add / refresh / list (offline)
gallery/                                    every example in Light/Dark x Comfortable/Compact
scripts/registry.ts                         writes registry/ (committed, drift-tested)
scripts/lib/llms.ts                         registry/llms.txt and llms-full.txt (from the manifests, examples and tokens)
scripts/new-component.ts                    pnpm ui:new
scripts/verify-install.ts                   shadcn CLI install into a blank Vite app, offline
scripts/browser-check.ts                    the editors in Chromium over the DevTools protocol (test/browser)
registry/                                   <name>.json, cn.json, theme-scope.json, theme-<preset>.json, registry.json, llms.txt, llms-full.txt
component.manifest.schema.json              the manifest schema (editors); scripts/lib/manifest.ts validates
```

## Quickstart: a project that installs from the registry

What an agent does in a blank Vite + React + Tailwind v4 app (the steps the TSK-50 end-to-end check
took, with what tripped it up):

1. Install a theme and the components: `by-ui-mcp call install_registry_item '{"project":".","items":["theme-default","card","button"],"dryRun":true}'`,
   then again without `dryRun` (or the shadcn CLI: "The registry", below). A theme file of your own:
   `install_theme` with the file's path (`packages/design-tokens/AGENTS.md`, "Presets").
2. In the main CSS: `@import "tailwindcss";` then `@import "./byterygon-theme-default.css";`. Light
   mode needs no attribute (`:root` is light); dark is `data-theme="dark"` (or `.dark`), compact
   `data-density="compact"`, on any element.
3. Fonts are not in the theme: copy `@byterygon/design-tokens/fonts/` and import its `fonts.css`
   first, or the system fallbacks are used.
4. The npm packages `missingDependencies` lists (`@base-ui/react`; `cn` is the npm package the
   `cn` helper imports) come from your mirror: the items do not install them.
5. TypeScript with `"types": []` needs `/// <reference types="vite/client" />` (a `src/vite-env.d.ts`)
   for `import "./index.css"`.
6. Lint: the two config files of `packages/lint/README.md`. The installed theme CSS opens with the
   "Byterygon design tokens" header, so Stylelint leaves it alone.
7. Names: the `brand` ramp (`color.brand.1`-`12`, primitives) feeds the `accent` roles
   (`color.accent.bg` is `bg-accent-solid` in Tailwind, `--by-color-accent-bg` in CSS); a role's
   three names are in `llms-full.txt` and `explain_token`. Switching themes: import one
   `byterygon-theme-*.css` only (`install_theme` names the others it finds).
8. Vite prints a `MODULE_LEVEL_DIRECTIVE "use client"` warning per Base UI file; it is harmless.
9. Read each component with `get_component` before using it: props follow Fluent (`appearance`,
   `size` small/medium/large) on the controls; Badge and Tag keep `variant` for their tone and
   `sm`/`md` sizes (open question 122).

## Commands

```sh
pnpm ui:new <name> [--part <base-ui-part>] [--json]   # from the repo root: scaffold a component
pnpm --filter @byterygon/ui test                     # Vitest: conventions, behaviour, axe, registry drift
pnpm --filter @byterygon/ui typecheck
pnpm --filter @byterygon/ui registry                 # rewrite registry/ (commit it)
pnpm --filter @byterygon/ui registry:check           # exit 3 if registry/ is stale
pnpm --filter @byterygon/ui verify:install           # real shadcn CLI, offline, folder and static server
pnpm --filter @byterygon/ui check:browser            # editors in Chromium: bundle, theme, keyboard, 1 MB, report
pnpm --filter @byterygon/ui icons build [--check]    # write src/lib/icons.ts from icons/ (exit 3 if stale)
pnpm --filter @byterygon/ui icons add <name...> --from <tgz|dir>   # vendor Fluent icons from a copy on disk
pnpm --filter @byterygon/ui icons list               # the vendored icons and their sizes
pnpm --filter @byterygon/ui gallery                  # serve the gallery (vite)
pnpm --filter @byterygon/ui build                    # build the gallery into dist/gallery
pnpm --filter @byterygon/ui lint                     # @byterygon/lint: no raw colours, arbitrary values or raw space steps
```

`registry`, `ui:new`, `icons` and `verify:install` take `--json` (one document on stdout). Exit codes: 0 ok,
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
6. `pnpm --filter @byterygon/ui lint`: the lint rules name the role for any raw value left.

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

## Fluent 2 API (TSK-53)

Byterygon UI follows Fluent 2's anatomy and prop names on Base UI (DOC-17 open question 104 (c)).

- **Appearance**: Button, IconButton, ToggleButton and SplitButton take `appearance` = `primary` |
  `secondary` | `outline` | `subtle` | `transparent` (Button and IconButton also Byterygon's
  `danger`: Fluent has none). Primary is the accent solid; secondary a translucent layer
  (`bg-layer`) with a hairline (`border-border-subtle`) and a darker bottom edge
  (`border-b-border-control-bottom-subtle`); outline an edge with no fill; subtle a wash on hover with
  the icon turning accent; transparent no fill ever, accent text on hover. ToggleGroup is `outline`
  (a segmented track) or `subtle`. Defaults stay what they were (Button and SplitButton primary,
  IconButton and ToggleButton subtle, ToggleGroup outline), so code without the prop looks as meant.
- **Size**: `small` | `medium` | `large` (default medium). Comfortable is Fluent's 24, 32 and 40 px
  (`size.control.sm`, `md`, `lg`); compact maps the same names onto 22, 28 and 34 px. Text:
  `text-caption-1`, `text-body-1-strong`, `text-subtitle-2`; icon: `size-icon-md`, `lg`, `xl` (16,
  20, 24 px); padding `inset-xs`, `control-x`, `inset-md` (Fluent's 8, 12, 16 px when comfortable).
- **Aliases for one release**: the old `variant` (`ghost` is `subtle`; ToggleButton's and ToggleGroup's
  `outline` is `outline`) and `sm`/`md`/`lg` still work. They are `@deprecated` in the types, listed in
  the manifest's `props` with `deprecated` (what to use instead; `llms.txt` prints it), mapped by
  `controlAppearance` and `controlSize` from `@/lib/control`, and tested. `appearance` wins over
  `variant`. The rendered element always carries the Fluent names (`data-appearance`, `data-size`).
  DBee moved to the Fluent names in TSK-55; the next release removes the aliases.
- **Focus**: every control uses `focusRing` (or `focusRingWithin` when focus sits on an element
  inside it) from `@/lib/control`: an outline in `ring.color` (`ring.width`, offset by
  `ring.inner-width`) around a box-shadow in `ring.inner-color`. Forced-colours mode keeps the
  outline. Never write the focus classes again in a component. Joined controls (SplitButton, the
  outline ToggleGroup) lift the focused part (`focus-visible:relative`) so its ring is never covered.
- **Disabled**: filled appearances take `bg-disabled` and `border-border-disabled`, every appearance
  `text-fg-disabled` (Fluent's disabled colours, not an opacity); loading shows as disabled, as
  Fluent's `disabledFocusable`.
- **Checked** (ToggleButton, ToggleGroup items): `bg-selected` (hover `bg-selected-hover`) with the
  default text, the accent's pressed solid on primary, accent text on transparent. Pass the Icon
  `filled` while pressed, as Fluent does.
- **Motion**: hover and state changes `duration-[var(--by-motion-duration-faster)] ease-easy-ease`.
- **Fields** (TSK-53 batch 2: Input, Textarea, InputGroup, SearchInput, PasswordInput, FileInput,
  NumberInput, DatePicker, TimePicker, Select, Combobox, MultiSelect): `appearance` = `outline`
  (default: `bg-layer-alt`, a `border-border-subtle` hairline and the `border-b-border-control-bottom`
  edge that makes the field 3:1) | `underline` (the bottom edge only, no fill or corners) |
  `filled-darker` (`bg-inset`) | `filled-lighter` (`bg-surface`); every appearance keeps the bottom
  edge, unlike Fluent's filled ones, so a field is always 3:1. Sizes as Button's, with text
  `caption-1`, `body-1`, `body-2`. The shared pieces are `fieldAppearances`, `fieldSizes`,
  `fieldPadding`, `fieldFrame` and `fieldStates` in `@/lib/control`; a frame around a control
  (InputGroup, NumberInput, Combobox) writes the states with `has-[…]` on its control's slot.
- **Field focus** is Fluent's accent underline (`shadow-focus-underline`), not the double ring;
  Select, Combobox and MultiSelect keep it while their list is open (`data-popup-open:`). Buttons
  inside a field (clear, show password, the calendar, the steppers) keep the double ring.
- **Invalid**: the hairline turns `border-danger-border` and the bottom edge `border-b-danger-stroke`
  (`color.status.danger.stroke`, a 3:1 pair on every fill a field takes; the danger solid is for
  buttons and is too dark in dark mode); FieldError starts with Fluent's filled
  ErrorCircle. **Disabled**: no fill, `border-border-disabled`, `text-fg-disabled` (placeholder too).
- Fluent's hover on a field changes its stroke by a shade the roles do not have, so fields keep
  their look on hover.
- **Checkbox, RadioGroup, Switch, Slider** (batch 3): sizes `small | medium | large` (Fluent's medium is
  the default: a 16 px box or radio, a 14 px switch thumb, a 20 px slider thumb). Unchecked controls
  sit on `bg-layer-alt` with `border-border-strong`; Checkbox ticks with a filled Checkmark (Subtract when
  mixed) on the compound accent (`bg-accent-compound`, `text-accent-compound-fg`); a chosen radio has
  a compound accent stroke and a filled Circle dot; Switch is Fluent's outlined track with a
  `bg-fg-muted` thumb, the compound accent track and an `accent-compound-fg` thumb when on; Slider is a `border-strong` rail, the accent for the chosen part and an accent disc in a
  ring of the surface colour. All take the double ring (Slider's thumb through `focusRingWithin`).
- **Flyouts** (menus, Popover, HoverCard, the lists of Select/Combobox/MultiSelect, DatePicker's
  calendar): `flyoutSurface` (`bg-overlay`, `border-border-subtle`, `shadow-flyout`, `rounded-lg`,
  body-1) and `flyoutMotion` (slide by `space.inline.sm` from the trigger's side and fade in,
  `normal` + decelerate; fade out, `fast` + accelerate) from `@/lib/control`. Items are
  `flyoutItem` (32 px comfortable, 16 px icon, `bg-hover` while highlighted; menu icons turn accent),
  group labels `flyoutLabel`, dividers `flyoutSeparator`. Flyouts are opaque, not acrylic: Fluent 2's
  web components draw them solid, and text on a translucent popup over arbitrary content cannot be
  contrast-checked (DOC-17).
- **Tooltip** takes `appearance` on its root: `normal` (default, the light flyout surface) or
  `inverted` (the neutral solid, the look before TSK-53).
- **Overlays** (batch 4): Dialog, AlertDialog and Sheet are elevation.dialog (`bg-overlay`,
  `border-border-subtle`, `shadow-dialog`, `rounded-lg` for dialogs), titled in `text-subtitle-1`;
  dialogs scale and fade in over `gentle` (decelerate) and out over `fast` (accelerate), sheets slide
  in over `gentle` and out over `normal`; the close button is Fluent's Dismiss. AlertDialogCancel is a
  secondary Button by default (Fluent's dialog actions). CommandPalette's search row is an
  underline SearchBox (body-2, Fluent's Search icon).
- **Status** (batch 4): Alert is Fluent's MessageBar: `intent` (`variant` is the alias for one
  release) tints the box and colours a filled icon (Info, CheckmarkCircle, Warning, ErrorCircle);
  Toast leads with the same filled intent icon instead of a coloured edge. Warning is always the
  orange status role and Fluent's Warning icon; Tag gains a `warning` tone, Badge already has one.

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
- Dates and times: Calendar is react-day-picker with every class replaced (its `classNames` map
  is complete, so no `rdp-*` class or stylesheet is needed); the day buttons carry their state as
  data attributes (`data-selected`, `data-today`, `data-range-middle`). DatePicker is a text
  field on InputGroup, read with date-fns in `format` on blur and Enter, plus a Calendar in a
  Popover; its value is a local `Date` (range: `{ from, to }`) or null when the text is not a
  date (then the field is aria-invalid). TimePicker is one Base UI Input edited by segment; its
  value is "HH:mm" or "HH:mm:ss" on the 24-hour clock, null until complete. Validate null as
  missing in TanStack Form.
- Form state and validation are TanStack Form: `useForm`, `<Form form={form}>`, `form.Field`, and
  `<Field field={field}>`, which maps `isTouched && !isValid`, `isTouched`, `isDirty` and `name`
  to Base UI's controlled `invalid`, `touched`, `dirty`, `name` and gives FieldError the errors.
  Wire the control's `value`, `onValueChange` and `onBlur` to the field. `Form` submits through
  `form.handleSubmit()` (no native validation) and focuses the first invalid control.
- Field itself does not import TanStack Form (a structural `FieldState` type), so it also works
  with Base UI's `validate` or a hand-set `invalid`.

## Overlays and navigation (wave 2)

- Overlays are a root plus parts, as in shadcn: `Dialog` (no element) > `DialogTrigger` +
  `DialogContent` > `DialogHeader` (`DialogTitle`, `DialogDescription`), `DialogBody`,
  `DialogFooter`. Triggers and close buttons are unstyled Base UI parts: render a Button through
  `render` (`<DialogTrigger render={<Button appearance="secondary" />}>`). A root's look (`size`,
  `side`) is a prop of the root, which its parts read from context; parts take no variant props.
- AlertDialog and Sheet reuse `dialogClasses` and `useDialogScope` from dialog.tsx; HoverCard reuses
  `popoverClasses`. A new overlay reuses them too rather than restyling a scrim or a popup.
- Menus: DropdownMenu, ContextMenu and Menubar build their items with `createMenuParts(prefix)` and
  `menuClasses` from dropdown-menu.tsx (same look, `data-slot` under each prefix) and share a
  theme scope through `MenuScopeContext`, so submenus match their root. SplitButton composes Button,
  IconButton and DropdownMenu; its menu content is DropdownMenu's items. Disabled menu items stay
  focusable with `aria-disabled` (ARIA menu pattern), as Base UI does.
- A dialog may open without a trigger, so its content renders a hidden anchor where it sits in
  the JSX and the popup takes that region's theme and density. Popover-like roots put
  `useThemeScope`'s ref on the trigger through `useMergedRef` (the caller's `ref` still arrives).
- Tabs: closable tabs keep their close button out of the tab order and `aria-hidden` (the tablist
  holds only tabs); Delete closes the focused tab (`aria-keyshortcuts`). Reordering is drag or
  Alt+Shift+Arrow through TabsList `onReorder(value, index)`; the app owns the array.
- Toast and CommandPalette render their items from data, so each exports its item as a part
  (`ToastItem`, `CommandPaletteItem`) for the suite to find in the examples. CommandPalette is a Dialog
  around an inline Base UI Autocomplete (no cmdk: it pulls in Radix); the example's opener has
  `aria-haspopup="dialog"`, which is also correct for users. Toast's `placement="static"` puts the region
  in the page flow for previews and tests.
- Navigation: Breadcrumb is a `<nav>` with an `<ol>` on `useRender` (BreadcrumbLink takes `render`
  for a router link); Pagination and Stepper are data-driven (`page`/`pageCount`, `steps`/`value`)
  and compose Button and IconButton; NavigationMenu renders its shared popup itself, and a link
  placed straight in the row takes `className={navigationMenuTriggerStyle}`.
- Tree is the ARIA treeview pattern built here (Base UI has none): data-driven nodes, rows of
  `size.control.sm` (or `size.control.md` with `size="medium"`, Fluent's medium tree item, which
  DBee uses) rendered only while visible, one tab stop with `aria-activedescendant` (the
  active row is always rendered), `aria-level`/`aria-setsize`/`aria-posinset` on a flat DOM. The app
  owns lazy loading: set `loading`, then `children` or `error`, from `onExpandedChange`/`onRetry`.
- Sidebar: SidebarProvider holds the state and Ctrl/Cmd+B; collapsed labels stay in the
  accessibility tree (`sr-only`) and show as Tooltips. Use `in-*` variants (`in-focus-visible:`)
  rather than `group`: a bare `group` class is not a token utility and the check rejects it.
- Data-driven components whose rows only exist with data (Toast, CommandPalette, Stepper, Tree)
  export the row as a part so the conventions suite reads it from the examples.
- Layers: scrim `z.overlay`, dialogs and sheets `z.modal`, everything attached to a control
  (popovers, menus, the lists of Select and Combobox) `z.popover`, so they open above a dialog;
  toasts `z.toast`, tooltips `z.tooltip`.
- Motion follows Fluent 2 (`motion.duration.*`: `ultra-fast` 50 ms to `ultra-slow` 500 ms;
  `motion.easing.*`): `ease-decelerate-mid` for what enters, `ease-accelerate-mid` for what
  leaves, `ease-easy-ease` for what moves; small elements take the short durations. `ease-standard`,
  `ease-enter`, `ease-exit`, `ease-emphasized` and `motion.duration.base` are aliases kept from
  before. In script (the Web Animations API takes no `var()`), `@/lib/motion` has
  `MOTION_DURATION_MS`, `MOTION_EASING`, `durationVar`, `easingVar` and `tokenEasing`.
- Motion: an element that moves (`transition`, `transition-transform`, an animation) also carries
  `motion-reduce:transition-none` (or `motion-reduce:animate-none`); colour and opacity fades may
  stay. `honoursReducedMotion` in `test/interact.ts` checks it; each overlay test calls it.
- Tests use `test/interact.ts` (`click`, `press`, `key`, `hover`, `focus`, `waitFor`, `zLayer`):
  open, keyboard, Escape and outside press, focus moving in and back to the trigger, ARIA roles,
  the theme scope and reduced motion. Base UI moves focus asynchronously: wait for it.
- The conventions suite opens every closed `aria-haspopup` trigger in the examples to read the
  popup's classes, then each popup trigger inside that popup (submenus), and right-clicks the
  component's own `<name>-trigger` when it has no `aria-haspopup` (ContextMenu). A popup opened only
  by hover or focus (Tooltip, HoverCard) needs an example with `defaultOpen`. Inner
  elements are named `<name>-<part>` (`popover-positioner`) so their classes count as the
  component's; list them under `slots`.

## Layout and data display (wave 3, TSK-45)

- Base UI's run-time lengths (`--collapsible-panel-height`, `--accordion-panel-height`,
  `--scroll-area-thumb-height`) are not tokens, so they never appear in a class. Collapsible and
  Accordion panels fade (opacity) instead of animating their height; ScrollArea sets the thumb
  length in `style`.
- ScrollArea keeps its scrollbars mounted (`keepMounted`) and hides a bar whose axis does not
  overflow (`not-data-has-overflow-y:invisible`), so tests and browsers see the same DOM. The
  viewport is the scroll container: a virtualized list inside reads it through `viewportRef`.
- Base UI adds `base-ui-*` classes for its own injected styles (`base-ui-disable-scrollbar`);
  `isLibraryClass` in `test/render.tsx` keeps them out of the token check. Never add one yourself.
- `end-0` compiles to `calc(var(--by-space-1) * 0)` under the token theme and is rejected; use
  `inset-e-0` (and `inset-s-0`). `top-0`, `inset-x-0` and `h-0` compile to `0px` and are fine.
- Grid templates with arbitrary tracks (`grid-cols-[1fr_auto]`) are not token values; lay out
  with flex (`order-*`, `basis-full`, `flex-1`) instead, as CardHeader does.
- Base UI's Accordion has no arrow-key movement between headers (optional in the ARIA pattern);
  its triggers are reached with Tab.
- A component whose root may sit in a start-aligned flex parent takes `w-full` when it should
  fill the width (Accordion); callers cap it with `max-w-*`.
- Resizable is the ARIA window splitter built here (Base UI has none): panels and handles are
  direct children of `Resizable` (it reads their props and gives each its index); sizes are
  percentages, controlled through `sizes`/`onSizesChange` to persist them. `ResizablePanelGroup`
  is an alias. Style a part by its own `data-orientation`, not `in-data-[orientation=…]`: groups
  nest, so an ancestor of the other orientation matches too.
- Base UI's Toolbar moves focus with the arrow keys and wraps (`loopFocus`); it has no Home/End.
- Two-axis looks (Badge: tone × appearance) put every appearance's classes in each tone behind
  `data-[appearance=…]:`, so `<name>Variants` keeps one key per prop without compound variants.
- Looping motion (Spinner, an indeterminate Progress, Skeleton's pulse) goes through `@/lib/motion`
  (`useLoopAnimation`, the Web Animations API): the token theme has no `@keyframes` and
  `animate-*` defaults do not compile. Periods are multiples of `motion.duration.slow` (300 ms)
  (`tokenMs`); loops never start under `prefers-reduced-motion`, and jsdom has no
  `element.animate`, so stub it in tests that check the loop.
- The suite reads the examples' classes only for components with `parts`. A component that
  renders optional inner elements from props (Progress's label and value) exports them as parts,
  or their classes go unchecked.
- Table is the plain semantic table (TSK-45 decision: a presentational primitive; the Arrow
  DataGrid is TSK-39's own package). It shares the `grid.*` roles with the DataGrid so they look
  alike. `TableVirtualBody` renders the rows in view between two `aria-hidden` spacer rows inside
  a Table with a height, sets `aria-rowcount` on the table and `aria-rowindex` on rows, and
  needs one-line rows (cells truncate). Browsers cap an element near 33.5 million px, so it
  serves up to ~900k rows (comfortable) or ~1.5M (compact); beyond that, the DataGrid.
- Anything that can show more than ~1,000 rows or items is virtualized (Tree, Table's virtual
  body, CodeBlock and JsonViewer); state the limit in the manifest.
- CodeBlock highlights without an editor: the CodeMirror grammars (`PostgreSQL.language.parser`,
  `jsonLanguage.parser`) parse once and `@lezer/highlight`'s `highlightCode` colours only the lines
  rendered, through a `tagHighlighter` that maps tags to `text-syntax-*` classes (the same roles
  as CodeInput and SqlEditor). Above 1,000 lines it renders a window between spacers.
- JsonViewer follows Tree (ARIA treeview, `aria-activedescendant`, rows of `size.control.xs`
  rendered only in view). Paths are JSON Pointers. A new `value` object resets what is open.
- Charts are SVG built here (Base UI has none; the project rule is to build what it lacks rather
  than add a library, so no Recharts). Series take `chart.cat.1..8`, and lines/areas also get a
  dash pattern and a marker shape so colour is never the only cue; long series are decimated to
  min/max per pixel column; the data is in a visually hidden table (a summary above 1,000 rows).
  Numbered colour classes are written out (`strokeClass`, `fillClass`, `softFillClass`).
- A boolean prop is never a variant key (the suite passes variant values as strings, so
  `"false"` would be truthy): style it through a `data-*` attribute and list it as a state.
- Part names start with the title (`DescriptionListItem`, slot `description-list-item`).
- A prop that picks a colour from a numbered role (Tag `swatch` → `bg-chart-1..8`) maps to class
  strings written out in full, and the example shows every value so the token test checks them.

## Editors (TSK-46)

- SqlEditor is Monaco, never loaded from a CDN or through Monaco's AMD loader: `@/lib/monaco`
  (`loadMonaco`) dynamically imports the ESM editor core, the features it needs and the `pgsql`/`sql`
  grammars, and creates the one editor worker through Vite's `?worker`. Vite puts all of it (CSS and
  the codicon font included) in chunks that load on first mount; nothing is fetched from elsewhere.
  With another bundler, set `self.MonacoEnvironment.getWorker` and replace the `?worker` import.
- Until Monaco has loaded, a textarea with the same text, colours, name and Ctrl+Enter stands in
  (`data-loading`, `aria-busy`); Monaco then takes over the text, the selection and the focus.
- Controlled SqlEditor (`value` + `onValueChange`): every user edit is reported, and the editor keeps
  the values it reported that the app has not rendered back yet. A `value` equal to one of them is
  the app catching up and is never applied, even when it is older than the text now (a key typed and
  deleted before the app re-rendered would otherwise come back: TSK-56). Any other `value` replaces
  the text as one undoable edit and is not reported back.
- Theme: Monaco's `defineTheme` takes hex, so `monacoTheme` reads `editor.*`, `syntax.*` and the
  overlay roles at the editor's element (the browser resolves the OKLCH variables there) and
  converts them; `monacoMetrics` takes the font from `text.code.*` and the padding from
  `space.inset.sm`. A MutationObserver rebuilds both when `data-theme`, `data-density` or a class
  changes on the editor or an ancestor, or a stylesheet changes (a swapped preset).
- Monaco has one theme per page, so `applyTheme` also writes scoped CSS: inside
  `[data-monaco-scope]` (the SqlEditor root) Monaco's colour variables (`--vscode-*`) and token
  classes (`.mtk<n>`) point at the `--by-*` variables, so editors in a Light and a Dark region side
  by side are both right. Popups Monaco renders outside the editor (its context menu) use the theme
  of the editor mounted, focused or rethemed last.
- Never pass raw colours to Monaco; add a role to `MONACO_COLORS` / `MONACO_TOKENS` instead. They
  and `monacoTheme` live in `@byterygon/design-tokens` (`src/monaco.ts`), one source with its
  `monaco-theme.ts` output and the Theme Studio's export; `lib/monaco.ts` imports them, and the
  registry ships that file as the `monaco-theme` lib item (`@/lib/monaco-theme`), a registry
  dependency of `monaco`. A lib item with `source` in `LIBS` is a token-package module shipped as is.
- CodeEditor (TSK-80) is SqlEditor's sibling for JSON, YAML, Protobuf and plain text, on the same
  `loadMonaco`, theme, fallback textarea and controlled-value rules. `loadMonacoLanguage` loads a
  language once in a chunk of its own: YAML and Protobuf are grammars; JSON adds Monaco's JSON
  language service and its own worker (`json.worker?worker`; `getWorker` routes by label).
  `setJsonSchema(modelUri, schema)` keeps one schema per model (each CodeEditor has its own
  `inmemory://` URI) and gives them all to the service with `enableSchemaRequest: false`, so a
  `$ref` is never fetched. `onDiagnosticsChange` reports the service's markers (not the app's
  `markers`, which carry the owner `byterygon`); `diff` mounts a diff editor whose original side is
  never editable. Mod+Enter calls `onSubmit`. The browser check proves the JSON worker validates a
  schema in Chromium.
- HexView and KeyValueEditor (TSK-80) are plain components: HexView virtualizes rows as JsonViewer
  does (rows of `size.control.xs`, the active byte always rendered for `aria-activedescendant`) and
  lines columns up with spaces in the monospace font (no `ch` widths: arbitrary values must be
  tokens); KeyValueEditor is Input, Select, IconButton and Button, controlled by `value`/`onChange`.
- CodeInput is CodeMirror 6, imported statically (small, and a form field must work at once). Its
  `EditorView.theme` and `HighlightStyle` use the token variables directly (`var(--by-editor-fg)`,
  `var(--by-syntax-keyword)`, `var(--by-text-code-size)`), so modes, density and presets apply with
  no JavaScript. One line by default (Enter calls `onSubmit`, line breaks become spaces), `multiline`
  with `rows`, `pretty` for a read-only JSON viewer; Tab always leaves. A multi-line frame is the
  scroll container (set its height with `max-h-*`); CodeMirror renders only the visible lines.
- CodeInput in a Field: a visually hidden Base UI `Input` (`code-input-control`, `tabIndex=-1`,
  `aria-hidden`) carries the value, name and validity and takes the Field's label id, description
  and `data-invalid`; CodeInput mirrors them onto CodeMirror's text area and its root (a
  MutationObserver, because the Field updates its control without re-rendering CodeInput) and
  forwards focus and blur to the control. A FieldLabel click focuses the text area.
- A library's own DOM (CodeMirror's `cm-*` classes) goes inside an element with `data-foreign-dom`;
  the conventions suite skips the classes of its descendants. Never put Byterygon classes there.
- jsdom cannot run Monaco: in tests every `monaco-editor/*` import is aliased to
  `test/fakes/monaco.ts`. The real editor is checked by `scripts/browser-check.ts` (CI runs it with
  the runner's Chrome in a network namespace; `BYTERYGON_REQUIRE_BROWSER=1` makes a missing browser
  a failure, `BYTERYGON_BROWSER` names one). Its internal-network case serves the same build from a
  sub-path (`/intranet/dbee/`) under each CSP Byterygon apps send (`INTERNAL_CSPS`: the DBee server's
  and the Tauri desktop's) and fails on a CSP violation, a request outside the sub-path or a worker
  that does not start. Monaco needs no network, no CDN, no AMD loader and no `unsafe-eval`; it does
  create `<style>` elements at run time (no nonce support), so a CSP without
  `style-src 'unsafe-inline'` strips its colours: the Tauri case is a reported known issue until
  that decision is made (TSK-56).
- `test/licenses.test.ts` checks every npm package a registry item installs, transitively, against
  the `allow` list of `deny.toml`.

## Fluent 2 surfaces (TSK-55)

Card, Table, Sidebar, Tabs, StatusBar and Toolbar are translucent layers over the backdrop:
`bg-layer`, a `border-border-subtle` hairline, radius.lg (8 px), and `shadow-layer` on the free-standing
ones (`layerSurface` in `@/lib/control`). Card takes `appearance` = `filled` (default) |
`filled-alternative` | `outline` | `subtle` (old `variant`: outline, raised = filled, inset =
filled-alternative); Tabs takes `appearance` = `transparent` (default, the old `line`) | `subtle` |
`enclosed` and size small | medium | large (old `sm`/`md` still work). Every focusable part uses
`focusRing`; chevrons, sort arrows, close and panel icons are `Icon`s; motion is Fluent's (faster/normal,
easy-ease/decelerate). Text roles are the Fluent ramp (`text-body-1`, `text-body-1-strong`, `text-caption-1`).

## Icons (TSK-57)

Fluent UI System Icons (MIT), vendored in `icons/` as a curated set: 83 icons, each in regular
and filled at 16, 20 and 24 px where Fluent draws them. The source is `@fluentui/svg-icons` 1.1.346
(`microsoft/fluentui-system-icons`, commit `ba34950`), pinned in `icons/manifest.json` with the
tarball's sha256 and every file's sha256 (vendored and upstream). The files are Fluent's artwork
reduced to path data in `currentColor` (width, height and the namespace are dropped, `viewBox` is
kept); `scripts/icons.ts` refuses anything else (colour icons, other shapes). `src/lib/icons.ts` is
generated from them (`icons build`), carries the MIT notice, and ships as the `@byterygon/icons`
registry item, which `@byterygon/icon` depends on.

- **Use**: `<Icon icon={ChevronDown} />`, with an export of `@/lib/icons` (PascalCase of the
  Fluent name: `chevron-down` -> `ChevronDown`, `text-align-left` -> `TextAlignLeft`). Import only
  what you use; the rest is tree-shaken. `size` is `size.icon.*` (`xs` 12, `sm` 14, `md` 16, `lg`
  20, `xl` 24 px; `xs` to `md` draw the 16 px artwork, `lg` the 20, `xl` the 24, the nearest drawn
  size when Fluent has no drawing). Colour is `currentColor`; `tone` picks a text role (`muted`,
  `subtle`, `accent`, `danger`, `warning`, `success`, `info`). `filled` is Fluent's solid style,
  for a selected or active state. An icon beside text is `aria-hidden`; a standalone one takes
  `label` (`role="img"`) or sits in an `IconButton` with `aria-label`.
- **Add an icon** (offline): get the upstream copy once, on a connected machine or from your
  mirror (`npm pack @fluentui/svg-icons@1.1.346`: a `.tgz`; its extracted folder or a
  `fluentui-system-icons` checkout work too), then
  `pnpm --filter @byterygon/ui icons add <name...> --from <that path>` (Fluent names, `chevron-down` or
  `chevron_down`; browse them in the upstream `icons/` folder), `pnpm --filter @byterygon/ui registry`,
  and commit `icons/`, `src/lib/icons.ts` and `registry/`. Every icon comes from one release: to
  move to a newer one, `icons refresh --from <newer copy>` re-vendors them all.
- Never edit a file in `icons/` or `src/lib/icons.ts`, and never draw an icon by hand in new code:
  `node scripts/check-licenses.mjs` and `test/icons.test.ts` fail on a changed, missing or unlisted
  file, a stale module or a missing licence.
- The components used to draw their own SVGs; TSK-53/55 swapped them for these, in the mapping
  below (kept for reference; `REPLACEMENTS` in `test/icons.test.ts` tracked it). The test fails if a
  component or an example draws an `<svg>` again (Icon, Spinner and Chart draw on purpose). Swapped: Button,
  IconButton, ToggleButton, ToggleGroup, SplitButton (TSK-53 batch 1); Input, Textarea, InputGroup,
  NumberInput, SearchInput, PasswordInput, FileInput, DatePicker, Calendar, TimePicker, Select,
  Combobox, MultiSelect, Field (batch 2); Checkbox, RadioGroup, Switch, Slider, DropdownMenu,
  ContextMenu, Menubar, Popover, HoverCard, Tooltip (batch 3); Dialog, AlertDialog, Sheet, Toast,
  CommandPalette, Alert, Badge, Tag (batch 4); Card, Table, Sidebar, Tabs, Accordion, Collapsible,
  ScrollArea, Resizable, StatusBar, Toolbar, Separator (TSK-55 batch 1); Breadcrumb, Pagination,
  Stepper, NavigationMenu, Tree (batch 2); Code, CodeBlock, JsonViewer, Chart, DescriptionList, Stat,
  TypeBadge, RelativeTime, Avatar, Progress, Skeleton, EmptyState, Kbd and the SqlEditor and CodeInput
  frames (batch 3). `REPLACEMENTS` is now empty and a test keeps apps/dbee/ui free of hand-drawn svgs.

| Was hand-drawn | Fluent icon |
| --- | --- |
| Accordion, NavigationMenu chevron (SplitButton, Select, Combobox: done) | ChevronDown |
| Breadcrumb, Collapsible, JsonViewer, Tree, submenu, Pagination next | ChevronRight |
| Pagination previous, Calendar previous month | ChevronLeft (and ChevronRight) |
| Table sort (none / ascending / descending) | ArrowSort, ArrowSortUp, ArrowSortDown |
| Alert info / success / warning / danger, Stepper error | Info, CheckmarkCircle, Warning, ErrorCircle |
| Close (Alert, Dialog, Sheet, Popover, Tabs, Tag, Toast) and clear (Combobox, SearchInput, FileInput) | Dismiss |
| Checkbox, Select, menu items, CodeBlock copied, Stepper done | Checkmark |
| Checkbox indeterminate, NumberInput decrement, Stat flat | Subtract |
| NumberInput increment, Tabs new tab | Add |
| RadioGroup and menu radio dot | Circle (filled) |
| Breadcrumb ellipsis, menus' more | MoreHorizontal |
| CodeBlock and IconButton copy | Copy |
| CommandPalette, SearchInput, InputGroup search | Search |
| DatePicker | CalendarLtr |
| PasswordInput show / hide | Eye, EyeOff |
| Popover example filters (sliders) | Options |
| Sidebar history, settings, collapse | History, Settings, PanelLeft |
| Stat trend up / down | ArrowUp, ArrowDown |
| ToggleButton wrap; ToggleGroup align | TextWrap; TextAlignLeft, TextAlignCenter, TextAlignRight |
| Run / stop / download (Toolbar, Tooltip, IconButton examples) | Play, Stop, ArrowDownload |
| Tree folder, table, database (Tree, CommandPalette, Sidebar, Avatar, EmptyState, StatusBar examples) | Folder, Table, Database |
| IconButton refresh, delete | ArrowClockwise, Delete |
| Spinner | none: it stays an animated arc |
| DBee shell (apps/dbee/ui/src/app/icons.tsx): Plus, Play, Stop, Database, Schema, Table, View, Column, Gear, Download, More, Refresh, Help | Add, Play, Stop, Database, Folder, Table, Eye, ColumnTriple, Settings, ArrowDownload, MoreHorizontal, ArrowClockwise, QuestionCircle |

DBee also gets the icons its screens will need (TSK-55): Key, Link, Filter, Document, Save, Code,
Braces, NumberSymbol, TextT, CalendarClock, Clock, LockClosed, Shield, Server, PlugConnected,
PlugDisconnected, Pin, ArrowExport, ArrowImport, ArrowUpload, Edit, ArrowUndo, ArrowRedo, Person,
SignOut, Flash, Window, PanelBottom, SplitVertical, List, BookOpen, AddCircle, TextNumberFormat,
DatabaseMultiple, TableSimple, FolderOpen, Pause, ArrowCounterclockwise, DismissCircle,
QuestionCircle, ChevronUp, MoreVertical, Star.

## Styling rules

- Roles, not primitives. Colours: `bg-surface`, `bg-inset`, `text-fg`, `text-fg-muted`,
  `border-border`, `border-border-strong`, `bg-hover`, `bg-pressed`, `bg-selected`, the status
  names (`bg-danger`, `text-danger-solid-fg`, `border-danger-border`, `text-danger-fg`). Size and
  space: `h-control-{xs,sm,md,lg}`, `px-control-x`, `p-inset-*`, `gap-inline-*`, `gap-stack-*`,
  `size-icon-*`, `h-track` (a slider track or thin bar), `max-w-panel-{xs,sm,md,lg,xl}` (240 to
  768 px: tooltips, popovers, dialogs, sheets, sidebars). Type: Fluent 2's ramp, `text-caption-2`
  to `text-display` (`text-body-1`, `text-body-1-strong`, `text-caption-1`, `text-subtitle-1`,
  `text-title-3`; the table is in `packages/design-tokens/AGENTS.md`), and `text-code`,
  `text-code-sm`. `text-body`, `text-label`, `text-caption` and `text-heading-*` are older names
  kept as aliases (some examples, the Studio and DBee still use them); new code uses the Fluent names. Radius:
  `rounded-{xs..xl}`. Elevation (Fluent depth): `shadow-layer` (cards, free-standing surfaces), `shadow-flyout` (menus,
  popovers), `shadow-dialog`; `shadow-raised`, `shadow-overlay`, `shadow-modal` are the older names.
- The accent solid is `bg-accent-solid`, `hover:bg-accent-solid-hover`,
  `active:bg-accent-solid-active`, `text-accent-solid-fg`: the fill of a button or solid badge, white
  text in both schemes. What must stand out from the surface (a checked checkbox, switch or radio, a
  slider, progress, a spinner, the selected tab's line, a drop or selection outline, a graph edge)
  uses Fluent's compound brand: `bg-accent-compound` (`-hover`, `-active`), `text-accent-compound-fg`
  on it, `border-accent-compound`; dark mode makes it a light step (TSK-90). Never bare `bg-accent`: in a project
  with stock shadcn components (and in every project that installs a theme item) `accent` is
  shadcn's hover background. The test rejects it.
- Secondary actions use the neutral solid (`bg-neutral-solid`, `text-neutral-solid-fg`);
  destructive ones `bg-danger` with `text-danger-solid-fg`, never `text-fg-on-accent`.
- No role exists for motion, opacity, z-index, ring width and offset: use the token variable
  (`duration-[var(--by-motion-duration-fast)]`, `ease-easy-ease`, `z-[var(--by-z-modal)]`,
  `outline-[length:var(--by-ring-width)]`). Breakpoints are not CSS variables; read
  `tokens.ts` if you need the number.
- Focus: `focusRing` from `@/lib/control` (Fluent's double ring; see "Fluent 2 API"). Chart's
  points and a few examples still write the older single ring (`outline-none focus-visible:outline-solid
  focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)]
  focus-visible:outline-ring`).
- When no role fits, add one to `@byterygon/design-tokens` (its AGENTS.md), never a raw value here.
- Write every class out in full in the source, never assembled from template strings: Tailwind
  finds classes by scanning the installed files as text.
- Popups (Select, Combobox, Popover, menus) render in a portal: put `useThemeScope`'s `ref` on the
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
- `theme-<preset>` is made by `@byterygon/design-tokens/registry-theme` from the preset's committed
  CSS, the same function as `by-tokens export registry` and the Theme Studio's export, so a theme
  tuned in the Studio installs exactly like a preset. It writes the `--by-*` variables (Light/Dark via `data-theme` or `.dark`,
  Comfortable/Compact via `data-density`), the shadcn aliases, the dark variant, and both Tailwind
  vocabularies into the project CSS. Stock shadcn components are themed with no change. Fonts are
  not in the item: copy `@byterygon/design-tokens/fonts/` and import `fonts.css` (Inter, where
  the system has no Segoe UI Variable, and JetBrains Mono), or the system fallbacks of `font.sans`
  and `font.mono` are used.
- Each component item carries its manifest and example in `meta`; `registry/llms.txt` lists them
  and `registry/llms-full.txt` adds every example file and the token catalogue (see "Agent interface").
- Without the shadcn CLI, the MCP server's `install_registry_item` writes the same files from this
  folder (theme items as their own CSS file to import after Tailwind); see `packages/mcp/README.md`.

## Agent interface (spec 9a, TSK-50)

Everything here can be found, checked and installed without reading the source or opening a GUI:

- **Lint** (`@byterygon/lint`, `packages/lint/README.md`): `pnpm --filter @byterygon/ui lint` (and
  `pnpm lint` from the root, which CI runs) checks every class in `className`, `cn`, `cva` and CSS:
  no raw colour, no arbitrary value other than a token variable, no raw space step. Each message
  names the role to use, read from the token catalogue (`"p-[13px]"` -> `p-inset-sm`). When a raw
  value is intended, disable that line only, naming the rule and the reason after `--`
  (`// eslint-disable-next-line byterygon/no-arbitrary-value -- a cap relative to the viewport`).
  The conventions suite stays the stricter check for components (it compiles every class).
- **llms files**: `registry/llms.txt` (each item and its manifest in brief) and
  `registry/llms-full.txt` (also every example file at installed paths and the default theme's
  token catalogue). Generated by `pnpm --filter @byterygon/ui registry` (`scripts/lib/llms.ts`) and
  drift-tested with the rest of `registry/`; never edit them.
- **MCP server** (`@byterygon/ui-mcp`, `packages/mcp/README.md`): `node packages/mcp/bin/by-ui-mcp.js`
  over stdio, no listener and no network. `search_tokens`, `explain_token`, `validate_theme` (the
  `by-tokens --json` documents), `list_components`, `get_component`, `list_registry_items`,
  `install_registry_item` (into a project folder, never outside it; `dryRun` first) and
  `check_classes` (the lint analysis). Build `@byterygon/design-tokens` once before starting it.
- **Tokens**: `by-tokens search <words>`, `explain <token>`, `validate --theme <file>`
  (`packages/design-tokens/AGENTS.md`).

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
- Never draw an icon by hand in new code or edit a vendored one: `icons add` it (see "Icons").
- Never depend on AGPL code (`apps/`); this package is MIT OR Apache-2.0 and the licence check fails.
- Never skip the manifest: the registry build stops on an invalid one.
- Never turn a lint rule off for a file or a folder, or disable one without a reason after `--`.
