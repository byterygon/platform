# @byterygon/data-grid: notes for agents

The virtualized Arrow grid of DBee (DBee spec DOC-18 §6, Decisions 16–18; task TSK-39). It reads
the `ArrowBatch` / `ArrowData` buffers that `decodeArrow` yields directly: no per-row objects, no
apache-arrow on the UI thread, no grid library, no network. MIT OR Apache-2.0: it must never
depend on `apps/` (`scripts/check-licenses.mjs` enforces it).

```
src/cells.ts         ColumnFormat per field: display text (cut, ↵) and full value from the buffers
src/batch-index.ts   BatchIndex: batches as received, prefix sums of numRows, binary search; byte counts
src/text-cache.ts    the LRU of formatted strings of cells in and near view
src/virtualizer.ts   RowAxis (fixed height, scaled past 15 M px) and ColumnAxis (prefix sums of widths)
src/widths.ts        initial widths from the type and the first 200 rows
src/renderer.ts      CellLayer: the body's rows and cells as plain divs, recycled; frame sampling
src/DataGrid.tsx     the React shell: role="grid" scroller, sticky header, sizer, the probe
src/data-grid.css    token roles only (test/conventions.test.ts)
demo/                a 1,000,000 x 10 synthetic result (`pnpm --filter @byterygon/data-grid demo`)
test/                Vitest in jsdom; fixtures written as Arrow IPC and read back through decodeArrow
```

## Rules

- Runtime imports: `react`, `@byterygon/ambidex/arrow` (types and `arrowIsValid`) and the package's
  own modules. apache-arrow is a dev dependency for the test fixtures only. The conventions test
  fails on anything else, on a network API, and on a stylesheet value that is not a token.
- No React state or element per cell. React renders the shell; `CellLayer` writes the body.
- Int64 is BigInt and stays BigInt until `toString`. Never `Number` on a 64-bit value except a time
  of day or a day count that is known to fit.
- The application loads the token CSS (`@byterygon/design-tokens/.../tokens.css`) and
  `@byterygon/data-grid/styles.css`. The grid reads `grid.row-height` and the cell font's width
  from a hidden probe and re-measures when density or font change (ResizeObserver).

## Commands

```sh
pnpm --filter @byterygon/data-grid test        # Vitest (jsdom): cells, model, grid + axe, conventions
pnpm --filter @byterygon/data-grid typecheck
pnpm --filter @byterygon/data-grid demo        # http://127.0.0.1:5179/?rows=1000000&density=compact&theme=light
```

## Choices made here (also in DOC-18 Open questions)

Where the spec was silent, TSK-39 chose:

1. **All cells are monospace** (`text-code-sm`). Widths are then a character count, and digits line
   up. The header uses `text-caption-1-strong`.
2. **Header label**: `pg.type_name` metadata when the driver sends it (Decision 20), "uuid" for the
   uuid extension, else the Arrow type as apache-arrow prints it (`Timestamp<MICROSECOND, UTC>`).
3. **Family from the OID** the driver already sends (`byterygon.pg.type_oid`): 114 / 3802 (json,
   jsonb) are `json`, 1700 (numeric) is `decimal` and right-aligned, although all three arrive as
   Utf8.
4. **Fractions of time and timestamp** drop trailing zeros (as PostgreSQL's text does); the spec
   says so for time only.
5. **±infinity** (the driver maps PostgreSQL's infinities to the type's minimum and maximum) reads
   `-infinity` / `infinity`; years before 1 read `YYYY-MM-DD BC` as in PostgreSQL. Dates use integer
   arithmetic, not `Date`, so every Int32 day has a text.
6. **Float32** prints the shortest text that reads back as the same float32 (`0.1`, not the widened
   double `0.10000000149011612`); `-0` keeps its sign.
7. **bytea**: the `… (n bytes)` suffix only when the value is longer than 32 bytes.
8. **The 1,000-character cut** counts UTF-16 units and never splits a surrogate pair; at most
   4,004 bytes of a long value are decoded to display it.
9. **Height cap**: past 15,000,000 px of rows (about 470,000 rows at 32 px) the scroll range is
   scaled; rows are placed relative to the viewport. 1,000,000 rows at 32 px would otherwise exceed
   Chromium's cap (about 33.5 M px) and Firefox's (about 17.9 M).
10. **Row height** comes from `grid.row-height`: 22 px compact and, since TSK-53, 32 px comfortable
    (the spec says 36; the token changed with Fluent 2's `size.control.md`).
11. **`role="grid"` is on the scroller**, so the grid is the one tab stop and owns its rows.
12. **LRU**: 4 × 64 × columns entries (at least 1,024).

## Status

Batch 1 (this package, static `fields` + `batches`). Batch 2 adds the `stream` input with the memory
budget and credits, selection, keyboard, copy and the live region; batch 3 wires it into DBee and
measures frame time.
