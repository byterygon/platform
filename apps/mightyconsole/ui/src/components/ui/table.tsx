import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { focusRing, focusRingInset } from "@/lib/control";
import { ArrowSort, ArrowSortDown, ArrowSortUp } from "@/lib/icons";
import { tokenPx } from "@/lib/theme-scope";

// A plain, semantic data table (<table>, <thead>, <th scope="col">…) as Fluent 2's Table (TSK-90):
// no shell of its own, so it sits on the layer or card around it; rows of table.row-height-* by
// `size` (medium 44, small 34, extra-small 24 px; compact density a step lower), cells padded by
// table.cell-padding-x, a header in the regular body weight, a color.border.default divider under
// every row, the interactive washes for hover, press and selection, and the double ring inside a
// focused row. The header sticks while the table scrolls and takes a surface fill only then.
// `appearance="surface"` brings back the earlier card (border, layer, shadow, a filled header).
// NULL in grid.null-fg (TableNull), as DBee's DataGrid shows it. It is presentational: sorting is the app's (TableHead `sort` + `onSort`), and so are selection
// and data. Cells keep one line and truncate (`wrap` lets a cell wrap). For more than ~1,000 rows
// use TableVirtualBody, which renders only the rows in view between two spacer rows, keeps the
// semantic table, and sets aria-rowcount and aria-rowindex. Spacers are real heights, and browsers
// cap an element near 33.5 million px: about 760,000 rows at 44 px (1.4 million at 24 px). The
// Arrow-backed, cell-selectable, resizable DataGrid is a separate package; this is not it.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const tableVariants = {
  variant: {
    plain: "",
    striped: "[&_tbody>tr[data-odd]:not([data-selected])]:bg-grid-row-alt",
    bordered: "[&_td:not(:last-child)]:border-e [&_th:not(:last-child)]:border-e",
  },
  /** Fluent's Table has no shell (`transparent`, default); `surface` is the earlier card with a filled header. */
  appearance: {
    transparent: "",
    surface: "rounded-lg border border-border-subtle bg-layer shadow-layer [&_th]:bg-grid-header [&_th]:text-body-1-strong [&_th]:text-fg-muted [&_tfoot_td]:bg-grid-header",
  },
  /**
   * Fluent's body rows: medium 44, small 34, extra-small 24 px (12 px text, no dividers);
   * compact density a step lower. The header row is size.control.md (32 px) in every size, as Fluent's.
   */
  size: {
    medium: "[&_td]:h-table-row",
    small: "[&_td]:h-table-row-sm",
    "extra-small": "[&_td]:h-table-row-xs [&_td]:border-b-0 [&_th]:border-b-0 [&_td]:text-caption-1 [&_th]:text-caption-1",
  },
} as const;

export type TableSize = keyof typeof tableVariants.size;

/** The CSS variable of each size's row height, which TableVirtualBody reads. */
const ROW_HEIGHT_VAR: Record<TableSize, `--by-${string}`> = {
  medium: "--by-table-row-height-medium",
  small: "--by-table-row-height-small",
  "extra-small": "--by-table-row-height-extra-small",
};

const base = ["relative w-full min-w-0 overflow-auto overscroll-contain font-sans", focusRing];

