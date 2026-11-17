# @byterygon/data-grid

A virtualized data grid for Arrow results, as decoded by `@byterygon/ambidex/arrow`. It reads the
record batches' buffers directly (Int64 as BigInt, text decoded per visible cell, NULL from the
validity bitmap), renders only the rows and columns in view, and is styled with
`@byterygon/design-tokens` roles. Built for DBee; MIT OR Apache-2.0.

```tsx
import "@byterygon/design-tokens/default/tokens.css";
import "@byterygon/data-grid/styles.css";
import { DataGrid, type DataGridHandle } from "@byterygon/data-grid";

const grid = useRef<DataGridHandle>(null);
<DataGrid ref={grid} stream={decodeArrow(client.query.execute({ sql }), worker)} aria-label="Result" onProgress={setStatus} />;
```

| Prop | |
| --- | --- |
| `stream` | an `ArrowStream` from `decodeArrow`; its `batches()` is iterated once, by the grid |
| `fields` + `batches` | or a complete result |
| `memoryBudget` | buffer bytes held before pulling only near the loaded end (default 256 MiB) |
| `follow` | keep the newest rows in view while streaming, when at the bottom |
| `aria-label` / `aria-labelledby` | the grid's name |
| `rowHeight` | px; default `grid.row-height` of the current density |
| `columnWidths`, `onColumnWidthsChange` | widths to restore (an `undefined` entry takes the default) and the widths after a resize |
| `onProgress` | rows, bytes and state: `schema`, `streaming`, `paused`, `done`, `cancelled`, `error` |
| `onSelectionChange` | active cell, range, cell count and the active cell's full value |
| `onOpenCell` | Enter, F2 or double click on a cell |
| `onCopyWithHeaders` | Ctrl+Shift+C: show a TSV/CSV/JSON menu, then call `grid.current.copy(format, true)` |
| `onFrameSample` | frame duration while scrolling; also `performance.measure("dbee.grid.frame")` |

See [AGENTS.md](AGENTS.md) for the design and the rules the tests enforce.
