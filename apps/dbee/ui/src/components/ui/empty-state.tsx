import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";

// What a view shows when it has nothing to show yet, and the way forward: "No connections yet"
// with Add connection, "No rows" under a query, "No matches" for a filter. EmptyState >
// EmptyStateIcon, EmptyStateTitle, EmptyStateDescription, EmptyStateActions, on Base UI's
// useRender. `centered` fills a panel (first run, an empty tab); `inline` is a compact,
// start-aligned row for small places (a tree, a list, under a grid's header).

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const emptyStateVariants = {
  variant: {
    centered: "mx-auto max-w-panel-md flex-col items-center gap-stack-sm p-inset-xl text-center",
    inline: "flex-row flex-wrap items-center gap-x-inline-md gap-y-stack-xs p-inset-sm text-start",
  },
} as const;

const base = ["flex min-w-0 font-sans text-body text-fg"];

const parts = {
  icon: "flex shrink-0 items-center justify-center rounded-full bg-inset text-fg-muted size-control-lg [&_svg]:size-icon-lg in-data-[variant=inline]:size-control-sm in-data-[variant=inline]:[&_svg]:size-icon-sm",
  title: "min-w-0 text-heading-4 text-fg wrap-break-word in-data-[variant=inline]:text-body-strong",
  description: "min-w-0 text-body text-fg-muted wrap-break-word in-data-[variant=inline]:basis-full",
  actions: "flex flex-wrap items-center justify-center gap-inline-sm pt-inset-xs in-data-[variant=inline]:pt-0",
} as const;

type DivProps = Omit<useRender.ComponentProps<"div">, "className"> & { className?: string };

export interface EmptyStateProps extends DivProps {
  /** centered fills a panel; inline is a compact start-aligned row. */
  variant?: keyof typeof emptyStateVariants.variant;
}

/** The empty view; the ref reaches its `<div>`. */
export function EmptyState({ variant = "centered", className, render, ...props }: EmptyStateProps) {
  return useRender({
    defaultTagName: "div",
    render,
    props: { "data-slot": "empty-state", "data-variant": variant, ...props, className: cn(base, emptyStateVariants.variant[variant], className) },
  });
}

/** A decorative icon in a soft circle; the svg inside should be aria-hidden. */
export function EmptyStateIcon({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "empty-state-icon", "aria-hidden": true, ...props, className: cn(parts.icon, className) } });
}

export type EmptyStateTitleProps = Omit<useRender.ComponentProps<"h3">, "className"> & { className?: string };

/** What is missing ("No connections yet"), an `<h3>` by default. */
export function EmptyStateTitle({ className, render, ...props }: EmptyStateTitleProps) {
  return useRender({ defaultTagName: "h3", render, props: { "data-slot": "empty-state-title", ...props, className: cn(parts.title, className) } });
}

export type EmptyStateDescriptionProps = Omit<useRender.ComponentProps<"p">, "className"> & { className?: string };

/** Why it is empty and what to do, in a sentence or two. */
export function EmptyStateDescription({ className, render, ...props }: EmptyStateDescriptionProps) {
  return useRender({ defaultTagName: "p", render, props: { "data-slot": "empty-state-description", ...props, className: cn(parts.description, className) } });
}

/** The way forward: one primary Button, maybe a secondary one. */
export function EmptyStateActions({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "empty-state-actions", ...props, className: cn(parts.actions, className) } });
}
