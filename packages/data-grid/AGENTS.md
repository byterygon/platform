# @byterygon/data-grid: notes for agents

The virtualized Arrow grid of DBee (DBee spec DOC-18 §6, Decisions 16–18; task TSK-39). It reads
the `ArrowBatch` / `ArrowData` buffers that `decodeArrow` yields directly: no per-row objects, no
apache-arrow on the UI thread, no grid library, no network. MIT OR Apache-2.0: it must never
depend on `apps/` (`scripts/check-licenses.mjs` enforces it).

```
src/cells.ts         ColumnFormat per field: display text (cut, ↵) and full value from the buffers
src/batch-index.ts   BatchIndex: batches as received, prefix sums of numRows, binary search; byte counts
src/text-cache.ts    the LRU of formatted strings of cells in and near view
src/result-source.ts ResultSource: a stream pulled once under the memory budget, or fixed batches
src/selection.ts     cell / range / rows / columns / all, keyboard movement (pure functions)
src/copy.ts          TSV, CSV and JSON of a range, from the full values
src/virtualizer.ts   RowAxis (fixed height, scaled past 15 M px) and ColumnAxis (prefix sums of widths)
src/widths.ts        initial widths from the type and the first 200 rows
src/renderer.ts      CellLayer: the body's rows and cells as plain divs, recycled; frame sampling
src/DataGrid.tsx     the React shell: role="grid" scroller, header, sizer, probe, keyboard, pointer, live region
src/data-grid.css    token roles only (test/conventions.test.ts)
demo/                a 1,000,000 x 10 synthetic stream built in a Worker (`pnpm --filter @byterygon/data-grid demo`)
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

## Streaming and backpressure

`DataGrid stream={decodeArrow(...)}` hands the stream to a `ResultSource` (one per stream, kept in a
WeakMap so a StrictMode remount does not iterate twice). The source:

- iterates `batches()` exactly once; each `next()` is what lets decodeArrow take the next chunk and
  grant its credit, so the pull rate is the backpressure;
- pulls continuously while the held buffer bytes are under `memoryBudget` (256 MiB by default);
- at the budget, pulls only while the last row in view is within two screens of the last loaded row
  (the cell layer reports it after every frame), one batch at a time;
- on `cancel()` (handle) or unmount (after a task with no subscriber) cancels the stream and keeps
  the loaded rows.

The viewport never moves when rows arrive (with a scaled scroll range the scroll position is
corrected to keep the same top row); `follow` keeps the newest rows in view when the user is at
the bottom. `aria-rowcount` is -1 until the stream is no longer live.

## Interaction and accessibility

- Keyboard: arrows, Page Up/Down, Home/End, Ctrl+Home/End; Shift extends; Ctrl+A; Ctrl+C copies TSV;
  Ctrl+Shift+C calls `onCopyWithHeaders` (the application's TSV/CSV/JSON menu, then
  `handle.copy(format, true)`), else copies TSV with headers; Enter/F2 and double click call
  `onOpenCell`; Escape collapses a range; Alt+Shift+Left/Right resizes the active column by two
  characters. Cmd works as Ctrl.
- Pointer: click a cell, Shift+click a range, the row number for rows, the header for columns; drag a
  header's end edge to resize. Resizes report `onColumnWidthsChange` (persist per tab).
- One tab stop: the active cell has tabindex 0 when rendered, the grid element otherwise; focus
  follows the active cell through recycling. Cells carry `aria-selected`, rows `aria-rowindex`,
  cells `aria-colindex`; headers have the type in `aria-description`. A polite live region says when
  the stream ends, pauses or is cancelled, and what a copy took.
- `DataGridHandle` (`ref`): `copy`, `selectionText`, `cellValue`, `scrollToCell`, `scroller`,
  `progress`, `cancel`, `focus`.

## Commands

```sh
pnpm --filter @byterygon/data-grid test        # Vitest (jsdom): cells, model, grid + axe, conventions
pnpm --filter @byterygon/data-grid typecheck
pnpm --filter @byterygon/data-grid demo        # http://127.0.0.1:5179/?rows=1000000&density=compact&theme=light
```

## Choices made here (DOC-18 Open question 13, decided by Uy Son on 2026-11-17)

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

Batch 2 added (DOC-18 Open question 14):

13. **Copy**: NULL is the text `NULL` in TSV and CSV (as shown) and `null` in JSON; TSV and CSV quote a
    value holding the delimiter, a quote or a line break; JSON keeps Int64 as a string and gives
    8–32-bit integers, finite floats and booleans as JSON values; without headers JSON is an array of
    arrays. No size limit on a copy (Ctrl+A on 1M rows builds the whole text).
14. **A single selected cell is not shaded**, only ringed (the active cell); ranges are shaded.
15. **Page Up/Down** move by the rows in view minus one.

## Status

Batches 1 and 2 (this package). Batch 3 wires it into DBee and measures frame time.
