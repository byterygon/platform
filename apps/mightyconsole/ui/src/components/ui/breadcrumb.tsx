import { useRender } from "@base-ui/react/use-render";
import { type ComponentProps, type RefCallback, useCallback, useLayoutEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { ChevronRight, MoreHorizontal } from "@/lib/icons";

// Where the user is in a hierarchy, as a trail of links: a <nav> with an ordered list, on Base UI's
// useRender (no Base UI part exists). Breadcrumb > BreadcrumbList > BreadcrumbItem >
// BreadcrumbLink (or BreadcrumbPage for the current place), with BreadcrumbSeparator between items
// and BreadcrumbEllipsis for a collapsed middle. BreadcrumbLink takes `render` for a router link.
// useBreadcrumbOverflow folds the first items into the ellipsis when the trail does not fit, the
// last ones always shown (Fluent's Breadcrumb overflow).

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const breadcrumbVariants = {} as const;

const classes = {
  list: "flex min-w-0 flex-wrap items-center gap-inline-xs font-sans text-body-1 text-fg-muted",
  item: "inline-flex min-w-0 items-center gap-inline-xs",
  link: [
    "min-w-0 truncate rounded-md px-inline-xs text-fg-muted underline-offset-4",
    "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease hover:bg-hover hover:text-fg active:bg-pressed",
    focusRing,
  ],
  page: "min-w-0 truncate px-inline-xs text-body-1-strong text-fg",
  separator: "flex text-fg-subtle [&_svg]:size-icon-sm rtl:[&_svg]:-scale-x-100",
  ellipsis: "flex size-icon-md items-center justify-center text-fg-subtle [&_svg]:size-icon-sm",
} as const;

type WithClass<P> = Omit<P, "className"> & {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
};

export type BreadcrumbProps = WithClass<ComponentProps<"nav">>;

/** The trail: a <nav> named "Breadcrumb" (aria-label) holding a BreadcrumbList. */
export function Breadcrumb({ className, "aria-label": label = "Breadcrumb", ...props }: BreadcrumbProps) {
  return <nav data-slot="breadcrumb" aria-label={label} className={cn("min-w-0", className)} {...props} />;
}

/** The ordered list of places, from the root to the current one. */
export function BreadcrumbList({ className, ...props }: WithClass<ComponentProps<"ol">>) {
  return <ol data-slot="breadcrumb-list" className={cn(classes.list, className)} {...props} />;
}

/** One place in the trail. */
export function BreadcrumbItem({ className, ...props }: WithClass<ComponentProps<"li">>) {
  return <li data-slot="breadcrumb-item" className={cn(classes.item, className)} {...props} />;
}

export type BreadcrumbLinkProps = WithClass<useRender.ComponentProps<"a">>;

/** A link to a place above the current one; `render` swaps the `<a>` for a router link. */
export function BreadcrumbLink({ className, render, ...props }: BreadcrumbLinkProps) {
  return useRender({ defaultTagName: "a", render, props: { "data-slot": "breadcrumb-link", ...props, className: cn(classes.link, className) } });
}

/** The current place: not a link, aria-current="page". */
export function BreadcrumbPage({ className, ...props }: WithClass<ComponentProps<"span">>) {
  return <span data-slot="breadcrumb-page" aria-current="page" className={cn(classes.page, className)} {...props} />;
}

/** The mark between two items (a chevron by default), hidden from assistive technology. */
export function BreadcrumbSeparator({ className, children, ...props }: WithClass<ComponentProps<"li">>) {
  return (
    <li data-slot="breadcrumb-separator" role="presentation" aria-hidden="true" className={cn(classes.separator, className)} {...props}>
      {children ?? <Icon icon={ChevronRight} />}
    </li>
  );
}

/** Stands for collapsed items; put it in a BreadcrumbItem, or render a DropdownMenuTrigger listing them. */
export function BreadcrumbEllipsis({ className, ...props }: WithClass<ComponentProps<"span">>) {
  return (
    <span data-slot="breadcrumb-ellipsis" role="presentation" className={cn(classes.ellipsis, className)} {...props}>
      <Icon icon={MoreHorizontal} />
      <span className="sr-only">More places</span>
    </span>
  );
}

export interface BreadcrumbOverflowOptions {
  /** How many items the trail has. */
  count: number;
  /** Changes whenever the items' labels do, so their widths are measured again. */
  signature?: string;
  /** Items always shown at the end of the trail: the current place and its parent. */
  keepEnd?: number;
  /** Items always shown at the start (none by default: the first ones fold first). */
  keepStart?: number;
  /** The width the trail may take, in px; the list's own width when absent. */
  available?: number | undefined;
}

export interface BreadcrumbOverflow {
  /** Put it on the BreadcrumbList (with `flex-nowrap`, in a parent that limits its width). */
  ref: RefCallback<HTMLOListElement>;
  /** The folded items' indexes, in order: render one BreadcrumbEllipsis in their place. */
  hidden: readonly number[];
  /** The whole trail's width in px once measured, else `null`. */
  width: number | null;
}

/** Marks an item for useBreadcrumbOverflow: `data-breadcrumb-index` on each BreadcrumbItem. */
export const BREADCRUMB_INDEX = "data-breadcrumb-index";
/** Marks the BreadcrumbItem holding the ellipsis, so its width is known. */
export const BREADCRUMB_OVERFLOW = "data-breadcrumb-overflow";

interface Measure {
  key: string;
  /** Each item's width plus its share of the separators and gaps. */
  costs: number[];
  total: number;
  /** One separator and its gaps. */
  share: number;
}

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The first items that fold so the trail fits `available` px: none when it fits, else from
 * `keepStart` on until the rest plus the ellipsis fit; the last `keepEnd` never fold.
 */
export function foldBreadcrumb(costs: readonly number[], available: number, ellipsis: number, keepStart = 0, keepEnd = 2): number[] {
  let width = costs.reduce((sum, c) => sum + c, 0);
  if (width <= available) return [];
  width += ellipsis;
  const hidden: number[] = [];
  for (let i = keepStart; i < costs.length - keepEnd && width > available; i++) {
    hidden.push(i);
    width -= costs[i]!;
  }
  return hidden;
}

/**
 * Overflow for a Breadcrumb (Fluent's rule): when the items do not fit, the first ones fold into
 * a BreadcrumbEllipsis menu and the last two always show. Each BreadcrumbItem carries
 * `data-breadcrumb-index={i}`; the item holding the ellipsis `data-breadcrumb-overflow`. The
 * widths are measured with every item shown, once per `signature`, then the fold follows the
 * width the trail has.
 */
export function useBreadcrumbOverflow({ count, signature = String(count), keepEnd = 2, keepStart = 0, available }: BreadcrumbOverflowOptions): BreadcrumbOverflow {
  const key = `${count}\u0000${signature}`;
  const [list, setList] = useState<HTMLOListElement | null>(null);
  const [own, setOwn] = useState<number | null>(null);
  const [hidden, setHidden] = useState<readonly number[]>([]);
  const [measure, setMeasure] = useState<Measure | null>(null);
  const [ellipsis, setEllipsis] = useState(32);
  const ref = useCallback<RefCallback<HTMLOListElement>>((el) => setList(el), []);
  const stale = measure?.key !== key;

  // New labels: show every item again so each can be measured.
  useLayoutEffect(() => {
    if (stale) setHidden((h) => (h.length === 0 ? h : []));
  }, [stale, key]);

  // Measure with every item shown; the ellipsis whenever it is shown.
  useLayoutEffect(() => {
    if (!list) return;
    const folded = list.querySelector<HTMLElement>(`[${BREADCRUMB_OVERFLOW}]`)?.getBoundingClientRect().width;
    if (folded) setEllipsis((w) => (w === folded ? w : folded));
    if (!stale || hidden.length > 0) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>(`[${BREADCRUMB_INDEX}]`));
    if (items.length !== count) return;
    // An item's natural width: what it shows plus what its truncated text hides.
    const widths = items.map((el) => {
      let width = el.getBoundingClientRect().width;
      for (const text of el.querySelectorAll<HTMLElement>("[data-slot=breadcrumb-link], [data-slot=breadcrumb-page]")) width += Math.max(0, text.scrollWidth - text.clientWidth);
      return width;
    });
    const sum = widths.reduce((a, b) => a + b, 0);
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    const separators = Array.from(list.querySelectorAll<HTMLElement>("[data-slot=breadcrumb-separator]")).reduce((a, el) => a + el.getBoundingClientRect().width, 0);
    const overhead = separators + gap * Math.max(0, list.children.length - 1);
    const share = count > 1 ? overhead / (count - 1) : 0;
    setMeasure({ key, costs: widths.map((w, i) => w + (i > 0 ? share : 0)), total: sum + overhead, share });
  });

  // The list's own width, when the caller does not give one.
  useLayoutEffect(() => {
    if (!list || available !== undefined || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setOwn(list.clientWidth));
    observer.observe(list);
    setOwn(list.clientWidth);
    return () => observer.disconnect();
  }, [list, available]);

  const room = available ?? own;
  useLayoutEffect(() => {
    if (!measure || stale || room === null) return;
    const next = foldBreadcrumb(measure.costs, room, ellipsis + measure.share, keepStart, keepEnd);
    setHidden((h) => (sameList(h, next) ? h : next));
  }, [measure, stale, room, ellipsis, keepStart, keepEnd]);

  return { ref, hidden: stale ? [] : hidden, width: stale ? null : (measure?.total ?? null) };
}
