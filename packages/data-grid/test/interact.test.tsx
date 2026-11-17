// DataGrid behaviour: keyboard, pointer, copy, the value viewer hook, column resize, roving focus,
// streaming (aria-rowcount, budget, cancel) and the live region.
import { act, createRef } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { batchByteLength, type DataGridHandle, type ResultProgress, type SelectionInfo } from "../src/index.ts";
import { axeViolations, cell, nextFrame, render } from "./render.tsx";
import { countingStream, decoded, idTable, settle } from "./support.ts";

let clipboard: string[] = [];
beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => (clipboard.push(text), Promise.resolve()) },
  });
});

const grid = (el: HTMLElement) => el.querySelector<HTMLElement>("[role=grid]")!;
const status = (el: HTMLElement) => el.querySelector("[role=status]")!.textContent;

function key(el: HTMLElement, key: string, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {}) {
  const target = (document.activeElement as HTMLElement | null) ?? grid(el);
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt }));
  });
}

function pointer(target: Element, shift = false) {
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, shiftKey: shift }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, shiftKey: shift }));
  });
}

const selected = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>("[role=gridcell][aria-selected=true]:not([hidden])")].map((c) => `${c.dataset["row"]}:${c.dataset["column"]}`).sort();

async function small() {
  return decoded(idTable(1000, 250));
}

describe("keyboard", () => {
  test("Tab lands on the grid, the first cell becomes active and focused; arrows move it", async () => {
    const { fields, batches } = await small();
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20 });
    act(() => grid(el).focus());
    const first = cell(el, 0, 0)!;
    expect(document.activeElement).toBe(first);
    expect(first.tabIndex).toBe(0);
    expect(grid(el).tabIndex).toBe(-1);
    key(el, "ArrowDown");
    key(el, "ArrowRight");
    expect(document.activeElement).toBe(cell(el, 1, 1));
    expect(cell(el, 1, 1)!.classList.contains("bdg-active")).toBe(true);
    expect(first.tabIndex).toBe(-1);
    // Only one tab stop.
    expect(el.querySelectorAll("[role=grid] [tabindex='0']")).toHaveLength(1);
  });

  test("Page Down and Ctrl+End scroll the active cell into view and keep the focus on it", async () => {
    const { fields, batches } = await small();
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20 });
    act(() => grid(el).focus());
    key(el, "PageDown");
    const scroller = grid(el);
    expect(document.activeElement).toBe(cell(el, 14, 0));
    key(el, "End", { ctrl: true });
    expect(scroller.scrollTop).toBe(999 * 20 + 20 - (320 - 20));
    expect(document.activeElement).toBe(cell(el, 999, 1));
    key(el, "Home", { ctrl: true });
    expect(scroller.scrollTop).toBe(0);
    expect(document.activeElement).toBe(cell(el, 0, 0));
  });

  test("Shift+arrows select a range; Ctrl+A selects all; Escape collapses", async () => {
    const { fields, batches } = await small();
    const onSelectionChange = vi.fn<(s: SelectionInfo) => void>();
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, onSelectionChange });
    act(() => grid(el).focus());
    key(el, "ArrowDown", { shift: true });
    key(el, "ArrowRight", { shift: true });
    expect(selected(el)).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    expect(onSelectionChange.mock.lastCall![0]).toMatchObject({ active: { row: 1, column: 1 }, cells: 4, value: "name 1" });
    key(el, "a", { ctrl: true });
    expect(onSelectionChange.mock.lastCall![0].cells).toBe(2000);
    expect(el.querySelector(".bdg-body [aria-rowindex='5']")!.classList.contains("bdg-row-selected")).toBe(true);
    key(el, "Escape");
    expect(selected(el)).toEqual([]);
  });

  test("Ctrl+C copies the selection as TSV and announces it; Ctrl+Shift+C asks the application", async () => {
    const { fields, batches } = await small();
    const onCopyWithHeaders = vi.fn();
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, onCopyWithHeaders });
    act(() => grid(el).focus());
    key(el, "ArrowDown", { shift: true });
    key(el, "ArrowDown", { shift: true });
    key(el, "ArrowRight", { shift: true });
    key(el, "c", { ctrl: true });
    await act(() => settle());
    expect(clipboard).toEqual(["0\tname 0\n1\tname 1\n2\tname 2"]);
    expect(status(el)).toBe("Copied 6 cells");
    key(el, "C", { ctrl: true, shift: true });
    expect(onCopyWithHeaders).toHaveBeenCalledTimes(1);
  });

  test("the handle copies CSV and JSON with headers", async () => {
    const { fields, batches } = await small();
    const ref = createRef<DataGridHandle>();
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, ref });
    act(() => grid(el).focus());
    key(el, "ArrowDown");
    key(el, "ArrowDown");
    key(el, "ArrowDown");
    key(el, "ArrowRight", { shift: true });
    await act(async () => {
      await ref.current!.copy("csv", true);
    });
    expect(clipboard.at(-1)).toBe("id,name\n3,NULL");
    expect(JSON.parse(ref.current!.selectionText("json", true))).toEqual([{ id: "3", name: null }]);
    expect(ref.current!.cellValue(3, 1)).toBeNull();
    expect(ref.current!.cellValue(4, 1)).toBe("name 4");
    expect(ref.current!.cellValue(5000, 0)).toBeUndefined();
  });

  test("Enter and F2 open the value viewer; a double click too", async () => {
    const { fields, batches } = await small();
    const onOpenCell = vi.fn();
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, onOpenCell });
    act(() => grid(el).focus());
    key(el, "ArrowRight");
    key(el, "Enter");
    key(el, "F2");
    expect(onOpenCell.mock.calls).toEqual([[{ row: 0, column: 1 }], [{ row: 0, column: 1 }]]);
    act(() => {
      cell(el, 2, 0)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onOpenCell).toHaveBeenLastCalledWith({ row: 2, column: 0 });
  });

  test("Alt+Shift+Right and Left resize the active column and report the widths", async () => {
    const { fields, batches } = await small();
    const onColumnWidthsChange = vi.fn<(w: readonly number[]) => void>();
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, onColumnWidthsChange });
    act(() => grid(el).focus());
    const header = el.querySelectorAll<HTMLElement>("[role=columnheader]")[1]!;
    const before = Number.parseFloat(header.style.width);
    key(el, "ArrowRight", { alt: true, shift: true });
    key(el, "ArrowRight", { alt: true, shift: true });
    key(el, "ArrowLeft", { alt: true, shift: true });
    const after = Number.parseFloat(header.style.width);
    expect(after).toBe(before + Math.round(2 * 7.25));
    expect(onColumnWidthsChange).toHaveBeenCalledTimes(3);
    expect(onColumnWidthsChange.mock.lastCall![0][0]).toBe(after);
    expect(Number.parseFloat(cell(el, 0, 0)!.style.width)).toBe(after);
  });
});

