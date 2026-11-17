// @byterygon/data-grid: the virtualized Arrow data grid (DBee spec §6). See AGENTS.md.
export { DataGrid, type DataGridHandle, type DataGridProps, type SelectionInfo } from "./DataGrid.tsx";
export { type CopyFormat, serializeRange } from "./copy.ts";
export { DEFAULT_MEMORY_BUDGET, NEAR_END_SCREENS, type ResultProgress, ResultSource, type ResultState, retain, sourceFor } from "./result-source.ts";
export {
  type CellPos,
  type CellRange,
  cellCount,
  contains,
  moveSelection,
  moveTarget,
  rangeOf,
  type Selection,
  type SelectionKind,
  selectAll,
  selectColumns,
  selectRows,
  single,
} from "./selection.ts";
export { BatchIndex, batchByteLength, dataByteLength } from "./batch-index.ts";
export {
  BINARY_PREVIEW,
  type CellAlign,
  type ColumnFormat,
  civilFromDays,
  columnFormat,
  DISPLAY_LIMIT,
  displayText,
  formatFloat32,
  formatFloat64,
  PG_TYPE_NAME,
  PG_TYPE_OID,
  TYPE_GLYPHS,
  type TypeFamily,
} from "./cells.ts";
export { type CellDecorator, CellLayer, FRAME_MEASURE, type FrameSample } from "./renderer.ts";
export { type CellText, TextCache } from "./text-cache.ts";
export { ColumnAxis, MAX_SCROLL_HEIGHT, RowAxis, type Span } from "./virtualizer.ts";
export { clampWidth, initialWidths, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, WIDTH_SAMPLE_ROWS, type WidthMetrics } from "./widths.ts";
