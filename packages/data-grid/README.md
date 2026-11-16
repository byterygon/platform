# @byterygon/data-grid

A virtualized data grid for Arrow results, as decoded by `@byterygon/ambidex/arrow`. It reads the
record batches' buffers directly (Int64 as BigInt, text decoded per visible cell, NULL from the
validity bitmap), renders only the rows and columns in view, and is styled with
`@byterygon/design-tokens` roles. Built for DBee; MIT OR Apache-2.0.

```tsx
import "@byterygon/design-tokens/default/tokens.css";
import "@byterygon/data-grid/styles.css";
import { DataGrid } from "@byterygon/data-grid";

<DataGrid fields={fields} batches={batches} aria-label="Result" onFrameSample={(s) => log(s.duration)} />;
```

| Prop | |
| --- | --- |
| `fields` | the schema (`ArrowField[]`) |
| `batches` | the record batches (`ArrowBatch[]`), kept as given |
| `aria-label` / `aria-labelledby` | the grid's name |
| `rowHeight` | px; default `grid.row-height` of the current density |
| `columnWidths` | px; default from the types and the first 200 rows |
| `onFrameSample` | frame duration while scrolling; also `performance.measure("dbee.grid.frame")` |

Streaming input, selection, keyboard and copy arrive in the next TSK-39 batch. See
[AGENTS.md](AGENTS.md) for the design and the rules the tests enforce.
