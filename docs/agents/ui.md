# UI: Base UI, the data grid and the editors

Moved from the repository's CLAUDE.md (TSK-126), unchanged. CLAUDE.md points here.

**Base UI only (Uy Son, 2026-11-14).** Every Byterygon UI component, example, fixture and app
(`packages/ui`, `packages/theme-studio`, DBee screens) is built on Base UI (`@base-ui/react`).
Never Radix (`radix-ui`, `@radix-ui/*`) or another primitive library. When a stock shadcn/ui item
is needed as a reference or a test fixture, take it from a Base UI style
(`https://ui.shadcn.com/r/styles/base-nova/<name>.json`), never `new-york` (Radix). Two libraries
fill the gaps, also Uy Son's decision: dates and times (Calendar, DatePicker, TimePicker) use
`react-day-picker` with `date-fns`, as shadcn's Calendar does, styled with token roles; form state,
fields and validation (Field/Form and the inputs wired to it) use TanStack Form
(`@tanstack/react-form`), with Base UI's Field parts for labels, descriptions and errors. Anything
else Base UI lacks is built on `useRender` and its parts; record the choice in the spec's Open
questions.

Data grid (TSK-39): `pnpm --filter @byterygon/data-grid test` (jsdom: buffers decoded by the real
`decodeArrow`, streaming with credits, keyboard, axe, conventions) and `check:browser` (Chromium over CDP:
1M x 10 rows streamed from a Worker while scrolling, frame intervals and work, JS heap without per-row
objects; CI runs it in the network namespace as a smoke test, the Decision 17 gate is reported, not
enforced). `pnpm --filter @byterygon/data-grid demo` serves the demo.

Editors (TSK-46): SqlEditor is Monaco through `packages/ui/src/lib/monaco.ts` (lazy ESM, the
worker via Vite `?worker`, never a CDN or the AMD loader; theme built from the tokens at the
editor; CodeEditor (TSK-80) the same for JSON with a JSON Schema, YAML and Protobuf, the JSON
worker loaded with the language); CodeInput is CodeMirror 6 themed by the token CSS variables (its DOM sits in a
`data-foreign-dom` element the conventions suite skips). jsdom tests use `test/fakes/monaco.ts`; `pnpm --filter @byterygon/ui check:browser` runs
the real editor in Chromium over CDP and reports bundle size and time to first keystroke (CI: the
runner's Chrome, network namespace, `BYTERYGON_REQUIRE_BROWSER=1`; locally it skips without a
browser, `BYTERYGON_BROWSER` names one).
