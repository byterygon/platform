import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";

// The thin bar at the bottom of an app or a pane (DBee: connection, row count, elapsed time,
// cursor position): StatusBar > StatusBarItem, StatusBarButton, StatusBarSpacer. Items keep one
// line and truncate with an ellipsis when the bar is narrow (put the full text in `title`); the
// spacer pushes what follows to the end. An item with `live` is a polite live region (role="status"),
// so a row count that changes when a query ends is announced without moving focus.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const statusBarVariants = {
  variant: {
    default: "border-t border-border bg-surface text-fg-muted",
    accent: "bg-accent-solid text-accent-solid-fg",
  },
} as const;

const base = ["flex h-control-xs min-w-0 shrink-0 items-center gap-inline-xs overflow-hidden px-inline-xs font-sans text-caption"];

const classes = {
  item: "inline-flex min-w-0 shrink items-center gap-inline-xs px-inline-xs whitespace-nowrap [&>span]:truncate [&_svg]:size-icon-xs [&_svg]:shrink-0",
  button: [
    "inline-flex h-full min-w-0 shrink cursor-default items-center gap-inline-xs rounded-xs px-inline-xs whitespace-nowrap",
    "hover:bg-hover in-data-[variant=accent]:hover:bg-accent-solid-hover",
    "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:-outline-offset-[var(--by-ring-width)] focus-visible:outline-ring",
    "data-disabled:pointer-events-none data-disabled:opacity-[var(--by-opacity-disabled)]",
    "[&>span]:truncate [&_svg]:size-icon-xs [&_svg]:shrink-0",
  ],
  spacer: "flex-1",
} as const;

type DivProps = Omit<useRender.ComponentProps<"div">, "className"> & { className?: string };

export interface StatusBarProps extends DivProps {
  /** `default` on the surface with a top border; `accent` filled with the accent solid (a focused or remote session). */
  variant?: keyof typeof statusBarVariants.variant;
}

/** The bar, a `<div role="group">`; name it with aria-label ("Status"). The ref reaches it. */
export function StatusBar({ variant = "default", className, render, ...props }: StatusBarProps) {
  return useRender({
    defaultTagName: "div",
    render,
    props: { role: "group", "data-slot": "status-bar", "data-variant": variant, ...props, className: cn(base, statusBarVariants.variant[variant], className) },
  });
}

export interface StatusBarItemProps extends Omit<useRender.ComponentProps<"div">, "className"> {
  /** A polite live region (role="status"): changes to its text are announced. */
  live?: boolean;
  className?: string;
}

/** One piece of status text, with an optional leading icon (aria-hidden svg). Wrap the text in a `<span>` to truncate it. */
export function StatusBarItem({ live = false, className, render, ...props }: StatusBarItemProps) {
  return useRender({
    defaultTagName: "div",
    render,
    props: {
      "data-slot": "status-bar-item",
      ...(live ? { role: "status", "aria-live": "polite" as const } : {}),
      ...props,
      className: cn(classes.item, className),
    },
  });
}

export interface StatusBarButtonProps extends Omit<ButtonPrimitive.Props, "className"> {
  className?: string;
}

/** A status item that does something when pressed (switch the connection, go to line). */
export function StatusBarButton({ className, type = "button", ...props }: StatusBarButtonProps) {
  return <ButtonPrimitive data-slot="status-bar-button" type={type} className={cn(classes.button, className)} {...props} />;
}

/** Takes the free space, so the items after it sit at the end of the bar. */
export function StatusBarSpacer({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "status-bar-spacer", "aria-hidden": true, ...props, className: cn(classes.spacer, className) } });
}