describe("pointer", () => {
  test("click selects a cell, Shift+click a range, the row number a row, the header a column", async () => {
    const { fields, batches } = await small();
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20 });
    pointer(cell(el, 1, 0)!);
    expect(cell(el, 1, 0)!.classList.contains("bdg-active")).toBe(true);
    pointer(cell(el, 3, 1)!, true);
    expect(selected(el)).toEqual(["1:0", "1:1", "2:0", "2:1", "3:0", "3:1"]);
    pointer(el.querySelector(".bdg-body [aria-rowindex='7'] .bdg-rownum")!);
    expect(selected(el)).toEqual(["5:0", "5:1"]);
    const header = el.querySelectorAll<HTMLElement>("[role=columnheader]")[2]!;
    pointer(header);
    expect(header.getAttribute("aria-selected")).toBe("true");
    expect(selected(el).every((k) => k.endsWith(":1"))).toBe(true);
    expect(selected(el).length).toBeGreaterThan(10);
  });

  test("dragging a header's edge resizes the column and commits once on release", async () => {
    const { fields, batches } = await small();
    const onColumnWidthsChange = vi.fn();
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, onColumnWidthsChange });
    const header = el.querySelectorAll<HTMLElement>("[role=columnheader]")[1]!;
    const handle = header.querySelector<HTMLElement>(".bdg-resize")!;
    const before = Number.parseFloat(header.style.width);
    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100 }));
      handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 160 }));
      handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 160 }));
    });
    expect(Number.parseFloat(header.style.width)).toBe(before + 60);
    expect(onColumnWidthsChange).toHaveBeenCalledTimes(1);
  });
});

