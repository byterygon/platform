import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { cn } from "@/lib/cn";

// A two-state button on Base UI's Toggle: aria-pressed and data-pressed follow `pressed`. Unpressed
// it is quiet (color.fg.muted); pressed it takes color.interactive.selected and color.fg.default,
// so the state does not rest on colour alone. ToggleGroup reuses the base and the variants.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const toggleButtonVariants = {
  variant: {
    /** No border: toolbars and dense rows. */
    ghost: "border-transparent",
    /** A strong border, for a toggle that stands alone next to inputs. */
    outline: "border-border-strong bg-surface",
  },
  size: {
    sm: "h-control-sm px-inset-sm text-label",
    md: "h-control-md px-control-x text-label",
    lg: "h-control-lg px-inset-lg text-body-strong",
  },
} as const;

/** The classes every variant and size shares; ToggleGroupItem reuses them. */
export const toggleButtonBase = [
  "inline-flex shrink-0 select-none items-center justify-center gap-inline-sm whitespace-nowrap",
  "rounded-md border font-sans text-fg-muted",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "hover:bg-hover hover:text-fg active:bg-pressed",
  "data-pressed:bg-selected data-pressed:text-fg data-pressed:hover:bg-selected-hover",
  "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "data-disabled:pointer-events-none data-disabled:opacity-[var(--by-opacity-disabled)]",
  "[&_svg]:size-icon-sm [&_svg]:shrink-0",
];

export interface ToggleButtonProps extends Omit<TogglePrimitive.Props, "className" | "value"> {
  /** Border or none. */
  variant?: keyof typeof toggleButtonVariants.variant;
  /** Control height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof toggleButtonVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A button that stays on or off (bold, word wrap, "show nulls"), on Base UI's Toggle: a native
 * `<button>` with aria-pressed. Use `pressed` and `onPressedChange`, or `defaultPressed`. For one
 * of several options use ToggleGroup. The ref reaches the `<button>`.
 */
export function ToggleButton({ variant = "ghost", size = "md", className, ...props }: ToggleButtonProps) {
  return (
    <TogglePrimitive
      data-slot="toggle-button"
      data-variant={variant}
      data-size={size}
      className={cn(toggleButtonBase, toggleButtonVariants.variant[variant], toggleButtonVariants.size[size], className)}
      {...props}
    />
  );
}
