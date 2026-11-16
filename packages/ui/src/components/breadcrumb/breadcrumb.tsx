import { useRender } from "@base-ui/react/use-render";
import type { ComponentProps } from "react";
import { Icon } from "@/components/icon/icon";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { ChevronRight, MoreHorizontal } from "@/lib/icons";

// Where the user is in a hierarchy, as a trail of links: a <nav> with an ordered list, on Base UI's
// useRender (no Base UI part exists). Breadcrumb > BreadcrumbList > BreadcrumbItem >
// BreadcrumbLink (or BreadcrumbPage for the current place), with BreadcrumbSeparator between items
// and BreadcrumbEllipsis for a collapsed middle. BreadcrumbLink takes `render` for a router link.

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
