// Selection and keyboard movement (DBee spec §6 "Interaction", §9 "Grid navigation"): a cell, a
// range of cells (Shift+arrows, Shift+click), whole rows (row number), whole columns (header) and
// everything (Ctrl+A). Whole columns and "all" extend to rows that arrive later in the stream.

export interface CellPos {
  readonly row: number;
  readonly column: number;
}

export type SelectionKind = "cells" | "rows" | "columns" | "all";

/** The active cell (focus), the anchor of a range, and what the range spans. */
export interface Selection {
  readonly kind: SelectionKind;
  readonly anchor: CellPos;
  readonly active: CellPos;
}

/** An inclusive rectangle of rows and columns. */
export interface CellRange {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly columnStart: number;
  readonly columnEnd: number;
}

export function single(pos: CellPos): Selection {
  return { kind: "cells", anchor: pos, active: pos };
}

/** The rectangle a selection covers for the rows and columns currently held. */
export function rangeOf(selection: Selection, rowCount: number, columnCount: number): CellRange {
  const { anchor, active, kind } = selection;
  const lastRow = Math.max(0, rowCount - 1);
  const lastColumn = Math.max(0, columnCount - 1);
  const rows = kind === "columns" || kind === "all" ? [0, lastRow] : [Math.min(anchor.row, active.row), Math.max(anchor.row, active.row)];
  const columns = kind === "rows" || kind === "all" ? [0, lastColumn] : [Math.min(anchor.column, active.column), Math.max(anchor.column, active.column)];
  return { rowStart: rows[0]!, rowEnd: rows[1]!, columnStart: columns[0]!, columnEnd: columns[1]! };
}

export function contains(range: CellRange, row: number, column: number): boolean {
  return row >= range.rowStart && row <= range.rowEnd && column >= range.columnStart && column <= range.columnEnd;
}

export function cellCount(range: CellRange): number {
  return (range.rowEnd - range.rowStart + 1) * (range.columnEnd - range.columnStart + 1);
}

export interface MoveContext {
  readonly rowCount: number;
  readonly columnCount: number;
  /** Rows a Page Up / Page Down moves. */
  readonly pageRows: number;
}

/** Keys the grid handles for movement. */
const MOVES = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

export function isMoveKey(key: string): boolean {
  return MOVES.has(key);
}

/** Where `key` moves the active cell (`ctrl` is Ctrl or Cmd). */
export function moveTarget(pos: CellPos, key: string, ctrl: boolean, ctx: MoveContext): CellPos {
  const lastRow = Math.max(0, ctx.rowCount - 1);
  const lastColumn = Math.max(0, ctx.columnCount - 1);
  const clampRow = (r: number) => Math.min(lastRow, Math.max(0, r));
  const clampColumn = (c: number) => Math.min(lastColumn, Math.max(0, c));
  switch (key) {
    case "ArrowUp":
      return { row: ctrl ? 0 : clampRow(pos.row - 1), column: pos.column };
    case "ArrowDown":
      return { row: ctrl ? lastRow : clampRow(pos.row + 1), column: pos.column };
    case "ArrowLeft":
      return { row: pos.row, column: ctrl ? 0 : clampColumn(pos.column - 1) };
    case "ArrowRight":
      return { row: pos.row, column: ctrl ? lastColumn : clampColumn(pos.column + 1) };
    case "PageUp":
      return { row: clampRow(pos.row - Math.max(1, ctx.pageRows)), column: pos.column };
    case "PageDown":
      return { row: clampRow(pos.row + Math.max(1, ctx.pageRows)), column: pos.column };
    case "Home":
      return ctrl ? { row: 0, column: 0 } : { row: pos.row, column: 0 };
    case "End":
      return ctrl ? { row: lastRow, column: lastColumn } : { row: pos.row, column: lastColumn };
    default:
      return pos;
  }
}

/** The selection after moving to `target`: Shift extends from the anchor, otherwise one cell. */
export function moveSelection(selection: Selection, target: CellPos, extend: boolean): Selection {
  if (!extend) return single(target);
  // Extending a row or column selection keeps its kind; "all" becomes a cell range.
  const kind = selection.kind === "all" ? "cells" : selection.kind;
  return { kind, anchor: selection.anchor, active: target };
}

/** A whole-row selection from the anchor row (Shift) or of one row; the active cell keeps its column. */
export function selectRows(selection: Selection | undefined, row: number, extend: boolean): Selection {
  const column = selection?.active.column ?? 0;
  if (extend && selection !== undefined) return { kind: "rows", anchor: { row: selection.anchor.row, column: 0 }, active: { row, column } };
  return { kind: "rows", anchor: { row, column: 0 }, active: { row, column } };
}

/** A whole-column selection, as `selectRows` for columns. */
export function selectColumns(selection: Selection | undefined, column: number, extend: boolean): Selection {
  const row = selection?.active.row ?? 0;
  if (extend && selection !== undefined) return { kind: "columns", anchor: { row: 0, column: selection.anchor.column }, active: { row, column } };
  return { kind: "columns", anchor: { row: 0, column }, active: { row, column } };
}

export function selectAll(selection: Selection | undefined): Selection {
  const active = selection?.active ?? { row: 0, column: 0 };
  return { kind: "all", anchor: { row: 0, column: 0 }, active };
}
