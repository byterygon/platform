// The cell layer (Decision 17): plain `div`s with text, written directly into the DOM, recycled as
// the viewport moves. React renders the shell (scroller, header, sizer); this class owns the body
// rows, so no React state or element exists per cell. Each frame it computes the rows and columns
// in view, reuses the row elements that left the view for the rows that entered it, and only
// rewrites a cell whose (row, column) changed. Cell text comes from the column formats through a
// small LRU (`TextCache`).
import type { BatchIndex } from "./batch-index.ts";
import type { ColumnFormat } from "./cells.ts";
import { type CellText, TextCache } from "./text-cache.ts";
import { ColumnAxis, RowAxis, type Span } from "./virtualizer.ts";

/** A frame measured while the user scrolls (`onFrameSample`). */
export interface FrameSample {
  /** Time from the previous frame to this one, in ms: what the user sees as smoothness. */
  readonly duration: number;
  /** Time this frame spent updating the cell layer, in ms. */
  readonly work: number;
  /** Rows and columns rendered in the frame. */
  readonly rows: number;
  readonly columns: number;
  /** Rows held when the frame ran (it grows while the stream runs). */
  readonly rowCount: number;
}

/** The mark the benchmark reads (`performance.getEntriesByName`). */
export const FRAME_MEASURE = "dbee.grid.frame";

/** How long after the last scroll event frames are still sampled, in ms. */
const SCROLL_IDLE = 150;

export interface CellLayerOptions {
  readonly scroller: HTMLElement;
  readonly body: HTMLElement;
  readonly overscanRows?: number;
  readonly overscanColumns?: number;
  readonly onFrameSample?: (sample: FrameSample) => void;
  /** After each frame: the last row in view and how many rows fit the viewport (see ResultSource). */
  readonly onViewport?: (lastRow: number, screenRows: number) => void;
}

interface CellSlot {
  readonly el: HTMLDivElement;
  row: number;
  column: number;
  /** The text written, to skip unchanged writes. */
  text: CellText | undefined;
  left: number;
  width: number;
  /** The class written (alignment, NULL, selection), to skip unchanged writes. */
  cls: string;
}

interface RowSlot {
  readonly el: HTMLDivElement;
  readonly header: HTMLDivElement;
  row: number;
  offset: number;
  cells: CellSlot[];
  /** The column span the cells hold. */
  span: Span;
}

const ALIGN_CLASS = { start: "", end: " bdg-end", center: " bdg-center" } as const;

/** Decorations of a cell beyond its text (selection, the active cell); see `DataGrid`. */
export interface CellDecorator {
  /** Extra classes for (row, column), "" for none. */
  cellClass(row: number, column: number): string;
  /** Extra classes for a row, "" for none. */
  rowClass(row: number): string;
}

const NO_DECORATION: CellDecorator = { cellClass: () => "", rowClass: () => "" };

export class CellLayer {
  readonly rows: RowAxis;
  readonly columns = new ColumnAxis();
  readonly #scroller: HTMLElement;
  readonly #body: HTMLElement;
  readonly #overscanRows: number;
  readonly #overscanColumns: number;
  #onFrameSample: ((sample: FrameSample) => void) | undefined;
  readonly #onViewport: ((lastRow: number, screenRows: number) => void) | undefined;
  /** The active cell (roving focus target), or undefined. */
  #active: { row: number; column: number } | undefined;

  #index: BatchIndex | undefined;
  #formats: readonly ColumnFormat[] = [];
  #cache = new TextCache(4096);
  #decorator: CellDecorator = NO_DECORATION;

  /** Row slots in view, by global row. */
  #live = new Map<number, RowSlot>();
  #free: RowSlot[] = [];
  /** Width of the sticky row-number column, in px. */
  #rowHeaderWidth = 0;
  #headerHeight = 0;

  #frame = 0;
  #dirty = false;
  #lastFrameAt = 0;
  #lastScrollAt = -Infinity;
  #sampling = false;
  #disposed = false;

  constructor(options: CellLayerOptions) {
    this.#scroller = options.scroller;
    this.#body = options.body;
    this.#overscanRows = options.overscanRows ?? 4;
    this.#overscanColumns = options.overscanColumns ?? 1;
    this.#onFrameSample = options.onFrameSample;
    this.#onViewport = options.onViewport;
    this.rows = new RowAxis(32);
    this.#scroller.addEventListener("scroll", this.#onScroll, { passive: true });
  }

  set onFrameSample(f: ((sample: FrameSample) => void) | undefined) {
    this.#onFrameSample = f;
  }

  /** The data to show. A new index or new formats rewrite every cell. */
  setData(index: BatchIndex, formats: readonly ColumnFormat[]): void {
    if (index !== this.#index || formats !== this.#formats) {
      this.#index = index;
      this.#formats = formats;
      this.#cache = new TextCache(Math.max(1024, 64 * Math.max(1, formats.length) * 4));
      this.#invalidateCells();
    }
    this.rows.count = index.rowCount;
    this.schedule();
  }

