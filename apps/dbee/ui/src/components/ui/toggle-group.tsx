import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { toggleButtonBase, toggleButtonVariants } from "@/components/ui/toggle-button";
import { cn } from "@/lib/cn";
import { controlAppearance, controlSize, type ControlSizeProp } from "@/lib/control";

// A row (or column) of toggles with shared state, on Base UI's ToggleGroup: one pressed value by
// default, several with `multiple`; arrow keys move focus between the items. The items are
// ToggleButton's subtle look; the group sets their size (`*:` classes) and, in the outline
// appearance, joins them into one track (a layer with a hairline and a darker bottom edge, as
// Fluent's secondary Button) with dividers: a segmented control.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const toggleGroupVariants = {
  appearance: {
    /** One track with a divider between items: a segmented control. */
    outline: [
      "rounded-md border border-border-subtle border-b-border-control-bottom-subtle bg-layer",
      "*:rounded-none *:focus-visible:relative *:not-first:border-s-border-subtle",
      "data-[orientation=horizontal]:*:first:rounded-s-md data-[orientation=horizontal]:*:last:rounded-e-md",
      "data-[orientation=vertical]:*:not-first:border-s-transparent data-[orientation=vertical]:*:not-first:border-t-border-subtle",
      "data-[orientation=vertical]:*:first:rounded-t-md data-[orientation=vertical]:*:last:rounded-b-md",
    ].join(" "),
    /** Separate quiet items with a small gap: toolbars. */
    subtle: "gap-inline-xs",
  },
  size: {
    small: "*:h-control-sm *:px-inset-xs *:text-caption-1 [&_svg]:size-icon-md",
    medium: "*:h-control-md *:px-control-x *:text-body-1-strong [&_svg]:size-icon-lg",
    large: "*:h-control-lg *:px-inset-md *:text-subtitle-2 [&_svg]:size-icon-xl",
  },
} as const;

const base = [
  "inline-flex w-fit items-stretch font-sans",
  "data-[orientation=vertical]:flex-col",
  "data-disabled:pointer-events-none",
];

/**
 * The `variant` names from before TSK-53.
 * @deprecated Use `appearance`. Kept for one release.
 */
export type ToggleGroupVariant = "outline" | "ghost";

/** The deprecated `variant` values and the appearances they map to. */
export const TOGGLE_GROUP_VARIANT_ALIASES: Readonly<Record<ToggleGroupVariant, keyof typeof toggleGroupVariants.appearance>> = {
  outline: "outline",
  ghost: "subtle",
};

export interface ToggleGroupProps extends Omit<ToggleGroupPrimitive.Props, "className"> {
  /** A segmented track (outline) or separate quiet items (subtle). */
  appearance?: keyof typeof toggleGroupVariants.appearance;
  /**
   * The old name of `appearance` (`ghost` is `subtle`).
   * @deprecated Use `appearance`. Kept for one release.
   */
  variant?: ToggleGroupVariant;
  /** Item height: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * Toggles that share one value, on Base UI's ToggleGroup (a `<div role="group">`): `value` is the
 * array of pressed items' values; without `multiple`, pressing one releases the others. Name the
 * group with aria-label. Put ToggleGroupItems inside. The ref reaches the `<div>`.
 */
export function ToggleGroup({ appearance, variant, size, orientation = "horizontal", className, ...props }: ToggleGroupProps) {
  const look = controlAppearance(appearance, variant, TOGGLE_GROUP_VARIANT_ALIASES, "outline");
  const height = controlSize(size);
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-appearance={look}
      data-size={height}
      orientation={orientation}
      className={cn(base, toggleGroupVariants.appearance[look], toggleGroupVariants.size[height], className)}
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
  return <TogglePrimitive data-slot="toggle-group-item" className={cn(toggleButtonBase, toggleButtonVariants.appearance.subtle, className)} {...props} />;
}
