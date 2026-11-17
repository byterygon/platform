// DataGrid in jsdom: the shell, the cell layer's rows and cells, scrolling, and axe.
import { act } from "react";
import { describe, expect, test } from "vitest";
import { axeViolations, render, rowsIn, textOf } from "./render.tsx";
import { decoded, driverTable, table } from "./support.ts";

async function bigResult(rows: number, batchRows: number) {
  const ids = Array.from({ length: rows }, (_, i) => i);
  return decoded(
    table(
      {
        id: { kind: "int64", values: ids.map(BigInt) },
        name: { kind: "utf8", values: ids.map((i) => (i % 10 === 3 ? null : `name ${i}`)) },
        n: { kind: "int32", values: ids },
      },
      Array.from({ length: rows / batchRows }, () => batchRows),
    ),
  );
}

describe("DataGrid", () => {
  test("renders the header and the rows in view from the batches", async () => {
    const { fields, batches } = await decoded(driverTable());
    const el = render({ fields, batches, "aria-label": "Result" });
    const grid = el.querySelector("[role=grid]")!;
    expect(grid.getAttribute("aria-rowcount")).toBe("5");
    expect(grid.getAttribute("aria-colcount")).toBe(String(fields.length + 1));
    const headers = [...el.querySelectorAll("[role=columnheader]")];
    expect(headers.map((h) => h.querySelector(".bdg-name")?.textContent ?? "corner")).toEqual(["corner", ...fields.map((f) => f.name)]);
    expect(headers[4]!.getAttribute("aria-description")).toBe("bigint");
    expect(headers[10]!.getAttribute("aria-description")).toBe("uuid");
    expect(headers[4]!.querySelector(".bdg-glyph")!.getAttribute("data-family")).toBe("integer");
    const rows = rowsIn(el);
    expect(rows.map((r) => r.getAttribute("aria-rowindex"))).toEqual(["2", "3", "4", "5"]);
    expect(rows.map((r) => r.querySelector("[role=rowheader]")!.textContent)).toEqual(["1", "2", "3", "4"]);
    // The cells in view (640 px wide shows the first columns).
    const first = textOf(rows[0]!);
    expect(first.slice(0, 4)).toEqual(["true", "-32768", "-2147483648", "9223372036854775807"]);
    const nullCell = rows[2]!.querySelector<HTMLElement>("[aria-colindex='2']")!;
    expect(nullCell.textContent).toBe("NULL");
    expect(nullCell.classList.contains("bdg-null")).toBe(true);
    expect(rows[0]!.querySelector("[aria-colindex='5']")!.classList.contains("bdg-end")).toBe(true);
    expect(rows[0]!.querySelector("[aria-colindex='2']")!.classList.contains("bdg-center")).toBe(true);
  });

  test("passes axe", async () => {
    const { fields, batches } = await decoded(driverTable());
    const el = render({ fields, batches, "aria-label": "Result" });
    expect(await axeViolations(el)).toEqual([]);
  });

  test("only the rows and columns in view exist in the DOM", async () => {
    const { fields, batches } = await bigResult(10_000, 1000);
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, columnWidths: [100, 300, 400] });
    // (320 - 20 header) / 20 = 15 rows plus 4 overscan below.
    expect(rowsIn(el)).toHaveLength(19);
    expect(el.querySelectorAll("[role=gridcell]").length).toBeLessThanOrEqual(19 * 3);
    expect(textOf(rowsIn(el)[3]!)).toEqual(["3", "NULL", "3"].slice(0, textOf(rowsIn(el)[3]!).length));
  });

  test("scrolling recycles rows: the DOM stays the same size and shows the new rows", async () => {
    const { fields, batches } = await bigResult(10_000, 1000);
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, columnWidths: [100, 100, 100] });
    const scroller = el.querySelector<HTMLElement>(".bdg-scroller")!;
    const before = el.querySelectorAll(".bdg-body > [role=row]").length;
    scroller.scrollTop = 5000 * 20;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    const rows = rowsIn(el);
    const indices = rows.map((r) => Number(r.getAttribute("aria-rowindex")) - 2).sort((a, b) => a - b);
    expect(indices[0]).toBe(4996);
    expect(indices.at(-1)).toBe(5000 + 15 + 3);
    const row5000 = rows.find((r) => r.getAttribute("aria-rowindex") === "5002")!;
    expect(textOf(row5000)).toEqual(["5000", "name 5000", "5000"]);
    expect(row5000.style.transform).toBe(`translateY(${20 + 5000 * 20}px)`);
    expect(el.querySelectorAll(".bdg-body > [role=row]").length).toBeLessThanOrEqual(before + 8);
  });

  test("horizontal scrolling renders the columns in view", async () => {
    const { fields, batches } = await bigResult(100, 100);
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 20, columnWidths: [700, 700, 700] });
    const scroller = el.querySelector<HTMLElement>(".bdg-scroller")!;
    const cols = () => [...rowsIn(el)[0]!.querySelectorAll("[role=gridcell]:not([hidden])")].map((c) => c.getAttribute("aria-colindex"));
    expect(cols()).toEqual(["2", "3"]);
    scroller.scrollLeft = 1500;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(cols()).toEqual(["3", "4"]);
  });

  test("a million rows fit the engines' height cap", async () => {
    const { fields, batches } = await bigResult(1_000_000, 100_000);
    const el = render({ fields, batches, "aria-label": "Result", rowHeight: 32 });
    const sizer = el.querySelector<HTMLElement>(".bdg-sizer")!;
    expect(Number.parseFloat(sizer.style.height)).toBeLessThanOrEqual(15_000_000 + 32);
    expect(el.querySelector("[role=grid]")!.getAttribute("aria-rowcount")).toBe("1000001");
  });
});