  /** Rows were appended to the index: grow the scroll range without moving the rows in view. */
  rowsAdded(follow = false): void {
    const index = this.#index;
    if (index === undefined) return;
    const rows = this.rows;
    if (rows.count === index.rowCount) return;
    const scroller = this.#scroller;
    // "Follow" applies only when the user is already at the bottom.
    const atBottom = scroller.scrollTop >= rows.scrollHeight - rows.viewport - 1;
    // Keep the content at the top of the viewport where it is; with a scaled range the same
    // scrollTop would map to another row once the count changes.
    const virtualTop = rows.toVirtual(scroller.scrollTop);
    rows.count = index.rowCount;
    this.#applySize();
    if (follow && atBottom) scroller.scrollTop = rows.scrollHeight;
    else if (rows.scaled) scroller.scrollTop = rows.toScroll(virtualTop);
    this.schedule();
  }

  /**
   * `removed` rows left the front of the index (a live view's window, or Clear): every cell is
   * rewritten (rows are renumbered) and the rows in view stay in view, or the newest when
   * following at the bottom.
   */
  rowsDropped(removed: number, follow = false): void {
    const index = this.#index;
    if (index === undefined || removed <= 0) return;
    const rows = this.rows;
    const scroller = this.#scroller;
    const atBottom = scroller.scrollTop >= rows.scrollHeight - rows.viewport - 1;
    const virtualTop = rows.toVirtual(scroller.scrollTop);
    this.#cache.clear();
    this.#invalidateCells();
    rows.count = index.rowCount;
    this.#applySize();
    if (follow && atBottom) scroller.scrollTop = rows.scrollHeight;
    else scroller.scrollTop = rows.toScroll(Math.max(0, virtualTop - removed * rows.rowHeight));
    this.schedule();
  }

  /** The active cell: it gets tabindex 0 and, while the grid has focus, the focus. */
  setActive(active: { row: number; column: number } | undefined): void {
    this.#active = active;
    this.redecorate();
  }