describe("streaming", () => {
  test("rows appear as batches arrive; aria-rowcount is -1 until the end; the end is announced", async () => {
    const s = countingStream(idTable(3000, 500));
    const progress: ResultProgress[] = [];
    const el = render({ stream: s.stream, "aria-label": "Result", rowHeight: 20, onProgress: (p) => progress.push(p) });
    expect(grid(el).getAttribute("aria-rowcount")).toBe("-1");
    await act(async () => {
      while (progress.at(-1)?.state !== "done") await settle(2);
    });
    await nextFrame();
    expect(grid(el).getAttribute("aria-rowcount")).toBe("3001");
    expect(cell(el, 0, 1)!.textContent).toBe("name 0");
    expect(progress.map((p) => p.rows).filter((r, i, a) => a.indexOf(r) === i)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000]);
    expect(status(el)).toBe("3,000 rows loaded");
  });

  test("the viewport does not move while rows arrive; scrolling near the end resumes a paused stream", async () => {
    const t = idTable(5000, 250);
    const { batches } = await decoded(t);
    const s = countingStream(t);
    const ref = createRef<DataGridHandle>();
    const el = render({ stream: s.stream, "aria-label": "Result", rowHeight: 20, memoryBudget: batchByteLength(batches[0]!) * 4, ref });
    await act(async () => {
      while (ref.current!.progress.state !== "paused") await settle(2);
    });
    await nextFrame();
    expect(ref.current!.progress.rows).toBe(1000);
    expect(status(el)).toBe("Loaded 1,000 rows, scroll for more");
    const scroller = grid(el);
    expect(scroller.scrollTop).toBe(0);
    // Scroll to within two screens of the last loaded row: one more batch, then paused again.
    scroller.scrollTop = 1000 * 20 - 320;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await nextFrame();
    await act(async () => {
      while (ref.current!.progress.rows < 1250) await settle(2);
      await settle(10);
    });
    await nextFrame();
    expect(ref.current!.progress.rows).toBe(1250);
    expect(scroller.scrollTop).toBe(1000 * 20 - 320);
  });

  test("cancel keeps the loaded rows and announces it", async () => {
    const t = idTable(5000, 250);
    const { batches } = await decoded(t);
    const s = countingStream(t);
    const ref = createRef<DataGridHandle>();
    const el = render({ stream: s.stream, "aria-label": "Result", rowHeight: 20, memoryBudget: batchByteLength(batches[0]!) * 2, ref });
    await act(async () => {
      while (ref.current!.progress.state !== "paused") await settle(2);
      ref.current!.cancel();
      while ((ref.current!.progress.state as string) !== "cancelled") await settle(2);
    });
    await nextFrame();
    expect(s.cancelled).toBe(true);
    expect(grid(el).getAttribute("aria-rowcount")).toBe("501");
    expect(status(el)).toBe("Cancelled, 500 rows kept");
  });

  test("passes axe with a selection while streaming", async () => {
    const s = countingStream(idTable(2000, 500));
    const el = render({ stream: s.stream, "aria-label": "Result", rowHeight: 20 });
    await act(() => settle(20));
    await nextFrame();
    act(() => grid(el).focus());
    key(el, "ArrowDown", { shift: true });
    expect(await axeViolations(el)).toEqual([]);
  });
});

describe("widths", () => {
  test("given widths win per column; a missing entry takes the default", async () => {
    const { fields, batches } = await decoded(idTable(10, 10));
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, columnWidths: [undefined, 333] });
    const headers = el.querySelectorAll<HTMLElement>("[role=columnheader]");
    expect(Number.parseFloat(headers[2]!.style.width)).toBe(333);
    expect(Number.parseFloat(headers[1]!.style.width)).toBeGreaterThan(40);
    expect(Number.parseFloat(headers[1]!.style.width)).not.toBe(333);
  });
});
