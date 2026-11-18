import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { tokenPx } from "@/lib/theme-scope";

// Bytes as a hex dump (Mightyconsole spec section 12, TSK-80): an offset column, the bytes in
// hex and the same bytes as ASCII, a row per `bytesPerRow` bytes. Virtualized like JsonViewer:
// rows of size.control.xs, only those in view are rendered, so a 16 MiB payload stays fast. It is
// the ARIA grid pattern with one tab stop and aria-activedescendant: arrows move the active byte,
// Shift extends the selection, Ctrl+C copies it as hex and Ctrl+Shift+C as text (the footer's
// buttons do the same). Base UI has no part for it, so it is plain elements.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const hexViewVariants = {} as const;

const classes = {
  root: "flex w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-editor font-mono text-code-sm text-editor-fg",
  scroller: ["relative min-h-0 flex-1 overflow-auto overscroll-contain", focusRing],
  row: "absolute inset-x-0 flex h-control-xs items-center gap-inline-md px-inset-sm whitespace-pre",
  offset: "shrink-0 text-editor-gutter tabular-nums",
  bytes: "shrink-0",
  byte: [
    "cursor-default tabular-nums",
    "hover:bg-hover data-selected:bg-editor-selection",
    "in-focus-visible:data-active:outline-solid in-focus-visible:data-active:outline-[length:var(--by-ring-width)] in-focus-visible:data-active:-outline-offset-[var(--by-ring-width)] in-focus-visible:data-active:outline-ring",
  ],
  ascii: "shrink-0 text-syntax-string",
  asciiChar: "data-selected:bg-editor-selection data-dot:text-editor-gutter",
  footer: "flex shrink-0 items-center gap-inline-sm border-t border-border-subtle px-inset-sm py-inset-xs font-sans text-caption-1 text-fg-muted",
  footerText: "min-w-0 flex-1 truncate",
  empty: "p-inset-sm font-sans text-body-1 text-fg-muted",
} as const;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const printable = (b: number) => b >= 0x20 && b < 0x7f;

/** The bytes as hex text, `00 1a ff`. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += (i ? " " : "") + HEX[bytes[i]!];
  return out;
}

/** The bytes as text: UTF-8 when they decode as UTF-8, else Latin-1 with `.` for non-printables. */
export function bytesToText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let out = "";
    for (const b of bytes) out += printable(b) ? String.fromCharCode(b) : ".";
    return out;
  }
}

export type HexCopyFormat = "hex" | "text";

export interface HexViewProps {
  /** The bytes to show (an array of numbers 0 to 255 is taken too). */
  bytes?: Uint8Array | readonly number[] | undefined;
  /** Bytes per row; 16 by default, grouped by 8. */
  bytesPerRow?: number | undefined;
  /** The offset of the first byte, for the offset column (a slice of a larger payload). */
  baseOffset?: number | undefined;
  /** Called after a copy, with the text and its format. */
  onCopy?: ((text: string, format: HexCopyFormat) => void) | undefined;
  /** Accessible name of the grid. */
  "aria-label"?: string | undefined;
  /** Rows rendered beyond the viewport on each side. */
  overscan?: number | undefined;
  /** Extra classes, merged after the component's own so they win; set the height here. */
  className?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
}

const EMPTY = new Uint8Array();

