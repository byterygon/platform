// BatchIndex, the virtualizer and the text cache.
import { describe, expect, test } from "vitest";
import { BatchIndex, batchByteLength, ColumnAxis, MAX_SCROLL_HEIGHT, RowAxis, TextCache } from "../src/index.ts";
import { decoded, table } from "./support.ts";

describe("BatchIndex", () => {
  test("maps global rows to (batch, row) by the prefix sums, batches kept as received", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => i);
    const { batches } = await decoded(table({ id: { kind: "int32", values: ids } }, [3, 4, 0, 3]));
    const index = new BatchIndex();
    for (const b of batches) index.append(b);
    expect(index.rowCount).toBe(10);
    expect(index.batchCount).toBe(3);
    for (const b of batches.filter((x) => x.numRows > 0)) expect(batches).toContain(b);
    const located = ids.map((row) => [index.locate(row), row - index.start(index.locate(row))]);
    expect(located).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 0],
      [2, 1],
      [2, 2],
    ]);
    // Out of order lookups (the cache of the last batch must not mislead).
    expect([9, 0, 5, 3, 2].map((r) => index.locate(r))).toEqual([2, 0, 1, 1, 0]);
    const cell = index.cell(8, 0)!;
    expect((cell.data.values as Int32Array)[cell.row]).toBe(8);
    expect(index.cell(10, 0)).toBeUndefined();
  });

  test("counts every buffer's bytes for the memory budget", async () => {
    const { batches } = await decoded(table({ id: { kind: "int64", values: [1n, null, 3n] }, t: { kind: "utf8", values: ["ab", "", "c"] } }));
    const batch = batches[0]!;
    const [id, t] = batch.columns;
    const expected = (id!.validity?.byteLength ?? 0) + id!.values!.byteLength + t!.offsets!.byteLength + t!.values!.byteLength + (t!.validity?.byteLength ?? 0);
    expect(batchByteLength(batch)).toBe(expected);
    const index = new BatchIndex();
    index.append(batch);
    index.append(batch);
    expect(index.byteLength).toBe(2 * expected);
  });
});

describe("RowAxis", () => {
  test("the rows in view are a division, widened by the overscan", () => {
    const rows = new RowAxis(22);
    rows.count = 1000;
    rows.viewport = 220;
    expect(rows.window(0)).toEqual({ start: 0, end: 10 });
    expect(rows.window(11)).toEqual({ start: 0, end: 11 });
    expect(rows.window(2200, 2)).toEqual({ start: 98, end: 112 });
    expect(rows.window(1e9)).toEqual({ start: 1000, end: 1000 });
    expect(rows.offsetOf(5, 1234)).toBe(110);
  });

  test("past the engines' height cap the scroll range is scaled, and the ends still reach the ends", () => {
    const rows = new RowAxis(32);
    rows.count = 1_000_000;
    rows.viewport = 640;
    expect(rows.scaled).toBe(true);
    expect(rows.scrollHeight).toBe(MAX_SCROLL_HEIGHT);
    const max = rows.scrollHeight - rows.viewport;
    expect(rows.window(max)).toEqual({ start: 1_000_000 - 20, end: 1_000_000 });
    expect(rows.window(0).start).toBe(0);
    // The rendered rows sit in the viewport, at the row height apart.
    const scrollTop = max / 2;
    const { start } = rows.window(scrollTop);
    const top = rows.offsetOf(start, scrollTop);
    expect(top).toBeLessThanOrEqual(scrollTop);
    expect(top).toBeGreaterThan(scrollTop - 32);
    expect(rows.offsetOf(start + 1, scrollTop) - top).toBeCloseTo(32);
    // Round trip.
    expect(rows.toVirtual(rows.toScroll(12_345_678))).toBeCloseTo(12_345_678, 3);
  });

  test("reveal scrolls a row into view only when it is outside", () => {
    const rows = new RowAxis(20);
    rows.count = 100;
    rows.viewport = 100;
    expect(rows.reveal(2, 0)).toBe(0);
    expect(rows.reveal(10, 0)).toBe(120);
    expect(rows.reveal(3, 120)).toBe(60);
  });
});

describe("ColumnAxis", () => {
  test("the columns in view by binary search over the widths", () => {
    const cols = new ColumnAxis([100, 50, 200, 80, 120]);
    expect(cols.totalWidth).toBe(550);
    expect(cols.left(3)).toBe(350);
    expect(cols.window(0, 120)).toEqual({ start: 0, end: 2 });
    expect(cols.window(160, 200)).toEqual({ start: 2, end: 4 });
    expect(cols.window(160, 200, 1)).toEqual({ start: 1, end: 5 });
    expect(cols.window(10_000, 100)).toEqual({ start: 4, end: 5 });
    expect(cols.reveal(3, 0, 200)).toBe(230);
    expect(cols.reveal(0, 230, 200)).toBe(0);
    expect(cols.reveal(2, 150, 300)).toBe(150);
    expect(new ColumnAxis().window(0, 100)).toEqual({ start: 0, end: 0 });
  });
});

describe("TextCache", () => {
  test("keeps the most recently used entries, NULL included", () => {
    const cache = new TextCache(2);
    cache.set(1, "a");
    cache.set(2, null);
    expect(cache.get(1)).toBe("a");
    cache.set(3, "c");
    expect(cache.get(2)).toBeUndefined();
    expect(cache.get(1)).toBe("a");
    expect(cache.get(3)).toBe("c");
    cache.set(4, null);
    expect(cache.get(4)).toBeNull();
    expect(cache.size).toBe(2);
  });
});