  /** Scrolls so that (row, column) is fully in view (no smooth scrolling). */
  reveal(row: number, column: number): void {
    const scroller = this.#scroller;
    const top = this.rows.reveal(row, scroller.scrollTop);
    if (top !== scroller.scrollTop) scroller.scrollTop = top;
    const viewport = Math.max(0, scroller.clientWidth - this.#rowHeaderWidth);
    const left = this.columns.reveal(column, scroller.scrollLeft, viewport);
    if (left !== scroller.scrollLeft) scroller.scrollLeft = left;
    this.schedule();
  }

  /** Rows a Page Up / Page Down moves: the rows that fit the viewport, at least one. */
  get pageRows(): number {
    return Math.max(1, Math.floor(this.rows.viewport / this.rows.rowHeight) - 1);
  }

  setDecorator(decorator: CellDecorator | undefined): void {
    this.#decorator = decorator ?? NO_DECORATION;
    this.schedule();
  }

  /** Geometry: row height, sticky header height, row-number column width, column widths. */
  setGeometry(geometry: { rowHeight: number; headerHeight: number; rowHeaderWidth: number; widths: readonly number[] }): void {
    const heightChanged = geometry.rowHeight !== this.rows.rowHeight;
    const virtualTop = this.rows.toVirtual(this.#scroller.scrollTop);
    const topRow = virtualTop / this.rows.rowHeight;
    this.rows.rowHeight = geometry.rowHeight;
    this.#headerHeight = geometry.headerHeight;
    this.#rowHeaderWidth = geometry.rowHeaderWidth;
    this.columns.widths = geometry.widths;
    this.#measureViewport();
    this.#applySize();
    // A density change keeps the same top row in view.
    if (heightChanged) this.#scroller.scrollTop = this.rows.toScroll(topRow * this.rows.rowHeight);
    this.#invalidateGeometry();
    this.schedule();
  }

  /** The viewport changed size. */
  resized(): void {
    this.#measureViewport();
    this.schedule();
  }

  /** Every cell's decoration may have changed (selection). Text is kept. */
  redecorate(): void {
    for (const slot of this.#live.values()) {
      for (const cell of slot.cells) cell.cls = "\u0000";
      slot.el.dataset["cls"] = "\u0000";
    }
    this.schedule();
  }

  /** The cell element of (row, column) when it is rendered. */
  cellElement(row: number, column: number): HTMLElement | undefined {
    const slot = this.#live.get(row);
    if (slot === undefined) return undefined;
    for (const cell of slot.cells) if (cell.column === column && cell.row === row) return cell.el;
    return undefined;
  }

  /** The text of a cell as displayed (`null` for NULL), through the cache. */
  displayText(row: number, column: number): CellText {
    const index = this.#index!;
    const key = row * this.#formats.length + column;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    const b = index.locate(row);
    const data = index.batch(b).columns[column];
    const text = data === undefined ? null : this.#formats[column]!.display(data, row - index.start(b));
    this.#cache.set(key, text);
    return text;
  }

  /** Renders on the next animation frame (coalesced). */
  schedule(): void {
    this.#dirty = true;
    if (this.#frame !== 0 || this.#disposed) return;
    this.#frame = requestAnimationFrame(this.#onFrame);
  }

  /** Renders now (tests, and before focusing a cell that just scrolled into view). */
  flush(): void {
    if (this.#frame !== 0) {
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    }
    this.#render();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#frame !== 0) cancelAnimationFrame(this.#frame);
    this.#scroller.removeEventListener("scroll", this.#onScroll);
    this.#body.replaceChildren();
    this.#live.clear();
    this.#free = [];
  }

  readonly #onScroll = (): void => {
    this.#lastScrollAt = performance.now();
    if (!this.#sampling) {
      this.#sampling = true;
      this.#lastFrameAt = 0;
    }
    this.schedule();
  };

  readonly #onFrame = (now: number): void => {
    this.#frame = 0;
    const started = performance.now();
    const rendered = this.#dirty ? this.#render() : { rows: 0, columns: 0 };
    const work = performance.now() - started;
    if (this.#sampling) {
      if (this.#lastFrameAt > 0) {
        const duration = now - this.#lastFrameAt;
        try {
          performance.measure(FRAME_MEASURE, { start: this.#lastFrameAt, duration });
        } catch {
          // Without User Timing Level 3 (old engines) the sample still reaches onFrameSample.
        }
        this.#onFrameSample?.({ duration, work, rows: rendered.rows, columns: rendered.columns, rowCount: this.rows.count });
      }
      this.#lastFrameAt = now;
      // Keep sampling frames until the scrolling stops, so a slow frame is never skipped.
      if (now - this.#lastScrollAt < SCROLL_IDLE) this.#frame = requestAnimationFrame(this.#onFrame);
      else this.#sampling = false;
    }
  };

  #measureViewport(): void {
    this.rows.viewport = Math.max(0, this.#scroller.clientHeight - this.#headerHeight);
  }

  #applySize(): void {
    const sizer = this.#body.parentElement;
    if (sizer !== null) {
      sizer.style.height = `${this.#headerHeight + this.rows.scrollHeight}px`;
      sizer.style.width = `${this.#rowHeaderWidth + this.columns.totalWidth}px`;
    }
  }

  #invalidateCells(): void {
    for (const slot of this.#live.values()) {
      slot.row = -1;
      this.#free.push(slot);
    }
    this.#live.clear();
  }

  #invalidateGeometry(): void {
    for (const slot of this.#live.values()) {
      slot.offset = Number.NaN;
      slot.span = { start: 0, end: 0 };
      for (const cell of slot.cells) {
        cell.left = Number.NaN;
        cell.width = Number.NaN;
      }
      slot.el.style.width = `${this.#rowHeaderWidth + this.columns.totalWidth}px`;
      slot.el.style.height = `${this.rows.rowHeight}px`;
      slot.header.style.width = `${this.#rowHeaderWidth}px`;
    }
  }

  #newRow(): RowSlot {
    const el = document.createElement("div");
    el.setAttribute("role", "row");
    el.className = "bdg-row";
    const header = document.createElement("div");
    header.setAttribute("role", "rowheader");
    header.className = "bdg-rownum";
    el.append(header);
    this.#body.append(el);
    return { el, header, row: -1, offset: Number.NaN, cells: [], span: { start: 0, end: 0 } };
  }

