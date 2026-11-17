// The grid's own two-axis virtualizer (Decision 17). Rows have one fixed height, so the rows in
// view are a division; columns have their own widths, so the columns in view are a binary search
// over the prefix sums of the widths.
//
// Browsers cap an element's height (Chromium near 33.5 million px, Firefox near 17.9 million):
// 1,000,000 rows at 32 px would not fit. Past `MAX_SCROLL_HEIGHT` the scroll range is scaled: the
// scrollbar covers the whole result, one scrolled pixel moves the content more than one pixel, and
// the rendered rows are placed relative to the viewport. Below it the mapping is the identity.

/** The tallest scroll range the grid creates (safe in every engine DBee ships on). */
export const MAX_SCROLL_HEIGHT = 15_000_000;

/** A half-open range of indices. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** The vertical mapping between the scroller's `scrollTop` and the content's virtual offset. */
export class RowAxis {
  #rowHeight: number;
  #count = 0;
  #viewport = 0;

  readonly maxScrollHeight: number;

  constructor(rowHeight: number, maxScrollHeight = MAX_SCROLL_HEIGHT) {
    this.#rowHeight = rowHeight;
    this.maxScrollHeight = maxScrollHeight;
  }

  get rowHeight(): number {
    return this.#rowHeight;
  }

  get count(): number {
    return this.#count;
  }

  set rowHeight(h: number) {
    this.#rowHeight = Math.max(1, h);
  }

  set count(n: number) {
    this.#count = Math.max(0, n);
  }

  /** The height of the body's visible area (the scroller minus the sticky header). */
  set viewport(h: number) {
    this.#viewport = Math.max(0, h);
  }

  get viewport(): number {
    return this.#viewport;
  }

  /** The full height of the rows. */
  get contentHeight(): number {
    return this.#count * this.#rowHeight;
  }

  /** The height of the scroll range the body gets (equal to `contentHeight` unless scaled). */
  get scrollHeight(): number {
    return Math.min(this.contentHeight, this.maxScrollHeight);
  }

  get scaled(): boolean {
    return this.contentHeight > this.maxScrollHeight;
  }

  /** The content offset at the top of the viewport for a scroll position. */
  toVirtual(scrollTop: number): number {
    if (!this.scaled) return scrollTop;
    const range = this.scrollHeight - this.#viewport;
    if (range <= 0) return 0;
    const t = Math.min(1, Math.max(0, scrollTop / range));
    return t * (this.contentHeight - this.#viewport);
  }

  /** The scroll position that puts content offset `virtualTop` at the top of the viewport. */
  toScroll(virtualTop: number): number {
    if (!this.scaled) return virtualTop;
    const range = this.contentHeight - this.#viewport;
    if (range <= 0) return 0;
    const t = Math.min(1, Math.max(0, virtualTop / range));
    return t * (this.scrollHeight - this.#viewport);
  }

  /** The rows that intersect the viewport, widened by `overscan` rows on each side. */
  window(scrollTop: number, overscan = 0): Span {
    const h = this.#rowHeight;
    const top = this.toVirtual(scrollTop);
    const start = Math.min(this.#count, Math.max(0, Math.floor(top / h) - overscan));
    const end = Math.min(this.#count, Math.ceil((top + this.#viewport) / h) + overscan);
    return { start, end: Math.max(start, end) };
  }

  /** Where row `row` sits inside the body's scroll range, for a scroll position. */
  offsetOf(row: number, scrollTop: number): number {
    const top = row * this.#rowHeight;
    return this.scaled ? scrollTop + (top - this.toVirtual(scrollTop)) : top;
  }

  /** The scroll position that brings `row` fully into view, or `scrollTop` when it already is. */
  reveal(row: number, scrollTop: number): number {
    const h = this.#rowHeight;
    const top = row * h;
    const current = this.toVirtual(scrollTop);
    if (top < current) return this.toScroll(top);
    if (top + h > current + this.#viewport) return this.toScroll(top + h - this.#viewport);
    return scrollTop;
  }
}

/** Column widths and their prefix sums. */
export class ColumnAxis {
  #widths: number[] = [];
  /** `#xs[c]` is the left edge of column `c`; `#xs[n]` the total width. */
  #xs: number[] = [0];

  constructor(widths: readonly number[] = []) {
    this.widths = widths;
  }

  get count(): number {
    return this.#widths.length;
  }

  get widths(): readonly number[] {
    return this.#widths;
  }

  set widths(widths: readonly number[]) {
    this.#widths = widths.map((w) => Math.max(0, Math.round(w)));
    this.#xs = [0];
    for (const w of this.#widths) this.#xs.push(this.#xs[this.#xs.length - 1]! + w);
  }

  get totalWidth(): number {
    return this.#xs[this.#xs.length - 1]!;
  }

  left(column: number): number {
    return this.#xs[column]!;
  }

  width(column: number): number {
    return this.#widths[column]!;
  }

  /** The column at horizontal offset `x` (clamped). */
  at(x: number): number {
    const xs = this.#xs;
    const n = this.#widths.length;
    if (n === 0) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (xs[mid]! <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** The columns intersecting `[scrollLeft, scrollLeft + viewport)`, widened by `overscan`. */
  window(scrollLeft: number, viewport: number, overscan = 0): Span {
    const n = this.#widths.length;
    if (n === 0) return { start: 0, end: 0 };
    const start = Math.max(0, this.at(scrollLeft) - overscan);
    const last = this.at(Math.max(scrollLeft, scrollLeft + viewport - 1));
    return { start, end: Math.min(n, last + 1 + overscan) };
  }

  /** The scroll position that brings `column` into view, or `scrollLeft` when it already is. */
  reveal(column: number, scrollLeft: number, viewport: number): number {
    const left = this.#xs[column]!;
    const right = this.#xs[column + 1]!;
    if (left < scrollLeft) return left;
    if (right > scrollLeft + viewport) return Math.min(left, right - viewport);
    return scrollLeft;
  }
}
