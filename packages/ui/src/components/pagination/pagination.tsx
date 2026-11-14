import type { ComponentProps } from "react";
import { Button } from "@/components/button/button";
import { IconButton } from "@/components/icon-button/icon-button";
import { cn } from "@/lib/cn";

// Moving between pages of a long list: a <nav> with Previous, page numbers (the first, the last,
// the current one and its neighbours, an ellipsis for the gaps) and Next, built from Button and
// IconButton. Data-driven: `page`, `pageCount`, `onPageChange`. No Base UI part exists for it.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const paginationVariants = {
  /** Button height, from `size.control.*`; page buttons are at least as wide as they are tall. */
  size: {
    sm: "min-w-control-sm",
    md: "min-w-control-md",
  },
} as const;

const classes = {
  list: "flex flex-wrap items-center gap-inline-xs font-sans",
  page: "px-inset-xs data-current:bg-selected data-current:text-fg data-current:hover:bg-selected-hover",
  ellipsis: "flex min-w-control-sm items-center justify-center text-body text-fg-subtle select-none",
} as const;

/** The items to show: page numbers and "gap" markers, for `page` of `pageCount` with `siblings` each side. */
export function pageItems(page: number, pageCount: number, siblings = 1): (number | "gap")[] {
  if (pageCount <= 0) return [];
  const window = siblings * 2 + 5; // first, last, current, two gaps
  if (pageCount <= window) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const start = Math.max(2, Math.min(page - siblings, pageCount - siblings * 2 - 2));
  const end = Math.min(pageCount - 1, Math.max(page + siblings, siblings * 2 + 3));
  const items: (number | "gap")[] = [1];
  if (start > 2) items.push("gap");
  for (let i = start; i <= end; i += 1) items.push(i);
  if (end < pageCount - 1) items.push("gap");
  items.push(pageCount);
  return items;
}

const ChevronLeft = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m10 4-4 4 4 4" />
  </svg>
);

const ChevronRight = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 4 4 4-4 4" />
  </svg>
);

export interface PaginationProps extends Omit<ComponentProps<"nav">, "className" | "onChange"> {
  /** The current page, from 1. */
  page: number;
  /** How many pages there are. */
  pageCount: number;
  /** Called with the page the user picked. */
  onPageChange?: (page: number) => void;
  /** Pages shown on each side of the current one. */
  siblingCount?: number;
  /** Button height. */
  size?: keyof typeof paginationVariants.size;
  /** Accessible names: the landmark, the arrows and each page ("Page 3"). */
  labels?: { nav?: string; previous?: string; next?: string; page?: (page: number) => string };
  /** Disables every button (while a page loads). */
  disabled?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** Previous, page numbers with gaps, and Next, in a <nav> named "Pagination". */
export function Pagination({ page, pageCount, onPageChange, siblingCount = 1, size = "md", labels = {}, disabled = false, className, ...props }: PaginationProps) {
  const { nav = "Pagination", previous = "Previous page", next = "Next page", page: pageLabel = (n: number) => `Page ${n}` } = labels;
  const go = (target: number) => {
    if (target !== page && target >= 1 && target <= pageCount) onPageChange?.(target);
  };
  return (
    <nav data-slot="pagination" data-size={size} aria-label={nav} className={cn(className)} {...props}>
      <ul className={cn(classes.list)}>
        <li>
          <IconButton aria-label={previous} size={size} disabled={disabled || page <= 1} onClick={() => go(page - 1)}>
            <ChevronLeft />
          </IconButton>
        </li>
        {pageItems(page, pageCount, siblingCount).map((item, index) =>
          item === "gap" ? (
            <li key={`gap-${index}`} data-slot="pagination-ellipsis" aria-hidden="true" className={cn(classes.ellipsis)}>
              …
            </li>
          ) : (
            <li key={item}>
              <Button
                data-slot="pagination-page"
                variant="ghost"
                size={size}
                disabled={disabled}
                aria-label={pageLabel(item)}
                aria-current={item === page ? "page" : undefined}
                data-current={item === page ? "" : undefined}
                onClick={() => go(item)}
                className={cn(classes.page, paginationVariants.size[size])}
              >
                {item}
              </Button>
            </li>
          ),
        )}
        <li>
          <IconButton aria-label={next} size={size} disabled={disabled || page >= pageCount} onClick={() => go(page + 1)}>
            <ChevronRight />
          </IconButton>
        </li>
      </ul>
    </nav>
  );
}
