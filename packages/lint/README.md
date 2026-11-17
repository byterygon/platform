# @byterygon/lint

The design-token guardrails of Byterygon UI (spec "Byterygon UI: design tokens, Theme Studio and
component set", section 9a.4) as lint rules: no raw colours, no arbitrary Tailwind values and no
off-scale spacing outside `@byterygon/design-tokens`. Every message names the role or token to use,
read from the token engine's catalogue (the theme's own values), never from a list in this package.
Nothing touches the network.

```text
"p-[13px]" is an arbitrary value (13px). Use a space role: p-inset-sm (space.inset.sm, 12px comfortable / 8px compact).
"bg-blue-500" is a raw colour (Tailwind's blue-500). Use a background role: bg-info (color.status.info.solid, #1570d1 in light), or bg-accent-solid (color.accent.bg, #6b4eff in light) are the nearest; `by-tokens search background` lists the others.
"h-8" is 32px, which the size role size.control.md names (it follows the density). Use h-control-md (size.control.md, 32px comfortable / 28px compact).
padding: 13px is off the space scale. Use a space role: var(--by-space-inset-sm) (space.inset.sm, 12px comfortable / 8px compact).
```

## Rules

| Rule | ESLint (TS, TSX, JS) | Stylelint (CSS) |
| --- | --- | --- |
| `byterygon/no-raw-color` | Tailwind palette classes (`bg-blue-500`, `text-white`), colours in arbitrary values (`bg-[#fff]`, `[color:rgb(...)]`), colour primitives (`bg-[var(--by-color-blue-9)]`), raw colours in `style={{ ... }}` | hex, `rgb()`, `hsl()`, `oklch()`, `lab()`, `color()` in any value; named colours in colour properties; `@apply` classes |
| `byterygon/no-arbitrary-value` | `prefix-[value]`, `prefix-(--var)`, `[property:value]` and arbitrary modifiers, unless the value is token variables (`var(--by-...)`, alone or in `calc()` with unitless numbers); unknown `--by-` variables get the closest names | `@apply` classes |
| `byterygon/no-off-scale-spacing` | numeric steps of padding, margin, gap, space-between and inset utilities (`p-2`, `gap-3`, `-mt-1.5`: use the role); numeric sizes (`w-`, `h-`, `size-`, `min-`/`max-`, `basis-`) when a size role has that value (`h-8` is `h-control-md`) or when the step is not on the space scale (`w-36`); raw space steps through variables (`p-[var(--by-space-2)]`) | px, rem and em lengths over 1px in padding, margin, gap, inset and scroll-margin/padding properties; `@apply` classes |
| `byterygon/require-disable-reason` | a directive that turns off a byterygon rule names it and gives a reason after `--`; a directive that names no rule is reported | — |

Allowed everywhere: role utilities (`bg-surface`, `text-fg-muted`, `p-inset-sm`, `gap-gap-md`,
`h-control-md`, `rounded-md`, `text-body-1`, `shadow-layer`), opacity steps on roles
(`bg-surface/50`), variants (`data-[state=open]:`), keywords and fractions (`w-full`, `w-1/3`,
`inset-0`, `p-px`), steps on the space scale for sizes that no role names (`w-24`), 0 and 1px in
CSS, `currentColor`, `transparent` and the forced-colours system colours.

Classes are read from `className`/`class` attributes, from the arguments of `cn`, `cva`, `clsx`,
`cx`, `twMerge`, `twJoin` and `tv` (strings, template literals, arrays, conditionals, object keys
and values, nested calls) and from variables named `*Class`, `*Classes` or `*ClassName`.

Suggestions: the nearest role of the right family by value. Colours compare in OKLab against the
light-mode value of the `color.*` roles that paint what the utility paints (backgrounds for `bg-`,
text for `text-`, edges for `border-`/`ring-`). Lengths compare against the comfortable value of
the space roles of the utility's family (padding: `space.inset`, horizontal margin:
`space.inline`, gap: `space.gap`, sizes: `size.control`, `size.icon`, `size.panel`), with an exact
match from another family added when there is one. Text sizes, radii, durations and z-indices
suggest the nearest `text.*`, `radius.*`, `motion.duration.*` and `z.*` token. ESLint offers the
swap as an editor suggestion (never an automatic fix: the right family is a judgement).

## Use

In this repository `packages/ui`, `packages/theme-studio` and `apps/dbee/ui` run it with
`pnpm lint` (each package: `eslint . && stylelint "**/*.css"`; CI runs it after `pnpm build`,
because the rules load the token engine from `@byterygon/design-tokens/dist`).

In a project (for example one that installed the registry), add `@byterygon/lint`, `eslint` 10 and
`stylelint` 17, then:

```js
// eslint.config.js
import byterygon from "@byterygon/lint/eslint";
export default [{ ignores: ["dist/**"] }, ...byterygon.configs.recommended];

// stylelint.config.js
export default { extends: ["@byterygon/lint/stylelint-config"], ignoreFiles: ["dist/**"] };
```

`recommended` parses TS and TSX with `@typescript-eslint/parser` (and TypeScript 6.0, which it
needs; the repository's own TypeScript 7 has no JS API). Settings:

```js
{ settings: { byterygon: { theme: "./brand.theme.json", callees: ["cn", "cva"], attributes: ["className"] } } }
```

`theme` is a preset name or a theme file (default `default`): suggestions then come from that
theme's values. In Stylelint, pass it as a secondary option: `"byterygon/no-raw-color": [true, { theme: "./brand.theme.json" }]`.
The palette for `bg-blue-500` is read from the project's `tailwindcss/theme.css`; without Tailwind
installed the class is still reported, without a nearest role.

## When a raw value is intended

Disable one line, name the rule and say why after `--`:

```tsx
{/* eslint-disable-next-line byterygon/no-arbitrary-value -- a cap relative to the viewport; no token is a viewport fraction */}
<ScrollArea className="max-h-[50dvh]">
```

```css
/* stylelint-disable-next-line byterygon/no-raw-color -- the printed page is always white */
```

Never turn a rule off for a file or a folder. Drawn pieces that must hold a literal (an SVG chart,
Monaco's theme, a `data-foreign-dom` subtree) take a line disable with the reason, like any other.

## Commands

```sh
pnpm --filter @byterygon/lint test        # node --test: fixtures (test/fixtures/{good,bad}.{tsx,css}) and the analysis
pnpm --filter @byterygon/lint typecheck   # JSDoc types, checked by TypeScript
pnpm lint                                  # from the repo root: every package that has a lint script
```

The package is plain ES modules with JSDoc types: no build step, so ESLint and Stylelint load it as
it is. `src/catalog.js` reads the engine, `src/classes.js` analyses one class, `src/colors.js`
parses CSS colours, `src/eslint.js` and `src/stylelint.js` are the plugins.
