import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, focus, honoursReducedMotion } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { pageItems, Pagination } from "./pagination";

afterEach(cleanup);

const pages = () => $$('[data-slot="pagination-page"]').map((button) => button.textContent);

describe("Pagination", () => {
  test("a named nav with arrows, numbered page buttons and the current page", async () => {
    const { container } = render(<Pagination page={2} pageCount={5} />);
    expect($("nav")!.getAttribute("aria-label")).toBe("Pagination");
    expect(pages()).toEqual(["1", "2", "3", "4", "5"]);
    const current = $('[aria-current="page"]')!;
    expect(current.textContent).toBe("2");
    expect(current.getAttribute("aria-label")).toBe("Page 2");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("clicking a page or an arrow reports the page; the ends disable their arrow", async () => {
    const onPageChange = vi.fn();
    render(<Pagination page={1} pageCount={3} onPageChange={onPageChange} />);
    const previous = $<HTMLButtonElement>('[aria-label="Previous page"]')!;
    expect(previous.disabled).toBe(true);
    await click($$("button").find((b) => b.textContent === "3")!);
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    await click($('[aria-label="Next page"]')!);
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    await click($$("button").find((b) => b.textContent === "1")!);
    expect(onPageChange).toHaveBeenCalledTimes(2);
  });

  test("long ranges show the first, the last, the neighbours and gaps", () => {
    render(<Pagination page={12} pageCount={40} />);
    expect(pages()).toEqual(["1", "11", "12", "13", "40"]);
    expect($$('[data-slot="pagination-ellipsis"]')).toHaveLength(2);
    expect($('[data-slot="pagination-ellipsis"]')!.getAttribute("aria-hidden")).toBe("true");
    expect(pageItems(1, 40)).toEqual([1, 2, 3, 4, 5, "gap", 40]);
    expect(pageItems(40, 40)).toEqual([1, "gap", 36, 37, 38, 39, 40]);
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pageItems(5, 0)).toEqual([]);
  });

  test("buttons are in the tab order; disabled disables them all", async () => {
    render(<Pagination page={3} pageCount={8} disabled />);
    for (const button of $$<HTMLButtonElement>("button")) expect(button.disabled).toBe(true);
    cleanup();
    render(<Pagination page={3} pageCount={8} />);
    const third = $$<HTMLButtonElement>("button").find((b) => b.textContent === "3")!;
    await focus(third);
    expect(document.activeElement).toBe(third);
  });

  test("honours reduced motion", () => {
    render(<Pagination page={3} pageCount={8} />);
    expect(honoursReducedMotion($$("[data-slot^='pagination']"))).toEqual([]);
  });
});
