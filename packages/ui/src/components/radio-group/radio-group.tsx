import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { cn } from "@/lib/cn";

// One choice out of several, on Base UI's RadioGroup and Radio: a <div role="radiogroup"> of
// focusable <span role="radio">s with hidden inputs for forms. Arrow keys move the selection,
// Tab leaves the group. The group is a fieldset (Base UI's pattern), so a FieldLegend inside
// names it; each option is a FieldItem whose FieldLabel wraps a RadioGroupItem.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const radioGroupVariants = {
  size: {
    sm: "[&_[role=radio]]:size-icon-sm",
    md: "[&_[role=radio]]:size-icon-md",
    lg: "[&_[role=radio]]:size-icon-lg",
  },
} as const;

const base = ["flex min-w-0 flex-col gap-stack-sm"];

const itemClasses = [
  "inline-flex shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface text-accent-solid-fg",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "hover:bg-hover",
  "data-checked:border-transparent data-checked:bg-accent-solid data-checked:hover:bg-accent-solid-hover",
  "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "aria-invalid:border-danger-border data-invalid:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
  "[&_svg]:block [&_svg]:size-full",
];

const Dot = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="8" r="3" />
  </svg>
);

export interface RadioGroupProps extends Omit<RadioGroupPrimitive.Props<string>, "className" | "render"> {
  /** Size of every radio in the group, from the `size.icon.*` roles. */
  size?: keyof typeof radioGroupVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A set of options of which exactly one is chosen, on Base UI's RadioGroup. Use `value` and
 * `onValueChange`, or `defaultValue`. Put a FieldLegend first, then a FieldItem per option with a
 * FieldLabel around a RadioGroupItem and its text. The ref reaches the group's `<div>`.
 */
export function RadioGroup({ size = "md", className, disabled, ref, children, ...props }: RadioGroupProps) {
  // Base UI's pattern for a labelled group: a Fieldset.Root rendered as the RadioGroup.
  return (
    <FieldsetPrimitive.Root
      data-slot="radio-group"
      data-size={size}
      ref={ref}
      disabled={disabled}
      className={cn(base, radioGroupVariants.size[size], className)}
      render={<RadioGroupPrimitive disabled={disabled} {...props} />}
    >
      {children}
    </FieldsetPrimitive.Root>
  );
}

export interface RadioGroupItemProps extends Omit<RadioPrimitive.Root.Props<string>, "className" | "children"> {
  /** The value the group takes when this radio is chosen. */
  value: string;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** One radio of a RadioGroup, a `<span role="radio">`; wrap it in a FieldLabel with its text. */
export function RadioGroupItem({ className, ...props }: RadioGroupItemProps) {
  return (
    <RadioPrimitive.Root data-slot="radio-group-item" className={cn(itemClasses, className)} {...props}>
      <RadioPrimitive.Indicator className="size-full">
        <Dot />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}