  #render(): { rows: number; columns: number } {
    this.#dirty = false;
    const index = this.#index;
    if (index === undefined) return { rows: 0, columns: 0 };
    // Whether the grid holds the focus now: if the focused cell is recycled, focus must follow.
    const active = document.activeElement;
    const hadFocus = active !== null && this.#scroller.contains(active);
    const scrollTop = this.#scroller.scrollTop;
    const rows = this.rows;
    const rowSpan = rows.window(scrollTop, this.#overscanRows);
    const dataViewport = Math.max(0, this.#scroller.clientWidth - this.#rowHeaderWidth);
    const colSpan = this.columns.window(this.#scroller.scrollLeft, dataViewport, this.#overscanColumns);

    // Rows that left the view become free slots.
    for (const [row, slot] of this.#live) {
      if (row < rowSpan.start || row >= rowSpan.end) {
        this.#live.delete(row);
        slot.row = -1;
        this.#free.push(slot);
      }
    }
    const rowWidth = `${this.#rowHeaderWidth + this.columns.totalWidth}px`;
    const rowHeight = `${rows.rowHeight}px`;
    for (let row = rowSpan.start; row < rowSpan.end; row++) {
      let slot = this.#live.get(row);
      if (slot === undefined) {
        slot = this.#free.pop() ?? this.#newRow();
        if (slot.el.style.width !== rowWidth) slot.el.style.width = rowWidth;
        if (slot.el.style.height !== rowHeight) slot.el.style.height = rowHeight;
        slot.header.style.width = `${this.#rowHeaderWidth}px`;
        slot.row = row;
        slot.el.setAttribute("aria-rowindex", String(row + 2));
        slot.header.textContent = String(row + 1);
        slot.el.hidden = false;
        this.#live.set(row, slot);
        // Its cells belong to another row: rewrite them all.
        for (const cell of slot.cells) cell.row = -1;
      }
      const offset = this.#headerHeight + rows.offsetOf(row, scrollTop);
      if (offset !== slot.offset) {
        slot.offset = offset;
        slot.el.style.transform = `translateY(${offset}px)`;
      }
      const rowCls = `bdg-row${row % 2 === 1 ? " bdg-alt" : ""}${this.#decorator.rowClass(row)}`;
      if (slot.el.dataset["cls"] !== rowCls) {
        slot.el.dataset["cls"] = rowCls;
        slot.el.className = rowCls;
      }
      this.#renderCells(slot, row, colSpan);
    }
    // Slots not reused this frame are hidden, not removed: the next scroll takes them back.
    for (const slot of this.#free) if (!slot.el.hidden) slot.el.hidden = true;
    // Roving focus: the active cell is the tab stop when rendered, the grid element otherwise.
    const target = this.#active === undefined ? undefined : this.cellElement(this.#active.row, this.#active.column);
    const scrollerTab = target === undefined ? 0 : -1;
    if (this.#scroller.tabIndex !== scrollerTab) this.#scroller.tabIndex = scrollerTab;
    if (hadFocus) {
      const next = target ?? this.#scroller;
      if (document.activeElement !== next) next.focus({ preventScroll: true });
    }
    const visible = rows.window(scrollTop, 0);
    this.#onViewport?.(Math.max(0, visible.end - 1), Math.max(1, visible.end - visible.start));
    return { rows: rowSpan.end - rowSpan.start, columns: colSpan.end - colSpan.start };
  }

  #renderCells(slot: RowSlot, row: number, span: Span): void {
    const count = span.end - span.start;
    const cells = slot.cells;
    while (cells.length < count) {
      const el = document.createElement("div");
      el.setAttribute("role", "gridcell");
      el.tabIndex = -1;
      slot.el.append(el);
      cells.push({ el, row: -1, column: -1, text: undefined, left: Number.NaN, width: Number.NaN, cls: "" });
    }
    for (let k = count; k < cells.length; k++) {
      const cell = cells[k]!;
      if (!cell.el.hidden) {
        cell.el.hidden = true;
        cell.column = -1;
      }
    }
    const columns = this.columns;
    const decorator = this.#decorator;
    for (let k = 0; k < count; k++) {
      const column = span.start + k;
      const cell = cells[k]!;
      if (cell.el.hidden) cell.el.hidden = false;
      if (cell.row !== row || cell.column !== column) {
        if (cell.column !== column) cell.el.setAttribute("aria-colindex", String(column + 2));
        cell.row = row;
        cell.column = column;
        cell.el.dataset["row"] = String(row);
        cell.el.dataset["column"] = String(column);
        const text = this.displayText(row, column);
        if (text !== cell.text) {
          cell.text = text;
          cell.el.textContent = text === null ? "NULL" : text;
        }
        cell.cls = "\u0000";
      }
      const left = this.#rowHeaderWidth + columns.left(column);
      if (left !== cell.left) {
        cell.left = left;
        cell.el.style.left = `${left}px`;
      }
      const width = columns.width(column);
      if (width !== cell.width) {
        cell.width = width;
        cell.el.style.width = `${width}px`;
      }
      const isActive = this.#active !== undefined && this.#active.row === row && this.#active.column === column;
      const cls = `bdg-cell${ALIGN_CLASS[this.#formats[column]!.align]}${cell.text === null ? " bdg-null" : ""}${decorator.cellClass(row, column)}${isActive ? " bdg-active" : ""}`;
      if (cls !== cell.cls) {
        cell.cls = cls;
        cell.el.className = cls;
        cell.el.tabIndex = isActive ? 0 : -1;
        // Every cell is selectable, so every rendered cell states whether it is selected.
        cell.el.setAttribute("aria-selected", cls.includes(" bdg-selected") ? "true" : "false");
      }
    }
    slot.span = span;
  }
}
