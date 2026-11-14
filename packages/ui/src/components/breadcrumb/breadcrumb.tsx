import { useRender } from "@base-ui/react/use-render";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// Where the user is in a hierarchy, as a trail of links: a <nav> with an ordered list, on Base UI's
// useRender (no Base UI part exists). Breadcrumb > BreadcrumbList > BreadcrumbItem >
// BreadcrumbLink (or BreadcrumbPage for the current place), with BreadcrumbSeparator between items
// and BreadcrumbEllipsis for a collapsed middle. BreadcrumbLink takes `render` for a router link.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const breadcrumbVariants = {} as const;

const classes = {
  list: "flex min-w-0 flex-wrap items-center gap-inline-xs font-sans text-body text-fg-muted",
  item: "inline-flex min-w-0 items-center gap-inline-xs",
  link: [
    "min-w-0 truncate rounded-xs text-fg-muted underline-offset-4 outline-none",
    "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard hover:text-fg hover:underline",
    "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  ],
  page: "min-w-0 truncate text-fg",
  separator: "flex text-fg-subtle [&_svg]:size-icon-xs",
  ellipsis: "flex size-icon-md items-center justify-center text-fg-subtle [&_svg]:size-icon-sm",
} as const;

const ChevronIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 4 4 4-4 4" />
  </svg>
);

const MoreIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="3.5" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="12.5" cy="8" r="1.25" />
  </svg>
);

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
      {children ?? <ChevronIcon />}
    </li>
  );
}

/** Stands for collapsed items; put it in a BreadcrumbItem, or render a DropdownMenuTrigger listing them. */
export function BreadcrumbEllipsis({ className, ...props }: WithClass<ComponentProps<"span">>) {
  return (
    <span data-slot="breadcrumb-ellipsis" role="presentation" className={cn(classes.ellipsis, className)} {...props}>
      <MoreIcon />
      <span className="sr-only">More places</span>
    </span>
  );
}
