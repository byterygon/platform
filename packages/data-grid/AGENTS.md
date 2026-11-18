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
scripts/frame-check.ts  the demo in Chromium over CDP: frame intervals while streaming, heap, network
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

**A live view's window** (Mightyconsole spec §5.5, TSK-80): `maxRows` and `maxBytes` keep the newest
rows and drop the oldest batches whole (`BatchIndex.dropFirst`; the newest batch always stays), and
`ResultProgress.dropped` counts them; `hold` stops pulling (Pause: the stream's credits run out and
the server waits); `handle.clear()` drops every loaded row and keeps the stream (Clear). Rows are
renumbered from 1 after a drop; the rows in view stay in view (or the newest, when following at the
bottom), and the selection moves with its rows or goes when they leave.

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
pnpm --filter @byterygon/data-grid lint        # @byterygon/lint (ESLint + Stylelint token rules)
pnpm --filter @byterygon/data-grid check:browser   # Chromium over CDP; skips without a browser unless BYTERYGON_REQUIRE_BROWSER=1
pnpm --filter @byterygon/data-grid demo        # http://127.0.0.1:5179/?rows=1000000&pace=25&budget=256&density=compact&theme=light
```

## Choices made here (DOC-18 Open question 13, decided by Uy Son on 2026-11-17)

Where the spec was silent, TSK-39 chose:

1. **All cells are monospace** (`text-code-sm`). Widths are then a character count, and digits line
   up. The header uses `text-caption-1-strong`.
2. **Header label** (TSK-64: the names users know): `pg.type_name` metadata when the driver sends it
   (Decision 20), else the PostgreSQL name of a built-in type OID from `byterygon.pg.type_oid`
   (`bigint`, `timestamptz`, `jsonb`; `PG_TYPE_NAMES` in `src/cells.ts`), else a name derived from the
   Arrow type (`integer`, `text`, `timestamptz`); a type the grid does not know keeps its Arrow name
   (`List<Int32>`). The Arrow type (`ColumnFormat.arrowType`) is in the header's tooltip. Extension
   types such as PostGIS geometry have per-database OIDs and fall back to the Arrow-derived name.
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

## Frame time (Decision 17)

`check:browser` scrolls 200 px per frame for 3 s while 1,000,000 x 10 rows stream from a Worker
(a batch of 4,096 rows every 25 ms), then on the loaded result. It reports the frame interval
(p50/p95/p99/max, frames over 1.5 refresh intervals), the grid's own work per frame, and the JS heap
after loading. The gate is reported literally (p95 < 16 ms, which a 60 Hz display can never meet)
and as proposed in DOC-18 Open question 14 (p95 within 1.1 x the refresh interval); `--enforce`
fails on the proposed one. WebKitGTK is not measured by this script (Chromium only).

Measured on 2026-11-17, Apple Silicon (macOS), Chrome for Testing 1228 headless, 60 Hz:

| Scenario | p50 | p95 | p99 | max | long frames | work p95 |
| --- | --- | --- | --- | --- | --- | --- |
| streaming (131k to 508k rows during the scroll) | 16.7 ms | 16.8 ms | 16.8 ms | 16.8 ms | 0 | 0.7 ms |
| static (1M rows loaded) | 16.7 ms | 16.7 ms | 16.8 ms | 16.8 ms | 0 | 0.7 ms |

JS heap after loading 1M rows: 4.2 MiB, with 97.4 MiB of Arrow buffers held outside it (no per-row
objects).

## Status

Batches 1 to 3 of TSK-39: the package, streaming and interaction, and DBee's results panel on it.
