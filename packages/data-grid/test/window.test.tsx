// A live view's window (Mightyconsole spec §5.5, TSK-80): the newest rows kept and the oldest
// batches dropped whole, Pause holding the pull (so no credit is granted), Clear emptying the
// view while the stream goes on; the grid keeps its rows in view and its selection with them.
import { act } from "react";
import { describe, expect, test } from "vitest";
import { BatchIndex, ResultSource, type ResultProgress, batchByteLength } from "../src/index.ts";
import { nextFrame, render, rowsIn, textOf } from "./render.tsx";
import { countingStream, decoded, idTable, settle } from "./support.ts";

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await settle(1);
  }
}

describe("BatchIndex.dropFirst", () => {
  test("drops whole batches and renumbers the rest", async () => {
    const { batches } = await decoded(idTable(300, 100));
    const index = new BatchIndex();
    for (const b of batches) index.append(b);
    const bytes = index.byteLength;
    expect(index.dropFirst(1)).toBe(100);
    expect(index.rowCount).toBe(200);
    expect(index.batchCount).toBe(2);
    expect(index.byteLength).toBe(bytes - batchByteLength(batches[0]!));
    expect(index.start(0)).toBe(0);
    expect(index.locate(150)).toBe(1);
    expect(index.cell(0, 0)!.row).toBe(0);
    expect(index.dropFirst(9)).toBe(200);
    expect(index.rowCount).toBe(0);
  });
});

describe("ResultSource window, hold and clear", () => {
  test("maxRows keeps the newest batches; the newest batch always stays", async () => {
    const s = countingStream(idTable(1000, 100));
    const source = ResultSource.fromStream(s.stream);
    source.window = { maxRows: 250 };
    source.subscribe(() => {});
    await until(() => !source.live);
    expect(source.index.rowCount).toBe(200);
    expect(source.dropped).toBe(800);
    expect(source.progress.dropped).toBe(800);
    source.window = { maxRows: 10 };
    expect(source.index.rowCount).toBe(100);
  });

  test("maxBytes drops by batch too", async () => {
    const t = idTable(500, 100);
    const { batches } = await decoded(t);
    const s = countingStream(t);
    const source = ResultSource.fromStream(s.stream);
    source.window = { maxBytes: Math.floor(batchByteLength(batches[0]!) * 2.5) };
    source.subscribe(() => {});
    await until(() => !source.live);
    expect(source.index.batchCount).toBe(2);
  });

  test("hold stops pulling, so no more chunks are taken; releasing resumes", async () => {
    const s = countingStream(idTable(2000, 100));
    const source = ResultSource.fromStream(s.stream);
    source.hold = true;
    source.subscribe(() => {});
    await until(() => source.state === "paused");
    await settle(20);
    const taken = s.taken;
    await settle(20);
    expect(s.taken).toBe(taken);
    expect(source.index.rowCount).toBe(0);
    source.hold = false;
    await until(() => !source.live);
    expect(source.index.rowCount).toBe(2000);
  });

  test("clear drops every row and keeps the stream", async () => {
    const s = countingStream(idTable(400, 100));
    const source = ResultSource.fromStream(s.stream);
    source.hold = true;
    source.subscribe(() => {});
    await until(() => source.state === "paused");
    source.hold = false;
    await until(() => source.index.rowCount >= 100);
    source.clear();
    expect(source.index.rowCount).toBe(0);
    await until(() => !source.live);
    expect(source.state).toBe("done");
    expect(source.index.rowCount + source.dropped).toBe(400);
  });
});

describe("DataGrid with a window", () => {
  test("shows only the newest rows, renumbered; the handle clears", async () => {
    const s = countingStream(idTable(1000, 100));
    let handle: { clear(): void } | null = null;
    const progress: ResultProgress[] = [];
    const el = render({ stream: s.stream, maxRows: 300, rowHeight: 20, "aria-label": "Messages", ref: (h) => {
        handle = h;
      }, onProgress: (p) => progress.push(p) });
    await act(async () => {
      while (progress.at(-1)?.state !== "done") await settle(2);
    });
    await nextFrame();
    expect(progress.at(-1)!.dropped).toBe(700);
    const grid = el.querySelector("[role=grid]")!;
    expect(grid.getAttribute("aria-rowcount")).toBe("301");
    const first = rowsIn(el)[0]!;
    expect(first.querySelector("[role=rowheader]")!.textContent).toBe("1");
    expect(textOf(first)[0]).toBe("700");
    await act(async () => handle!.clear());
    await nextFrame();
    expect(grid.getAttribute("aria-rowcount")).toBe("1");
  });
});