const classes = {
  table: "w-full caption-bottom border-separate border-spacing-[var(--by-border-width-0)] text-body-1 text-fg",
  // A header row never takes the body rows' hover and press washes.
  header: "[&>tr]:hover:bg-transparent [&>tr]:active:bg-transparent",
  body: "",
  footer: "[&_td]:border-t [&_td]:border-b-0 [&_td]:text-body-1-strong",
  row: [
    "hover:bg-hover active:bg-pressed data-selected:bg-selected data-selected:hover:bg-selected-hover",
    focusRingInset,
  ],
  head: [
    "sticky top-0 z-[var(--by-z-sticky)] h-control-md whitespace-nowrap border-b border-border-subtle px-table-cell-x text-start align-middle text-body-1-strong text-fg",
    // Rows scroll under the sticky header: it takes a fill only while the table is scrolled.
    "in-data-scrolled:bg-surface",
    "data-[align=center]:text-center data-[align=end]:text-end",
  ],
  sortButton: [
    "-mx-inline-xs inline-flex max-w-full cursor-default items-center gap-inline-xs rounded-md px-inline-xs text-fg hover:bg-hover active:bg-pressed",
    "in-data-[align=end]:flex-row-reverse",
    focusRingInset,
    "[&_svg]:size-icon-xs [&_svg]:shrink-0",
  ],
  sortIcon: "text-fg-subtle in-[[aria-sort]]:text-fg",
  cell: [
    "max-w-panel-sm truncate whitespace-nowrap border-b border-border-subtle px-table-cell-x align-middle",
    "data-[align=center]:text-center data-[align=end]:text-end data-[align=end]:tabular-nums",
    "data-wrap:whitespace-normal data-wrap:wrap-break-word",
  ],
  caption: "px-table-cell-x py-inset-xs text-start text-caption-1 text-fg-muted",
  null: "italic text-grid-null",
} as const;

interface TableContextValue {
  container: RefObject<HTMLDivElement | null>;
  setRowCount: (count: number | undefined) => void;
  /** The CSS variable holding the row height of the table's size. */
  rowHeightVar: `--by-${string}`;
}

const TableContext = createContext<TableContextValue | null>(null);

export interface TableProps extends Omit<ComponentProps<"table">, "className" | "ref"> {
  /** plain, striped (alternate rows in grid.row-bg-alt) or bordered (vertical rules between columns). */
  variant?: keyof typeof tableVariants.variant;
  /** `transparent` (default, Fluent 2's Table: no border, fill or shadow; it sits on its layer) or `surface` (the earlier card). */
  appearance?: keyof typeof tableVariants.appearance | undefined;
  /** Row height, as Fluent's: `medium` (default, 44 px), `small` (34 px) or `extra-small` (24 px, 12 px text). */
  size?: TableSize | undefined;
  /** Extra classes on the scroll container (give it a height to scroll: h-panel-md), merged after the component's own. */
  className?: string;
  /** Extra classes on the `<table>`. */
  tableClassName?: string;
  /** Reaches the scroll container. */
  ref?: Ref<HTMLDivElement>;
}

/**
 * The table in a scroll container. A label (aria-label or aria-labelledby) names the table and
 * makes the container a focusable region, so keyboard users can scroll a tall or wide table.
 */
export function Table({ variant = "plain", appearance = "transparent", size = "medium", className, tableClassName, children, ref, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, ...props }: TableProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const [rowCount, setRowCount] = useState<number | undefined>(undefined);
  const labelled = ariaLabel !== undefined || ariaLabelledBy !== undefined;
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      container.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const rowHeightVar = ROW_HEIGHT_VAR[size];
  const context = useMemo(() => ({ container, setRowCount, rowHeightVar }), [rowHeightVar]);
  // data-scrolled while the table is scrolled down: the sticky header takes its fill. Written on
  // the element directly, so scrolling renders nothing.
  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const update = () => element.toggleAttribute("data-scrolled", element.scrollTop > 0);
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, []);
  return (
    <TableContext value={context}>
      <div
        ref={setRef}
        data-slot="table"
        data-variant={variant}
        data-appearance={appearance}
        data-size={size}
        role={labelled ? "region" : undefined}
        tabIndex={labelled ? 0 : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn(base, tableVariants.variant[variant], tableVariants.appearance[appearance], tableVariants.size[size], className)}
      >
        <table data-slot="table-element" aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} aria-rowcount={rowCount} className={cn(classes.table, tableClassName)} {...props}>
          {children}
        </table>
      </div>
    </TableContext>
  );
}

type SectionProps = Omit<ComponentProps<"tbody">, "className"> & { className?: string };

