// The DataGrid component (DBee spec §6). React renders the shell: the `role="grid"` element, the
// scroller, the sticky header row and the sizer that gives the scroll range. The body rows and
// cells belong to `CellLayer` (renderer.ts), which writes them directly into the DOM, so scrolling
// never re-renders React and no React state exists per cell.
import type { ArrowBatch, ArrowField } from "@byterygon/ambidex/arrow";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { BatchIndex } from "./batch-index.ts";
import { type ColumnFormat, columnFormat, TYPE_GLYPHS } from "./cells.ts";
import { CellLayer, type FrameSample } from "./renderer.ts";
import { initialWidths, type WidthMetrics } from "./widths.ts";

export interface DataGridProps {
  /** The result's schema. */
  readonly fields: readonly ArrowField[];
  /** The record batches, in order. */
  readonly batches: readonly ArrowBatch[];
  /** The grid's accessible name (or `aria-labelledby`). */
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
  /** Row height in px; by default `grid.row-height` of the current density. */
  readonly rowHeight?: number;
  /** Column widths in px; by default from the types and the first 200 rows. */
  readonly columnWidths?: readonly number[];
  /** Frame durations while the user scrolls (also marked as `performance.measure("dbee.grid.frame")`). */
  readonly onFrameSample?: (sample: FrameSample) => void;
  /** Extra classes on the grid element. */
  readonly className?: string;
}

/** Used when the probe cannot measure (jsdom): a 12 px monospace face and 8 px padding. */
const FALLBACK_METRICS: WidthMetrics & { rowHeight: number } = { charWidth: 7.25, padding: 16, rowHeight: 32 };

interface Metrics extends WidthMetrics {
  readonly rowHeight: number;
}

function measure(probe: HTMLElement): Metrics {
  const style = getComputedStyle(probe);
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const width = probe.getBoundingClientRect().width;
  const height = probe.getBoundingClientRect().height;
  if (!(width > 0) || !(height > 0)) return FALLBACK_METRICS;
  return { charWidth: (width - padding) / 10, padding, rowHeight: Math.round(height) };
}

const sameMetrics = (a: Metrics, b: Metrics) => a.charWidth === b.charWidth && a.padding === b.padding && a.rowHeight === b.rowHeight;

export function DataGrid(props: DataGridProps) {
  const { fields, batches, rowHeight: rowHeightProp, columnWidths, onFrameSample, className } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<CellLayer | null>(null);
  const [metrics, setMetrics] = useState<Metrics>(FALLBACK_METRICS);

  const formats: readonly ColumnFormat[] = useMemo(() => fields.map(columnFormat), [fields]);
  const index = useMemo(() => {
    const index = new BatchIndex();
    for (const batch of batches) index.append(batch);
    return index;
  }, [batches]);

  const widths = useMemo(() => columnWidths ?? initialWidths(fields, formats, index, metrics), [columnWidths, fields, formats, index, metrics]);
  const rowHeight = rowHeightProp ?? metrics.rowHeight;
  const rowHeaderWidth = Math.ceil(Math.max(3, String(Math.max(1, index.rowCount)).length) * metrics.charWidth + metrics.padding);
  const left = useMemo(() => {
    const xs = [rowHeaderWidth];
    for (const w of widths) xs.push(xs[xs.length - 1]! + w);
    return xs;
  }, [widths, rowHeaderWidth]);

  // The cell layer lives as long as the component.
  useLayoutEffect(() => {
    const layer = new CellLayer({ scroller: scrollerRef.current!, body: bodyRef.current! });
    layerRef.current = layer;
    const probe = probeRef.current!;
    const remeasure = () => {
      const next = measure(probe);
      setMetrics((current) => (sameMetrics(current, next) ? current : next));
    };
    remeasure();
    // The probe's size follows grid.row-height and the font: a density or theme change re-measures.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
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
  }, []);

  useLayoutEffect(() => {
    if (layerRef.current) layerRef.current.onFrameSample = onFrameSample;
  }, [onFrameSample]);

  useLayoutEffect(() => {
    const layer = layerRef.current!;
    layer.setGeometry({ rowHeight, headerHeight: rowHeight, rowHeaderWidth, widths });
    layer.setData(index, formats);
    layer.flush();
  }, [index, formats, widths, rowHeight, rowHeaderWidth]);

  const totalWidth = left[left.length - 1]!;
  return (
    <div className={className ? `bdg ${className}` : "bdg"} data-slot="data-grid">
      <div ref={probeRef} className="bdg-probe" aria-hidden="true">
        0000000000
      </div>
      {/* The scroller is the grid: one tab stop, and its rows are its own (rowgroups in the sizer). */}
      <div
        ref={scrollerRef}
        role="grid"
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-rowcount={index.rowCount + 1}
        aria-colcount={fields.length + 1}
        className="bdg-scroller"
        tabIndex={0}
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
                return (
                  <div
                    key={c}
                    role="columnheader"
                    aria-colindex={c + 2}
                    aria-description={format.label}
                    className={format.align === "end" ? "bdg-columnheader bdg-end" : "bdg-columnheader"}
                    style={{ left: left[c], width: widths[c] }}
                    title={`${field.name}: ${format.label}`}
                  >
                    <span className="bdg-glyph" data-family={format.family} aria-hidden="true">
                      {TYPE_GLYPHS[format.family]}
                    </span>
                    <span className="bdg-name">{field.name}</span>
                    <span className="bdg-type" aria-hidden="true">
                      {format.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div ref={bodyRef} role="rowgroup" className="bdg-body" />
        </div>
      </div>
    </div>
  );
}
