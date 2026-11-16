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
import { Icon } from "@/components/icon/icon";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { ArrowSort, ArrowSortDown, ArrowSortUp } from "@/lib/icons";
import { tokenPx } from "@/lib/theme-scope";

// A plain, semantic data table (<table>, <thead>, <th scope="col">…) styled with the grid.* roles
// it shares with DBee's DataGrid (TSK-39), so a schema's column list and a query result look
// alike: grid.row-height rows (density-aware), grid.cell-padding-x, a sticky grid.header-bg
// header, grid.row-hover, grid.selection-bg for selected rows, NULL in grid.null-fg (TableNull).
// It is presentational: sorting is the app's (TableHead `sort` + `onSort`), and so are selection
// and data. Cells keep one line and truncate (`wrap` lets a cell wrap). For more than ~1,000 rows
// use TableVirtualBody, which renders only the rows in view between two spacer rows, keeps the
// semantic table, and sets aria-rowcount and aria-rowindex. Spacers are real heights, and browsers
// cap an element near 33.5 million px: about 900,000 rows at 36 px (1.5 million at 22 px). The
// Arrow-backed, cell-selectable, resizable DataGrid is a separate package; this is not it.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const tableVariants = {
  variant: {
    plain: "",
    striped: "[&_tbody>tr[data-odd]:not([data-selected])]:bg-grid-row-alt",
    bordered: "[&_td:not(:last-child)]:border-e [&_th:not(:last-child)]:border-e",
  },
} as const;

const base = [
  "relative w-full min-w-0 overflow-auto overscroll-contain rounded-lg border border-border-subtle bg-layer font-sans shadow-layer",
  focusRing,
];

const classes = {
  table: "w-full caption-bottom border-separate border-spacing-[var(--by-border-width-0)] text-body-1 text-fg",
  header: "",
  body: "",
  footer: "[&_td]:border-t [&_td]:border-b-0 [&_td]:bg-grid-header [&_td]:text-body-1-strong",
  row: "hover:bg-grid-row-hover data-selected:bg-grid-selection data-selected:hover:bg-grid-selection",
  head: [
    "sticky top-0 z-[var(--by-z-sticky)] h-grid-row whitespace-nowrap border-b border-grid-border bg-grid-header px-grid-cell-x text-start align-middle text-body-1-strong text-fg-muted",
    "data-[align=center]:text-center data-[align=end]:text-end",
  ],
  sortButton: [
    "-mx-inline-xs inline-flex max-w-full cursor-default items-center gap-inline-xs rounded-md px-inline-xs text-body-1-strong text-fg-muted hover:text-fg",
    "in-data-[align=end]:flex-row-reverse",
    focusRing,
    "[&_svg]:size-icon-xs [&_svg]:shrink-0",
  ],
  sortIcon: "text-fg-subtle in-[[aria-sort]]:text-fg",
  cell: [
    "h-grid-row max-w-panel-sm truncate whitespace-nowrap border-b border-grid-border px-grid-cell-x align-middle",
    "data-[align=center]:text-center data-[align=end]:text-end data-[align=end]:tabular-nums",
    "data-wrap:whitespace-normal data-wrap:wrap-break-word",
  ],
  caption: "px-grid-cell-x py-inset-xs text-start text-caption-1 text-fg-muted",
  null: "italic text-grid-null",
} as const;

interface TableContextValue {
  container: RefObject<HTMLDivElement | null>;
  setRowCount: (count: number | undefined) => void;
}

const TableContext = createContext<TableContextValue | null>(null);

export interface TableProps extends Omit<ComponentProps<"table">, "className" | "ref"> {
  /** plain, striped (alternate rows in grid.row-bg-alt) or bordered (vertical rules between columns). */
  variant?: keyof typeof tableVariants.variant;
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
export function Table({ variant = "plain", className, tableClassName, children, ref, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, ...props }: TableProps) {
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
  const context = useMemo(() => ({ container, setRowCount }), []);
  return (
    <TableContext value={context}>
      <div
        ref={setRef}
        data-slot="table"
        data-variant={variant}
        role={labelled ? "region" : undefined}
        tabIndex={labelled ? 0 : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className={cn(base, tableVariants.variant[variant], className)}
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
  /** Shows the row as selected (grid.selection-bg) and sets aria-selected. */
  selected?: boolean;
  className?: string;
}

/** A `<tr>`. */
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
 * height. Rows are grid.row-height tall, one line each; spacer rows keep the scroll height, so
 * the header still sticks and the table stays a table for assistive technology.
 */
export function TableVirtualBody({ count, renderRow, overscan = 10, headerRows = 1, className, ref }: TableVirtualBodyProps) {
  const context = useContext(TableContext);
  if (!context) throw new Error("TableVirtualBody must be inside a Table");
  const { container, setRowCount } = context;
  const body = useRef<HTMLTableSectionElement | null>(null);
  const [view, setView] = useState({ scrollTop: 0, viewport: 0, rowHeight: 28, bodyTop: 0 });

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
          rowHeight: tokenPx(element, "--by-grid-row-height", previous.rowHeight),
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
  }, [container]);

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