/** The `<thead>`; its TableHead cells stick to the top while the body scrolls. */
export function TableHeader({ className, ...props }: SectionProps) {
  return <thead data-slot="table-header" className={cn(classes.header, className)} {...props} />;
}

/** Marks every other row (data-odd) for the striped variant. */
function markOddRows(children: ReactNode, offset = 0): ReactNode {
  let index = offset;
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    const odd = index % 2 === 1;
    index += 1;
    return odd ? cloneElement(child as ReactElement<Record<string, unknown>>, { "data-odd": "" }) : child;
  });
}

/** The `<tbody>` for rows you render yourself (up to a thousand or so; beyond that use TableVirtualBody). */
export function TableBody({ className, children, ...props }: SectionProps) {
  return (
    <tbody data-slot="table-body" className={cn(classes.body, className)} {...props}>
      {markOddRows(children)}
    </tbody>
  );
}

/** The `<tfoot>`: totals or a summary row. */
export function TableFooter({ className, ...props }: SectionProps) {
  return <tfoot data-slot="table-footer" className={cn(classes.footer, className)} {...props} />;
}

export interface TableRowProps extends Omit<ComponentProps<"tr">, "className"> {
  /** Shows the row as selected (color.interactive.selected, Fluent's neutral selection) and sets aria-selected. */
  selected?: boolean;
  className?: string;
}

/** A `<tr>`: hover and press washes in the body; give it tabIndex to make it focusable (the ring is drawn inside). */
export function TableRow({ selected, className, ...props }: TableRowProps) {
  return <tr data-slot="table-row" data-selected={selected ? "" : undefined} aria-selected={selected} className={cn(classes.row, className)} {...props} />;
}

const SortIcon = ({ sort }: { sort: TableHeadProps["sort"] }) => <Icon icon={sort === "ascending" ? ArrowSortUp : sort === "descending" ? ArrowSortDown : ArrowSort} />;

export interface TableHeadProps extends Omit<ComponentProps<"th">, "className" | "align"> {
  /** Text alignment; `end` for numbers, matching their cells. */
  align?: "start" | "center" | "end";
  /** The column's current sort, shown by an icon and aria-sort; the app sorts the rows. */
  sort?: "ascending" | "descending" | "none";
  /** Makes the header a button that asks the app to sort by this column. */
  onSort?: (() => void) | undefined;
  className?: string;
}

