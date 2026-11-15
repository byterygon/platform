import { createRef } from "react";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { tokenPx } from "@/lib/theme-scope";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableNull, TableRow, TableVirtualBody } from "./table";

afterEach(cleanup);

function Small(props: { onSort?: () => void }) {
  return (
    <Table aria-label="Columns" variant="striped">
      <TableCaption>3 columns</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead sort="ascending" onSort={props.onSort}>
            Name
          </TableHead>
          <TableHead align="end">Position</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {["id", "status", "total"].map((name, i) => (
          <TableRow key={name} selected={name === "status"}>
            <TableCell>{name}</TableCell>
            <TableCell align="end">{i === 2 ? <TableNull /> : i + 1}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

describe("Table", () => {
  test("is a semantic table named by its label, in a focusable region", async () => {
    const { container } = render(<Small />);
    const region = container.querySelector('[data-slot="table"]') as HTMLElement;
    expect(region.getAttribute("role")).toBe("region");
    expect(region.tabIndex).toBe(0);
    const table = region.querySelector("table")!;
    expect(table.getAttribute("aria-label")).toBe("Columns");
    expect(table.querySelectorAll('thead th[scope="col"]')).toHaveLength(2);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a sortable head has aria-sort and a button that calls onSort", async () => {
    const onSort = vi.fn();
    const { container } = render(<Small onSort={onSort} />);
    const th = container.querySelector("th")!;
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    await click(th.querySelector("button")!);
    expect(onSort).toHaveBeenCalledOnce();
  });

  test("selected rows, striping marks, alignment and NULL", () => {
    const { container } = render(<Small />);
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
    expect(rows.map((r) => r.hasAttribute("data-odd"))).toEqual([false, true, false]);
    expect(container.querySelector('td[data-align="end"]')).not.toBeNull();
    const nil = container.querySelector('[data-slot="table-null"]')!;
    expect(nil.textContent).toBe("NULL");
    expect(nil.className).toContain("text-grid-null");
  });

  test("cells truncate unless wrap", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>one</TableCell>
            <TableCell wrap>two</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const [one, two] = container.querySelectorAll("td");
    expect(one!.className).toContain("truncate");
    expect(two!.hasAttribute("data-wrap")).toBe(true);
    expect(container.querySelector('[data-slot="table"]')!.hasAttribute("role")).toBe(false);
  });

  test("TableVirtualBody renders a window of 100,000 rows with aria-rowcount and aria-rowindex", async () => {
    const renderRow = vi.fn((i: number) => (
      <TableRow key={i}>
        <TableCell>{i}</TableCell>
      </TableRow>
    ));
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <Table ref={ref} aria-label="Result">
        <TableHeader>
          <TableRow>
            <TableHead>id</TableHead>
          </TableRow>
        </TableHeader>
        <TableVirtualBody count={100_000} renderRow={renderRow} overscan={5} />
      </Table>,
    );
    await act(async () => {});
    const table = container.querySelector("table")!;
    expect(table.getAttribute("aria-rowcount")).toBe("100001");
    const rows = [...container.querySelectorAll('tbody tr:not([data-spacer])')];
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(60);
    expect(rows[0]!.getAttribute("aria-rowindex")).toBe("2");
    expect(renderRow.mock.calls.length).toBeLessThan(200);
    const spacers = container.querySelectorAll<HTMLElement>("tr[data-spacer] td");
    expect(spacers[1]!.style.height).not.toBe("0px");
    expect(await axeViolations(container)).toEqual([]);

    // Scroll to the middle: the window moves, the top spacer grows, rows keep their absolute index.
    const scroller = ref.current!;
    const rowHeight = tokenPx(scroller, "--by-grid-row-height", 28);
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    scroller.scrollTop = rowHeight * 50_000;
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const moved = [...container.querySelectorAll('tbody tr:not([data-spacer])')];
    const firstIndex = Number(moved[0]!.getAttribute("aria-rowindex"));
    expect(firstIndex).toBeGreaterThan(49_000);
    expect(firstIndex).toBeLessThan(50_100);
    expect(moved.length).toBeLessThan(60);
    expect(Number.parseFloat(spacers[0]!.style.height)).toBeGreaterThan(0);
  });

  test("TableVirtualBody outside a Table throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<table><TableVirtualBody count={1} renderRow={() => <tr />} /></table>)).toThrow(/inside a Table/);
    vi.restoreAllMocks();
  });
});
