import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { createContext, useContext } from "react";
import { toggleButtonBase, toggleButtonVariants } from "@/components/ui/toggle-button";
import { cn } from "@/lib/cn";
import { controlAppearance, controlSize, type ControlSizeProp } from "@/lib/control";

// A row (or column) of toggles with shared state, on Base UI's ToggleGroup: one pressed value by
// default, several with `multiple`; arrow keys move focus between the items. The items are
// ToggleButton's subtle look; the group sets their size (`*:` classes) and, in the outline
// appearance, joins them into one track with dividers, a segmented control: the items draw the
// track's edge themselves (so the track is exactly the items' height), the pressed one takes the
// neutral pressed wash (color.interactive.active) and the strong weight. The items learn the group's appearance and
// orientation from a context, so their own classes resolve with no specificity contest.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const toggleGroupVariants = {
  appearance: {
    /** One track with a divider between items: a segmented control. */
    outline: "rounded-md bg-layer *:focus-visible:relative",
    /** Separate quiet items with a small gap: toolbars. */
    subtle: "gap-inline-xs",
  },
  size: {
    small: "*:h-control-sm *:px-inset-xs *:text-caption-1 [&_svg]:size-icon-md",
    medium: "*:h-control-md *:px-control-x *:text-body-1-strong [&_svg]:size-icon-lg",
    large: "*:h-control-lg *:px-inset-md *:text-subtitle-2 [&_svg]:size-icon-xl",
  },
} as const;

/** The outline items' own classes: the track's edge, its corners, the pressed wash and weight. */
const segment = {
  horizontal: "rounded-none border-border bg-clip-padding not-last:border-e-0 first:rounded-s-md last:rounded-e-md data-pressed:bg-pressed data-pressed:hover:bg-pressed",
  vertical: "rounded-none border-border bg-clip-padding not-last:border-b-0 first:rounded-t-md last:rounded-b-md data-pressed:bg-pressed data-pressed:hover:bg-pressed",
} as const;
const pressedWeight = { small: "data-pressed:text-caption-1-strong", medium: "", large: "" } as const;

const GroupLook = createContext<{ look: keyof typeof toggleGroupVariants.appearance; orientation: "horizontal" | "vertical"; size: keyof typeof toggleGroupVariants.size } | null>(null);

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
  appearance?: keyof typeof toggleGroupVariants.appearance | undefined;
  /**
   * The old name of `appearance` (`ghost` is `subtle`).
   * @deprecated Use `appearance`. Kept for one release.
   */
  variant?: ToggleGroupVariant | undefined;
  /** Item height: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
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
    <GroupLook.Provider value={{ look, orientation, size: height }}>
      <ToggleGroupPrimitive
        data-slot="toggle-group"
        data-appearance={look}
        data-size={height}
        orientation={orientation}
        className={cn(base, toggleGroupVariants.appearance[look], toggleGroupVariants.size[height], className)}
        {...props}
      />
    </GroupLook.Provider>
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
  const group = useContext(GroupLook);
  const own = group?.look === "outline" ? [segment[group.orientation], pressedWeight[group.size]] : null;
  return <TogglePrimitive data-slot="toggle-group-item" className={cn(toggleButtonBase, toggleButtonVariants.appearance.subtle, own, className)} {...props} />;
}