/** A column header, `<th scope="col">`; with `onSort` its label is a button. */
export function TableHead({ align = "start", sort, onSort, scope = "col", className, children, ...props }: TableHeadProps) {
  const ariaSort = sort === "ascending" || sort === "descending" ? sort : undefined;
  return (
    <th data-slot="table-head" data-align={align} scope={scope} aria-sort={ariaSort} className={cn(classes.head, className)} {...props}>
      {onSort ? (
        <button type="button" data-slot="table-sort" onClick={onSort} className={cn(classes.sortButton)}>
          <span className="truncate">{children}</span>
          <span className={classes.sortIcon}>
            <SortIcon sort={sort} />
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export interface TableCellProps extends Omit<ComponentProps<"td">, "className" | "align"> {
  /** Text alignment; `end` for numbers (also tabular figures). */
  align?: "start" | "center" | "end";
  /** Lets the text wrap instead of truncating (not inside TableVirtualBody, whose rows have a fixed height). */
  wrap?: boolean;
  className?: string;
}

/** A data cell, `<td>`: one line that truncates with an ellipsis (put the full value in title). */
export function TableCell({ align = "start", wrap = false, className, ...props }: TableCellProps) {
  return <td data-slot="table-cell" data-align={align} data-wrap={wrap ? "" : undefined} className={cn(classes.cell, className)} {...props} />;
}

export type TableCaptionProps = Omit<ComponentProps<"caption">, "className"> & { className?: string };

/** The `<caption>`, under the table: what it lists ("12 columns of public.orders"). It names the table. */
export function TableCaption({ className, ...props }: TableCaptionProps) {
  return <caption data-slot="table-caption" className={cn(classes.caption, className)} {...props} />;
}

export type TableNullProps = Omit<ComponentProps<"span">, "className"> & { className?: string };

/** A SQL NULL, distinct from an empty string: "NULL" in italic grid.null-fg, as the DataGrid shows it. */
export function TableNull({ className, children = "NULL", ...props }: TableNullProps) {
  return (
    <span data-slot="table-null" className={cn(classes.null, className)} {...props}>
      {children}
    </span>
  );
}

export interface TableVirtualBodyProps {
  /** Number of rows. */
  count: number;
  /** Renders row `index` as a TableRow; it receives aria-rowindex and data-odd. */
  renderRow: (index: number) => ReactElement;
  /** Rows rendered above and below the visible ones. */
  overscan?: number;
  /** Header rows above the body, for aria-rowindex (1 by default). */
  headerRows?: number;
  className?: string;
  /** Reaches the `<tbody>`. */
  ref?: Ref<HTMLTableSectionElement>;
}

/**
 * A `<tbody>` that renders only the rows in view (plus `overscan`) inside a Table with a fixed
 * height. Rows are the table's row height (table.row-height-*), one line each; spacer rows keep the scroll height, so
 * the header still sticks and the table stays a table for assistive technology.
 */
export function TableVirtualBody({ count, renderRow, overscan = 10, headerRows = 1, className, ref }: TableVirtualBodyProps) {
  const context = useContext(TableContext);
  if (!context) throw new Error("TableVirtualBody must be inside a Table");
  const { container, setRowCount, rowHeightVar } = context;
  const body = useRef<HTMLTableSectionElement | null>(null);
  const [view, setView] = useState({ scrollTop: 0, viewport: 0, rowHeight: 44, bodyTop: 0 });

  useEffect(() => {
    setRowCount(count + headerRows);
    return () => setRowCount(undefined);
  }, [count, headerRows, setRowCount]);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setView((previous) => {
        const next = {
          scrollTop: element.scrollTop,
          viewport: element.clientHeight,
          rowHeight: tokenPx(element, rowHeightVar, previous.rowHeight),
          bodyTop: body.current?.offsetTop ?? 0,
        };
        return next.scrollTop === previous.scrollTop && next.viewport === previous.viewport && next.rowHeight === previous.rowHeight && next.bodyTop === previous.bodyTop ? previous : next;
      });
    };
    const schedule = () => {
      if (!frame) frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : (measure(), 0);
    };
    measure();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    };
  }, [container, rowHeightVar]);

  const { scrollTop, rowHeight, bodyTop } = view;
  // jsdom and a container not laid out yet report 0: render a screenful anyway.
  const viewport = view.viewport || rowHeight * 30;
  const first = Math.max(0, Math.min(count, Math.floor(Math.max(0, scrollTop - bodyTop) / rowHeight) - overscan));
  const last = Math.max(first, Math.min(count, Math.ceil((scrollTop - bodyTop + viewport) / rowHeight) + overscan));

  const rows: ReactNode[] = [];
  for (let index = first; index < last; index += 1) {
    const row = renderRow(index) as ReactElement<Record<string, unknown>>;
    rows.push(cloneElement(row, { key: row.key ?? index, "aria-rowindex": index + 1 + headerRows, "data-odd": index % 2 === 1 ? "" : undefined }));
  }

  const setRef = (node: HTMLTableSectionElement | null) => {
    body.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  return (
    <tbody ref={setRef} data-slot="table-virtual-body" data-first={first} data-last={last} className={cn(classes.body, className)}>
      <tr aria-hidden="true" data-spacer="">
        <td colSpan={1000} style={{ height: first * rowHeight, padding: 0, border: 0 }} />
      </tr>
      {rows}
      <tr aria-hidden="true" data-spacer="">
        <td colSpan={1000} style={{ height: (count - last) * rowHeight, padding: 0, border: 0 }} />
      </tr>
    </tbody>
  );
}
