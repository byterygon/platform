// Selection kinds, keyboard movement and copy serialization.
import { describe, expect, test } from "vitest";
import {
  BatchIndex,
  columnFormat,
  moveSelection,
  moveTarget,
  rangeOf,
  selectAll,
  selectColumns,
  selectRows,
  serializeRange,
  single,
} from "../src/index.ts";
import { decoded, table } from "./support.ts";

const ctx = { rowCount: 100, columnCount: 5, pageRows: 10 };

describe("movement", () => {
  test("arrows, pages, Home/End and their Ctrl forms clamp to the result", () => {
    const at = { row: 5, column: 2 };
    expect(moveTarget(at, "ArrowUp", false, ctx)).toEqual({ row: 4, column: 2 });
    expect(moveTarget(at, "ArrowDown", true, ctx)).toEqual({ row: 99, column: 2 });
    expect(moveTarget(at, "ArrowLeft", false, ctx)).toEqual({ row: 5, column: 1 });
    expect(moveTarget(at, "ArrowRight", true, ctx)).toEqual({ row: 5, column: 4 });
    expect(moveTarget(at, "PageUp", false, ctx)).toEqual({ row: 0, column: 2 });
    expect(moveTarget(at, "PageDown", false, ctx)).toEqual({ row: 15, column: 2 });
    expect(moveTarget(at, "Home", false, ctx)).toEqual({ row: 5, column: 0 });
    expect(moveTarget(at, "End", false, ctx)).toEqual({ row: 5, column: 4 });
    expect(moveTarget(at, "Home", true, ctx)).toEqual({ row: 0, column: 0 });
    expect(moveTarget(at, "End", true, ctx)).toEqual({ row: 99, column: 4 });
    expect(moveTarget({ row: 0, column: 0 }, "ArrowUp", false, ctx)).toEqual({ row: 0, column: 0 });
  });

  test("Shift extends from the anchor; without Shift one cell", () => {
    let s = single({ row: 2, column: 1 });
    s = moveSelection(s, { row: 4, column: 3 }, true);
    expect(rangeOf(s, 100, 5)).toEqual({ rowStart: 2, rowEnd: 4, columnStart: 1, columnEnd: 3 });
    s = moveSelection(s, { row: 0, column: 0 }, true);
    expect(rangeOf(s, 100, 5)).toEqual({ rowStart: 0, rowEnd: 2, columnStart: 0, columnEnd: 1 });
    s = moveSelection(s, { row: 7, column: 4 }, false);
    expect(rangeOf(s, 100, 5)).toEqual({ rowStart: 7, rowEnd: 7, columnStart: 4, columnEnd: 4 });
  });

  test("rows, columns and all; columns and all grow with the rows", () => {
    const rows = selectRows(selectRows(undefined, 3, false), 6, true);
    expect(rangeOf(rows, 100, 5)).toEqual({ rowStart: 3, rowEnd: 6, columnStart: 0, columnEnd: 4 });
    const columns = selectColumns(selectColumns(undefined, 1, false), 3, true);
    expect(rangeOf(columns, 100, 5)).toEqual({ rowStart: 0, rowEnd: 99, columnStart: 1, columnEnd: 3 });
    expect(rangeOf(columns, 500, 5).rowEnd).toBe(499);
    expect(rangeOf(selectAll(undefined), 10, 5)).toEqual({ rowStart: 0, rowEnd: 9, columnStart: 0, columnEnd: 4 });
  });
});

describe("copy", async () => {
  const { fields, batches } = await decoded(
    table({
      n: { kind: "int32", values: [1, null, 3] },
      big: { kind: "int64", values: [9007199254740993n, 2n, null] },
      t: { kind: "utf8", values: ["plain", 'a,"quoted"\ttab', ""] },
      f: { kind: "float64", values: [0.5, Number.NaN, -0] },
      b: { kind: "bool", values: [true, false, null] },
    }),
  );
  const index = new BatchIndex();
  for (const b of batches) index.append(b);
  const formats = fields.map(columnFormat);
  const all = { rowStart: 0, rowEnd: 2, columnStart: 0, columnEnd: 4 };

  test("TSV: NULL as text, a value with a tab or quote quoted, no header unless asked", () => {
    expect(serializeRange(index, fields, formats, all, "tsv", false)).toBe(
      ["1\t9007199254740993\tplain\t0.5\ttrue", 'NULL\t2\t"a,""quoted""\ttab"\tNaN\tfalse', "3\tNULL\t\t-0\tNULL"].join("\n"),
    );
    expect(serializeRange(index, fields, formats, { ...all, rowEnd: 0, columnEnd: 1 }, "tsv", true)).toBe("n\tbig\n1\t9007199254740993");
  });

  test("CSV quotes commas and quotes", () => {
    expect(serializeRange(index, fields, formats, { rowStart: 1, rowEnd: 1, columnStart: 2, columnEnd: 2 }, "csv", true)).toBe('t\n"a,""quoted""\ttab"');
  });

  test("JSON: numbers where exact, Int64 as a string, NULL as null; arrays without headers", () => {
    expect(JSON.parse(serializeRange(index, fields, formats, all, "json", true))).toEqual([
      { n: 1, big: "9007199254740993", t: "plain", f: 0.5, b: true },
      { n: null, big: "2", t: 'a,"quoted"\ttab', f: "NaN", b: false },
      { n: 3, big: null, t: "", f: "-0", b: null },
    ]);
    expect(JSON.parse(serializeRange(index, fields, formats, { ...all, rowEnd: 0, columnEnd: 1 }, "json", false))).toEqual([[1, "9007199254740993"]]);
  });

  test("a range past the loaded rows copies what is loaded", () => {
    expect(serializeRange(index, fields, formats, { rowStart: 1, rowEnd: 1_000_000, columnStart: 0, columnEnd: 0 }, "tsv", false)).toBe("NULL\n3");
  });
});
