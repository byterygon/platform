// Copy from the buffers (DBee spec §3.7, §6; Decision 15: copy is client-side): the selected cells
// as TSV, CSV or JSON, with or without the header. Values are the full values (`ColumnFormat.value`),
// not the cut display text.
//
// - TSV and CSV quote a value that holds the delimiter, a quote or a line break ("…", quotes doubled),
//   as spreadsheets read it. NULL is written as the text NULL, as the grid shows it.
// - JSON with headers is an array of objects keyed by column name; without, an array of arrays.
//   NULL is null; booleans and 8–32-bit integers and finite floats are JSON numbers and booleans;
//   Int64, Uint64 and everything else are strings (no 2^53 loss).
import type { ArrowField } from "@byterygon/ambidex/arrow";
import type { BatchIndex } from "./batch-index.ts";
import type { ColumnFormat } from "./cells.ts";
import type { CellRange } from "./selection.ts";

export type CopyFormat = "tsv" | "csv" | "json";

const SAFE_INTEGER_TYPES = new Set(["Int8", "Int16", "Int32", "Uint8", "Uint16", "Uint32"]);

function jsonValue(field: ArrowField, format: ColumnFormat, text: string | null): unknown {
  if (text === null) return null;
  if (format.family === "boolean" && field.type === "Bool") return text === "true";
  if (SAFE_INTEGER_TYPES.has(field.type)) return Number(text);
  if (field.type === "Float32" || field.type === "Float64") {
    const n = Number(text);
    return Number.isFinite(n) && !Object.is(n, -0) ? n : text;
  }
  return text;
}

function quoter(delimiter: string): (text: string) => string {
  return (text) => (text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
}

/** The text of the cells in `range`, in the format asked for. */
export function serializeRange(
  index: BatchIndex,
  fields: readonly ArrowField[],
  formats: readonly ColumnFormat[],
  range: CellRange,
  format: CopyFormat,
  headers: boolean,
): string {
  const columns: number[] = [];
  for (let c = range.columnStart; c <= range.columnEnd && c < fields.length; c++) columns.push(c);
  const rowEnd = Math.min(range.rowEnd, index.rowCount - 1);
  const value = (row: number, column: number): string | null => {
    const b = index.locate(row);
    const data = index.batch(b).columns[column];
    return data === undefined ? null : formats[column]!.value(data, row - index.start(b));
  };

  if (format === "json") {
    const out: unknown[] = [];
    for (let r = range.rowStart; r <= rowEnd; r++) {
      if (headers) {
        const o: Record<string, unknown> = {};
        for (const c of columns) o[fields[c]!.name] = jsonValue(fields[c]!, formats[c]!, value(r, c));
        out.push(o);
      } else out.push(columns.map((c) => jsonValue(fields[c]!, formats[c]!, value(r, c))));
    }
    return JSON.stringify(out, null, 2);
  }

  const delimiter = format === "tsv" ? "\t" : ",";
  const quote = quoter(delimiter);
  const lines: string[] = [];
  if (headers) lines.push(columns.map((c) => quote(fields[c]!.name)).join(delimiter));
  for (let r = range.rowStart; r <= rowEnd; r++) {
    lines.push(
      columns
        .map((c) => {
          const text = value(r, c);
          return text === null ? "NULL" : quote(text);
        })
        .join(delimiter),
    );
  }
  return lines.join("\n");
}
