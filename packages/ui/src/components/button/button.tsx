import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@/lib/cn";

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const buttonVariants = {
  variant: {
    /** The one primary action of a view. */
    primary: "bg-accent-solid text-accent-solid-fg hover:bg-accent-solid-hover active:bg-accent-solid-active",
    /** A filled grey action next to the primary one. */
    secondary: "bg-neutral-solid text-neutral-solid-fg hover:bg-neutral-solid-hover active:bg-neutral-solid-active",
    /** A quiet action in toolbars, tables and dense layouts. */
    ghost: "bg-transparent text-fg hover:bg-hover active:bg-pressed",
    /** An action that destroys data or cannot be undone. */
    danger: "bg-danger text-danger-solid-fg hover:bg-danger-hover active:bg-danger-hover",
  },
  size: {
    sm: "h-control-sm px-inset-sm text-label",
    md: "h-control-md px-control-x text-label",
    lg: "h-control-lg px-inset-lg text-body-strong",
  },
} as const;

/** The classes every size and variant shares; IconButton reuses them. */
export const buttonBase = [
  "inline-flex shrink-0 select-none items-center justify-center gap-inline-sm whitespace-nowrap",
  "rounded-md border border-transparent font-sans",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "data-disabled:pointer-events-none data-disabled:opacity-[var(--by-opacity-disabled)]",
  "data-loading:pointer-events-none",
  "[&_svg]:size-icon-sm [&_svg]:shrink-0",
];

export interface ButtonProps extends Omit<ButtonPrimitive.Props, "className"> {
  /** Visual weight of the action. */
  variant?: keyof typeof buttonVariants.variant;
  /** Control height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof buttonVariants.size;
  /**
   * Shows that the action is running: the button stays focusable, ignores clicks and sets
   * `aria-busy` and `data-loading`.
   */
  loading?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * An action button on Base UI's Button (a native `<button>` unless `render` changes it). The ref
 * reaches the rendered element.
 */
export function Button({ variant = "primary", size = "md", loading = false, disabled, className, type = "button", ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      type={type}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      className={cn(buttonBase, buttonVariants.variant[variant], buttonVariants.size[size], className)}
      {...props}
    />
  );
}