/** Bytes as a virtualized, keyboard-navigable hex dump with selection and copy (role="grid"). */
export function HexView({ bytes: bytesProp = EMPTY, bytesPerRow = 16, baseOffset = 0, onCopy, "aria-label": label = "Bytes", overscan = 8, className, ref }: HexViewProps) {
  const bytes = useMemo(() => (bytesProp instanceof Uint8Array ? bytesProp : Uint8Array.from(bytesProp)), [bytesProp]);
  const perRow = Math.max(1, Math.floor(bytesPerRow));
  const rowCount = Math.ceil(bytes.length / perRow);
  const offsetDigits = Math.max(8, (baseOffset + bytes.length).toString(16).length);
  const [anchor, setAnchor] = useState(0);
  const [focus, setFocus] = useState(0);
  // A new payload starts with the first byte active.
  useEffect(() => {
    setAnchor(0);
    setFocus(0);
  }, [bytes]);
  const lo = Math.min(anchor, focus);
  const hi = Math.max(anchor, focus);

  const baseId = useId();
  const idFor = useCallback((index: number) => `${baseId}-b${index}`, [baseId]);

  const scroller = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scrollTop: 0, viewport: 0, rowHeight: 20 });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const measure = () =>
      setView((previous) => {
        const next = { scrollTop: element.scrollTop, viewport: element.clientHeight, rowHeight: tokenPx(element, "--by-size-control-xs", previous.rowHeight) };
        return next.scrollTop === previous.scrollTop && next.viewport === previous.viewport && next.rowHeight === previous.rowHeight ? previous : next;
      });
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);
  const { rowHeight } = view;
  const height = view.viewport || rowHeight * 24;
  const first = Math.max(0, Math.floor(view.scrollTop / rowHeight) - overscan);
  const last = Math.min(rowCount, Math.ceil((view.scrollTop + height) / rowHeight) + overscan);

  const reveal = useCallback(
    (index: number) => {
      const element = scroller.current;
      if (!element) return;
      const top = Math.floor(index / perRow) * rowHeight;
      const visible = element.clientHeight || height;
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + rowHeight > element.scrollTop + visible) element.scrollTop = top + rowHeight - visible;
      setView((previous) => ({ ...previous, scrollTop: element.scrollTop }));
    },
    [perRow, rowHeight, height],
  );

  const select = useCallback(
    (index: number, extend: boolean) => {
      const at = Math.max(0, Math.min(bytes.length - 1, index));
      setFocus(at);
      if (!extend) setAnchor(at);
      reveal(at);
    },
    [bytes.length, reveal],
  );

  const copy = useCallback(
    (format: HexCopyFormat) => {
      const slice = bytes.subarray(lo, hi + 1);
      const text = format === "hex" ? bytesToHex(slice) : bytesToText(slice);
      void globalThis.navigator?.clipboard?.writeText(text).catch(() => undefined);
      onCopy?.(text, format);
    },
    [bytes, lo, hi, onCopy],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (bytes.length === 0) return;
    const mod = event.ctrlKey || event.metaKey;
    const pageRows = Math.max(1, Math.floor((scroller.current?.clientHeight || height) / rowHeight) - 1);
    const moves: Record<string, number | undefined> = {
      ArrowRight: focus + 1,
      ArrowLeft: focus - 1,
      ArrowDown: focus + perRow,
      ArrowUp: focus - perRow,
      PageDown: focus + perRow * pageRows,
      PageUp: focus - perRow * pageRows,
      Home: mod ? 0 : focus - (focus % perRow),
      End: mod ? bytes.length - 1 : focus - (focus % perRow) + perRow - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      select(moves[event.key]!, event.shiftKey);
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setAnchor(0);
      setFocus(bytes.length - 1);
      return;
    }
    if (mod && event.key.toLowerCase() === "c") {
      event.preventDefault();
      copy(event.shiftKey ? "text" : "hex");
      return;
    }
    if (event.key === "Escape" && anchor !== focus) {
      event.preventDefault();
      setAnchor(focus);
    }
  };

  const rows = [];
  const activeRow = Math.floor(focus / perRow);
  const indexes = new Set<number>();
  for (let r = first; r < last; r += 1) indexes.add(r);
  if (rowCount > 0) indexes.add(activeRow); // the active byte is always in the DOM for aria-activedescendant
  for (const r of [...indexes].sort((a, b) => a - b)) {
    const start = r * perRow;
    const end = Math.min(bytes.length, start + perRow);
    const cells = [];
    const ascii = [];
    for (let i = start; i < start + perRow; i += 1) {
      // The font is monospace: spaces keep the columns (two between groups of 8).
      if (i > start) cells.push(i % 8 === 0 ? "  " : " ");
      if (i >= end) {
        cells.push("  ");
        continue;
      }
      const b = bytes[i]!;
      const selected = i >= lo && i <= hi;
      cells.push(
        <span
          key={i}
          id={idFor(i)}
          role="gridcell"
          aria-selected={selected}
          aria-label={`${(baseOffset + i).toString(16)}: ${HEX[b]}`}
          data-slot="hex-view-byte"
          data-selected={selected ? "" : undefined}
          data-active={i === focus ? "" : undefined}
          onPointerDown={(event) => {
            event.preventDefault();
            scroller.current?.focus();
            select(i, event.shiftKey);
          }}
          className={cn(classes.byte)}
        >
          {HEX[b]}
        </span>,
      );
      ascii.push(
        <span key={i} data-selected={selected ? "" : undefined} data-dot={printable(b) ? undefined : ""} className={classes.asciiChar}>
          {printable(b) ? String.fromCharCode(b) : "."}
        </span>,
      );
    }
    rows.push(
      <div key={r} role="row" aria-rowindex={r + 1} data-slot="hex-view-row" className={classes.row} style={{ top: r * rowHeight }}>
        <span role="rowheader" className={classes.offset}>
          {(baseOffset + start).toString(16).padStart(offsetDigits, "0")}
        </span>
        <span className={classes.bytes}>{cells}</span>
        <span role="gridcell" aria-label={`text: ${bytesToText(bytes.subarray(start, end))}`} className={classes.ascii}>
          {ascii}
        </span>
      </div>,
    );
  }

  const count = bytes.length;
  const selection = hi - lo + 1;
  return (
    <div data-slot="hex-view" ref={ref} className={cn(classes.root, className)}>
      {count === 0 ? (
        <p className={classes.empty}>No bytes</p>
      ) : (
        <div
          ref={scroller}
          role="grid"
          tabIndex={0}
          aria-label={label}
          aria-readonly
          aria-multiselectable
          aria-rowcount={rowCount}
          aria-colcount={perRow + 2}
          aria-activedescendant={idFor(focus)}
          data-slot="hex-view-grid"
          onKeyDown={onKeyDown}
          className={cn(classes.scroller)}
        >
          <div style={{ height: rowCount * rowHeight, position: "relative" }}>{rows}</div>
        </div>
      )}
      <div data-slot="hex-view-footer" className={classes.footer}>
        <span className={classes.footerText} aria-live="polite">
          {count === 0
            ? "0 bytes"
            : selection > 1
              ? `${selection} of ${count} bytes selected, from 0x${(baseOffset + lo).toString(16)}`
              : `${count} ${count === 1 ? "byte" : "bytes"}, at 0x${(baseOffset + focus).toString(16)}`}
        </span>
        <Button appearance="subtle" size="small" disabled={count === 0} onClick={() => copy("hex")}>
          Copy hex
        </Button>
        <Button appearance="subtle" size="small" disabled={count === 0} onClick={() => copy("text")}>
          Copy text
        </Button>
      </div>
    </div>
  );
}
