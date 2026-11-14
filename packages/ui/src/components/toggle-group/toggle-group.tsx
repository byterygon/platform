import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { toggleButtonBase, toggleButtonVariants } from "@/components/toggle-button/toggle-button";
import { cn } from "@/lib/cn";

// A row (or column) of toggles with shared state, on Base UI's ToggleGroup: one pressed value by
// default, several with `multiple`; arrow keys move focus between the items. The items are
// ToggleButton's look; the group sets their size (`*:` classes) and, in the outline variant,
// joins them into one bordered track with dividers.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const toggleGroupVariants = {
  variant: {
    /** One bordered track with a divider between items: a segmented control. */
    outline: [
      "rounded-md border border-border-strong bg-surface",
      "*:rounded-none *:not-first:border-s-border",
      "data-[orientation=horizontal]:*:first:rounded-s-md data-[orientation=horizontal]:*:last:rounded-e-md",
      "data-[orientation=vertical]:*:not-first:border-s-transparent data-[orientation=vertical]:*:not-first:border-t-border",
      "data-[orientation=vertical]:*:first:rounded-t-md data-[orientation=vertical]:*:last:rounded-b-md",
    ].join(" "),
    /** Separate quiet items with a small gap: toolbars. */
    ghost: "gap-inline-xs",
  },
  size: {
    sm: "*:h-control-sm *:px-inset-sm *:text-label",
    md: "*:h-control-md *:px-control-x *:text-label",
    lg: "*:h-control-lg *:px-inset-lg *:text-body-strong",
  },
} as const;

const base = [
  "inline-flex w-fit items-stretch font-sans",
  "data-[orientation=vertical]:flex-col",
  "data-disabled:pointer-events-none",
];

export interface ToggleGroupProps extends Omit<ToggleGroupPrimitive.Props, "className"> {
  /** A segmented track or separate quiet items. */
  variant?: keyof typeof toggleGroupVariants.variant;
  /** Item height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof toggleGroupVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * Toggles that share one value, on Base UI's ToggleGroup (a `<div role="group">`): `value` is the
 * array of pressed items' values; without `multiple`, pressing one releases the others. Name the
 * group with aria-label. Put ToggleGroupItems inside. The ref reaches the `<div>`.
 */
export function ToggleGroup({ variant = "outline", size = "md", orientation = "horizontal", className, ...props }: ToggleGroupProps) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      orientation={orientation}
      className={cn(base, toggleGroupVariants.variant[variant], toggleGroupVariants.size[size], className)}
      {...props}
    />
  );
}

export interface ToggleGroupItemProps extends Omit<TogglePrimitive.Props, "className" | "value"> {
  /** Identifies the item in the group's `value`. */
  value: string;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** One toggle of a ToggleGroup, a native `<button>` with aria-pressed. Icon-only items need an aria-label. */
export function ToggleGroupItem({ className, ...props }: ToggleGroupItemProps) {
  return <TogglePrimitive data-slot="toggle-group-item" className={cn(toggleButtonBase, toggleButtonVariants.variant.ghost, className)} {...props} />;
}
