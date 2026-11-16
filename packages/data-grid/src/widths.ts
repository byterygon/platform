// Initial column widths (DBee spec §6, "Interaction"): from the column's type and the display
// text of the first 200 rows, measured in characters of the grid's monospace cell font.
import type { ArrowField } from "@byterygon/ambidex/arrow";
import type { BatchIndex } from "./batch-index.ts";
import { type ColumnFormat, TYPE_GLYPHS, type TypeFamily } from "./cells.ts";

/** Rows sampled for the initial widths. */
export const WIDTH_SAMPLE_ROWS = 200;

/** Widest initial column, in characters (a user can widen it further). */
const MAX_CHARS = 48;
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 4000;

/** The narrowest a column of the family starts, in characters (so "NULL" and short values fit). */
const MIN_CHARS: Readonly<Record<TypeFamily, number>> = {
  integer: 6,
  decimal: 8,
  text: 8,
  boolean: 5,
  datetime: 10,
  json: 12,
  binary: 12,
  uuid: 36,
};

export interface WidthMetrics {
  /** Width of one character of the cell font, in px. */
  readonly charWidth: number;
  /** Horizontal padding of a cell, both sides together, in px. */
  readonly padding: number;
}

/** Characters the header needs: glyph, name and a short type name (the rest truncates). */
function headerChars(field: ArrowField, format: ColumnFormat): number {
  return TYPE_GLYPHS[format.family].length + 1 + field.name.length + 1 + Math.min(format.label.length, 10);
}

export function clampWidth(px: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(px)));
}

/** The initial width of every column, in px. */
export function initialWidths(fields: readonly ArrowField[], formats: readonly ColumnFormat[], index: BatchIndex, metrics: WidthMetrics): number[] {
  const rows = Math.min(index.rowCount, WIDTH_SAMPLE_ROWS);
  return fields.map((field, c) => {
    const format = formats[c]!;
    let chars = Math.max(MIN_CHARS[format.family], headerChars(field, format));
    for (let r = 0; r < rows && chars < MAX_CHARS; r++) {
      const b = index.locate(r);
      const data = index.batch(b).columns[c];
      if (data === undefined) continue;
      const text = format.display(data, r - index.start(b));
      chars = Math.max(chars, text === null ? 4 : text.length);
    }
    // Rounded up, plus the 1 px cell rule: a value exactly as wide as the column must not truncate.
    return clampWidth(Math.ceil(Math.min(chars, MAX_CHARS) * metrics.charWidth + metrics.padding) + 1);
  });
}
