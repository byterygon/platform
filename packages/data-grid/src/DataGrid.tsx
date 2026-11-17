// The DataGrid component (DBee spec §6). React renders the shell: the `role="grid"` scroller, the
// sticky header row, the sizer that gives the scroll range and a polite live region. The body
// rows and cells belong to `CellLayer` (renderer.ts), which writes them directly into the DOM, so
// scrolling never re-renders React and no React state exists per cell. Rows come from a
// `ResultSource` (result-source.ts): a stream pulled once under the memory budget, or fixed batches.
import type { ArrowBatch, ArrowField, ArrowStream } from "@byterygon/ambidex/arrow";
import { type KeyboardEvent, type PointerEvent, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { type ColumnFormat, columnFormat, TYPE_GLYPHS } from "./cells.ts";
import { type CopyFormat, serializeRange } from "./copy.ts";
import { CellLayer, type FrameSample } from "./renderer.ts";
import { DEFAULT_MEMORY_BUDGET, type ResultProgress, ResultSource, retain, sourceFor } from "./result-source.ts";
import {
  type CellPos,
  type CellRange,
  cellCount,
  contains,
  isMoveKey,
  moveSelection,
  moveTarget,
  rangeOf,
  type Selection,
  selectAll,
  selectColumns,
  selectRows,
  single,
} from "./selection.ts";
import { clampWidth, initialWidths, WIDTH_SAMPLE_ROWS, type WidthMetrics } from "./widths.ts";

/** What the selection covers, for the application's status line. */
export interface SelectionInfo {
  readonly active: CellPos;
  readonly range: CellRange;
  readonly cells: number;
  /** The active cell's full value, `null` for NULL ("" is the empty string). */
  readonly value: string | null;
}

/** Imperative access for the application (toolbar buttons, the copy menu, the benchmark). */
export interface DataGridHandle {
  /** Copies the selection (or the active cell) to the clipboard; resolves to the number of cells. */
  copy(format?: CopyFormat, headers?: boolean): Promise<number>;
  /** The selection's text without touching the clipboard. */
  selectionText(format?: CopyFormat, headers?: boolean): string;
  /** The full value of a cell, `null` for NULL, `undefined` when the row is not loaded. */
  cellValue(row: number, column: number): string | null | undefined;
  /** Moves the active cell and scrolls it into view. */
  scrollToCell(row: number, column: number): void;
  /** The scroll element, for a benchmark harness that drives scrolling (TSK-36). */
  readonly scroller: HTMLElement | null;
  /** Rows loaded and the stream's state. */
  readonly progress: ResultProgress;
  /** Cancels the stream; loaded rows stay. */
  cancel(): void;
  focus(): void;
}

export interface DataGridProps {
  /** A streamed result (decodeArrow). Its `batches()` is iterated once, by the grid. */
  readonly stream?: ArrowStream<unknown>;
  /** Or a complete result: the schema ... */
  readonly fields?: readonly ArrowField[];
  /** ... and its record batches, kept as given. */
  readonly batches?: readonly ArrowBatch[];
  /** Buffer bytes the grid holds before it pulls only near the loaded end (default 256 MiB). */
  readonly memoryBudget?: number;
  /** Keep the newest rows in view while streaming, when the user is at the bottom. */
  readonly follow?: boolean;
  /** The grid's accessible name (or `aria-labelledby`). */
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  /** Row height in px; by default `grid.row-height` of the current density. */
  readonly rowHeight?: number;
  /** Column widths in px (persisted by the application); by default from the types and the first 200 rows. */
  readonly columnWidths?: readonly number[];
  /** A column was resized (drag or Alt+Shift+Left/Right): the new widths to persist. */
  readonly onColumnWidthsChange?: (widths: readonly number[]) => void;
  /** Rows loaded and the stream's state, after each change (status line, "scroll for more"). */
  readonly onProgress?: (progress: ResultProgress) => void;
  /** The selection or the active cell changed. */
  readonly onSelectionChange?: (selection: SelectionInfo) => void;
  /** Enter or F2 (or a double click) on a cell: open the value viewer. */
  readonly onOpenCell?: (cell: CellPos) => void;
  /**
   * Ctrl+Shift+C: the application shows its menu (TSV, CSV, JSON) and calls `copy(format, true)`.
   * Without it, Ctrl+Shift+C copies TSV with headers.
   */
  readonly onCopyWithHeaders?: () => void;
  /** Frame durations while the user scrolls (also `performance.measure("dbee.grid.frame")`). */
  readonly onFrameSample?: (sample: FrameSample) => void;
  /** Extra classes on the grid's outer element. */
  readonly className?: string;
  readonly ref?: Ref<DataGridHandle>;
}

/** Used when the probe cannot measure (jsdom): a 12 px monospace face and 8 px padding. */
const FALLBACK_METRICS: Metrics = { charWidth: 7.25, padding: 16, rowHeight: 32 };

interface Metrics extends WidthMetrics {
  readonly rowHeight: number;
}

function measure(probe: HTMLElement): Metrics {
  const style = getComputedStyle(probe);
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const box = probe.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return FALLBACK_METRICS;
  return { charWidth: (box.width - padding) / 10, padding, rowHeight: Math.round(box.height) };
}

const sameMetrics = (a: Metrics, b: Metrics) => a.charWidth === b.charWidth && a.padding === b.padding && a.rowHeight === b.rowHeight;
const EMPTY_FIELDS: readonly ArrowField[] = [];

/** Width step of Alt+Shift+Left/Right, in characters of the cell font. */
const RESIZE_STEP_CHARS = 2;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function DataGrid(props: DataGridProps) {
  const { stream, fields: fieldsProp, batches: batchesProp, memoryBudget = DEFAULT_MEMORY_BUDGET, follow = false, rowHeight: rowHeightProp, columnWidths, className } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<CellLayer | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(FALLBACK_METRICS);
  const [announcement, setAnnouncement] = useState("");
  // Re-render when the source reports progress (at most once per frame).
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  // The latest props for handlers that live outside React's render (the source's listener).
  const propsRef = useRef(props);
  propsRef.current = props;

  const source = useMemo(
    () => (stream !== undefined ? sourceFor(stream) : ResultSource.fromBatches(fieldsProp ?? EMPTY_FIELDS, batchesProp ?? [])),
    [stream, fieldsProp, batchesProp],
  );
  const index = source.index;
  const fields = source.fields ?? EMPTY_FIELDS;
  const formats: readonly ColumnFormat[] = useMemo(() => fields.map(columnFormat), [fields]);
  const rowCount = index.rowCount;
  const state = source.state;

  useEffect(() => {
    source.budget = memoryBudget;
  }, [source, memoryBudget]);

  // A new result starts without a selection and with its own widths.
  useLayoutEffect(() => {
    selectionRef.current = undefined;
    rangeRef.current = undefined;
    setUserWidths(undefined);
    layerRef.current?.setActive(undefined);
  }, [source]);

  // Initial widths: from the first rows, refined until 200 rows are in (or the stream ends),
  // then fixed. A user resize (or `columnWidths`) wins.
  const [userWidths, setUserWidths] = useState<readonly number[] | undefined>(undefined);
  const sampleRows = Math.min(rowCount, WIDTH_SAMPLE_ROWS);
  const sampleKey = source.live && sampleRows < WIDTH_SAMPLE_ROWS ? sampleRows : WIDTH_SAMPLE_ROWS;
  const autoWidths = useMemo(() => initialWidths(fields, formats, index, metrics), [fields, formats, index, metrics, sampleKey]);
  const widths = columnWidths ?? userWidths ?? autoWidths;
  const rowHeight = rowHeightProp ?? metrics.rowHeight;
  const rowHeaderWidth = Math.ceil(Math.max(3, String(Math.max(1, rowCount)).length) * metrics.charWidth + metrics.padding);
  const left = useMemo(() => {
    const xs = [rowHeaderWidth];
    for (const w of widths) xs.push(xs[xs.length - 1]! + w);
    return xs;
  }, [widths, rowHeaderWidth]);

  // Selection lives in a ref (the cell layer reads it every frame) plus a version for React.
  const selectionRef = useRef<Selection | undefined>(undefined);
  /** The selection's rectangle for the rows held now (recomputed when either changes). */
  const rangeRef = useRef<CellRange | undefined>(undefined);
  const [selectionVersion, bumpSelection] = useReducer((n: number) => n + 1, 0);
  const rangeNow = useCallback(() => {
    const selection = selectionRef.current;
    return selection === undefined ? undefined : rangeOf(selection, index.rowCount, formats.length);
  }, [index, formats]);
  const rangeNowRef = useRef(rangeNow);
  rangeNowRef.current = rangeNow;

  // The cell layer lives as long as the component.
  useLayoutEffect(() => {
    const current = () => rangeRef.current;
    const layer = new CellLayer({
      scroller: scrollerRef.current!,
      body: bodyRef.current!,
      onViewport: (lastRow, screenRows) => source.setViewport(lastRow, screenRows),
    });
    layer.setDecorator({
      cellClass: (row, column) => {
        const range = current();
        return range !== undefined && contains(range, row, column) && cellCount(range) > 1 ? " bdg-selected" : "";
      },
      rowClass: (row) => {
        const selection = selectionRef.current;
        const range = current();
        return range !== undefined && (selection?.kind === "rows" || selection?.kind === "all") && row >= range.rowStart && row <= range.rowEnd ? " bdg-row-selected" : "";
      },
    });
    layerRef.current = layer;
    const probe = probeRef.current!;
    const remeasure = () => {
      const next = measure(probe);
      setMetrics((m) => (sameMetrics(m, next) ? m : next));
    };
    remeasure();
    // The probe's size follows grid.row-height and the font: a density or theme change re-measures.
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            remeasure();
            layer.resized();
          });
    observer?.observe(probe);
    observer?.observe(scrollerRef.current!);
    return () => {
      observer?.disconnect();
      layer.dispose();
      layerRef.current = null;
    };
  }, [source]);

  useLayoutEffect(() => {
    if (layerRef.current) layerRef.current.onFrameSample = props.onFrameSample;
  }, [props.onFrameSample]);

  useLayoutEffect(() => {
    const layer = layerRef.current!;
    layer.setGeometry({ rowHeight, headerHeight: rowHeight, rowHeaderWidth, widths });
    layer.setData(index, formats);
    layer.flush();
  }, [index, formats, widths, rowHeight, rowHeaderWidth]);

  // Stream progress: grow the cell layer at once, re-render React at most once per frame.
  useEffect(() => {
    let frame = 0;
    let lastState = source.state;
    const onChange = () => {
      const layer = layerRef.current;
      layer?.rowsAdded(propsRef.current.follow ?? false);
      // Whole columns and "all" grow with the rows.
      const kind = selectionRef.current?.kind;
      if (kind === "columns" || kind === "all") {
        rangeRef.current = rangeNowRef.current();
        layer?.redecorate();
      }
      if (source.state !== lastState) {
        lastState = source.state;
        const rows = source.index.rowCount;
        if (source.state === "done") setAnnouncement(`${plural(rows, "row")} loaded`);
        else if (source.state === "cancelled") setAnnouncement(`Cancelled, ${plural(rows, "row")} kept`);
        else if (source.state === "error") setAnnouncement(`The result stopped with an error after ${plural(rows, "row")}`);
        else if (source.state === "paused") setAnnouncement(`Loaded ${plural(rows, "row")}, scroll for more`);
      }
      propsRef.current.onProgress?.(source.progress);
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          refresh();
        });
      }
    };
    const release = stream !== undefined ? retain(source, onChange) : source.subscribe(onChange);
    propsRef.current.onProgress?.(source.progress);
    refresh();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      release();
    };
  }, [source, stream]);

  // Selection changes: redecorate, move the roving focus, report.
  const report = useCallback(() => {
    const selection = selectionRef.current;
    const layer = layerRef.current;
    rangeRef.current = selection === undefined ? undefined : rangeOf(selection, index.rowCount, formats.length);
    layer?.setActive(selection?.active);
    if (selection === undefined) return;
    const range = rangeRef.current!;
    const cell = index.cell(selection.active.row, selection.active.column);
    const value = cell === undefined ? null : formats[selection.active.column]!.value(cell.data, cell.row);
    propsRef.current.onSelectionChange?.({ active: selection.active, range, cells: cellCount(range), value });
  }, [index, formats]);

  const select = useCallback(
    (next: Selection, reveal = true) => {
      selectionRef.current = next;
      const layer = layerRef.current;
      if (reveal && layer) layer.reveal(next.active.row, next.active.column);
      report();
      layer?.flush();
      bumpSelection();
    },
    [report],
  );

  const copy = useCallback(
    async (format: CopyFormat = "tsv", headers = false): Promise<number> => {
      const range = rangeNow();
      if (range === undefined || index.rowCount === 0) return 0;
      const text = serializeRange(index, fields, formats, range, format, headers);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        setAnnouncement("Could not copy to the clipboard");
        return 0;
      }
      const rows = Math.min(range.rowEnd, index.rowCount - 1) - range.rowStart + 1;
      const cells = rows * (range.columnEnd - range.columnStart + 1);
      setAnnouncement(`Copied ${plural(cells, "cell")}${headers ? " with headers" : ""}`);
      return cells;
    },
    [rangeNow, index, fields, formats],
  );

  const resizeColumn = useCallback(
    (column: number, width: number, commit: boolean) => {
      const next = widths.slice();
      next[column] = clampWidth(width);
      setUserWidths(next);
      if (commit) propsRef.current.onColumnWidthsChange?.(next);
    },
    [widths],
  );

  useImperativeHandle(
    props.ref,
    () => ({
      copy,
      selectionText: (format = "tsv", headers = false) => {
        const range = rangeNow();
        return range === undefined ? "" : serializeRange(index, fields, formats, range, format, headers);
      },
      cellValue: (row, column) => {
        const cell = index.cell(row, column);
        return cell === undefined ? undefined : formats[column]!.value(cell.data, cell.row);
      },
      scrollToCell: (row, column) => select(single({ row, column })),
      get scroller() {
        return scrollerRef.current;
      },
      get progress() {
        return source.progress;
      },
      cancel: () => source.cancel(),
      focus: () => {
        if (selectionRef.current === undefined && index.rowCount > 0 && formats.length > 0) select(single({ row: 0, column: 0 }));
        const active = selectionRef.current?.active;
        const cell = active === undefined ? undefined : layerRef.current?.cellElement(active.row, active.column);
        (cell ?? scrollerRef.current)?.focus();
      },
    }),
    [copy, rangeNow, index, fields, formats, select, source],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;
    const columnCount = formats.length;
    if (index.rowCount === 0 || columnCount === 0) return;
    const selection = selectionRef.current ?? single({ row: 0, column: 0 });
    if (e.altKey && e.shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) {
      const column = selection.active.column;
      const step = Math.round(RESIZE_STEP_CHARS * metrics.charWidth);
      resizeColumn(column, widths[column]! + (key === "ArrowRight" ? step : -step), true);
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (isMoveKey(key)) {
      const target = moveTarget(selection.active, key, ctrl, { rowCount: index.rowCount, columnCount, pageRows: layerRef.current?.pageRows ?? 1 });
      select(moveSelection(selection, target, e.shiftKey));
    } else if (ctrl && key.toLowerCase() === "a") {
      select(selectAll(selectionRef.current), false);
    } else if (ctrl && key.toLowerCase() === "c") {
      if (selectionRef.current === undefined) select(selection, false);
      if (e.shiftKey && propsRef.current.onCopyWithHeaders) propsRef.current.onCopyWithHeaders();
      else void copy("tsv", e.shiftKey);
    } else if ((key === "Enter" || key === "F2") && !ctrl && !e.shiftKey) {
      if (selectionRef.current === undefined) select(selection, false);
      propsRef.current.onOpenCell?.(selection.active);
    } else if (key === "Escape" && selectionRef.current !== undefined && cellCount(rangeOf(selectionRef.current, index.rowCount, columnCount)) > 1) {
      select(single(selectionRef.current.active), false);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    // Tabbing into the grid lands on the scroller when the active cell is not rendered (or none
    // exists): bring the active cell into view and focus it.
    if (e.target !== scrollerRef.current || index.rowCount === 0 || formats.length === 0) return;
    const selection = selectionRef.current ?? single({ row: 0, column: 0 });
    select(selection);
  };

  const cellFromEvent = (target: EventTarget | null): { row: number; column?: number } | undefined => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>(".bdg-cell, .bdg-rownum");
    if (!el) return undefined;
    if (el.classList.contains("bdg-rownum")) {
      const row = Number(el.parentElement?.getAttribute("aria-rowindex")) - 2;
      return Number.isFinite(row) && row >= 0 ? { row } : undefined;
    }
    const row = Number(el.dataset["row"]);
    const column = Number(el.dataset["column"]);
    return Number.isFinite(row) && Number.isFinite(column) ? { row, column } : undefined;
  };

  const onBodyPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const hit = cellFromEvent(e.target);
    if (hit === undefined) return;
    const current = selectionRef.current;
    if (hit.column === undefined) select(selectRows(current, hit.row, e.shiftKey && current !== undefined), false);
    else if (e.shiftKey && current !== undefined) select(moveSelection(current, { row: hit.row, column: hit.column }, true), false);
    else select(single({ row: hit.row, column: hit.column }), false);
  };

  const onBodyDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const hit = cellFromEvent(e.target);
    if (hit?.column !== undefined) propsRef.current.onOpenCell?.({ row: hit.row, column: hit.column });
  };

  const onHeaderClick = (column: number, shift: boolean) => {
    if (index.rowCount === 0) return;
    const current = selectionRef.current;
    select(selectColumns(current, column, shift && current !== undefined), false);
    const layer = layerRef.current;
    const active = selectionRef.current?.active;
    if (active) layer?.cellElement(active.row, active.column)?.focus({ preventScroll: true });
  };

  const onResizeStart = (column: number, e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startWidth = widths[column]!;
    let last = startWidth;
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => {
      last = startWidth + (ev.clientX - startX);
      resizeColumn(column, last, false);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      resizeColumn(column, last, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const selection = selectionRef.current;
  const selectedColumns =
    selection !== undefined && (selection.kind === "columns" || selection.kind === "all") ? rangeOf(selection, rowCount, formats.length) : undefined;
  void selectionVersion;
  const totalWidth = left[left.length - 1]!;
  const complete = !source.live;
  return (
    <div className={className ? `bdg ${className}` : "bdg"} data-slot="data-grid" data-state={state}>
      <div ref={probeRef} className="bdg-probe" aria-hidden="true">
        0000000000
      </div>
      {/* The scroller is the grid: one tab stop (roving), and its rows are its own. */}
      <div
        ref={scrollerRef}
        role="grid"
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-rowcount={complete ? rowCount + 1 : -1}
        aria-colcount={fields.length + 1}
        aria-multiselectable="true"
        aria-busy={source.state === "schema" ? true : undefined}
        className="bdg-scroller"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        <div className="bdg-sizer">
          <div role="rowgroup" className="bdg-head">
            <div role="row" aria-rowindex={1} className="bdg-header-row" style={{ width: totalWidth, height: rowHeight }}>
              <div role="columnheader" aria-colindex={1} className="bdg-corner" style={{ width: rowHeaderWidth }}>
                <span className="bdg-sr-only">Row</span>
                <span aria-hidden="true">#</span>
              </div>
              {fields.map((field, c) => {
                const format = formats[c]!;
                const selected = selectedColumns !== undefined && c >= selectedColumns.columnStart && c <= selectedColumns.columnEnd;
                return (
                  <div
                    key={c}
                    role="columnheader"
                    aria-colindex={c + 2}
                    aria-description={format.label}
                    aria-selected={selected ? true : undefined}
                    className={`bdg-columnheader${format.align === "end" ? " bdg-end" : ""}${selected ? " bdg-selected" : ""}`}
                    style={{ left: left[c], width: widths[c] }}
                    title={`${field.name}: ${format.label}`}
                    onClick={(e) => onHeaderClick(c, e.shiftKey)}
                  >
                    <span className="bdg-glyph" data-family={format.family} aria-hidden="true">
                      {TYPE_GLYPHS[format.family]}
                    </span>
                    <span className="bdg-name">{field.name}</span>
                    <span className="bdg-type" aria-hidden="true">
                      {format.label}
                    </span>
                    <div className="bdg-resize" aria-hidden="true" onPointerDown={(e) => onResizeStart(c, e)} onClick={(e) => e.stopPropagation()} />
                  </div>
                );
              })}
            </div>
          </div>
          <div ref={bodyRef} role="rowgroup" className="bdg-body" onPointerDown={onBodyPointerDown} onDoubleClick={onBodyDoubleClick} />
        </div>
      </div>
      <div className="bdg-sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
