import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { controlSize, focusRing, type ControlSizeProp } from "@/lib/control";
import { Circle } from "@/lib/icons";

// One choice out of several, on Base UI's RadioGroup and Radio: a <div role="radiogroup"> of
// focusable <span role="radio">s with hidden inputs for forms. Arrow keys move the selection,
// Tab leaves the group. The group is a fieldset (Base UI's pattern), so a FieldLegend inside
// names it; each option is a FieldItem whose FieldLabel wraps a RadioGroupItem. Fluent 2's Radio:
// a circle with the accessible stroke; chosen, the stroke and a filled dot take the accent.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const radioGroupVariants = {
  size: {
    small: "[&_[role=radio]]:size-icon-sm [&_[role=radio]_svg]:size-icon-xs",
    medium: "[&_[role=radio]]:size-icon-md [&_[role=radio]_svg]:size-icon-sm",
    large: "[&_[role=radio]]:size-icon-lg [&_[role=radio]_svg]:size-icon-md",
  },
} as const;

const base = ["flex min-w-0 flex-col gap-stack-sm"];

const itemClasses = [
  "inline-flex shrink-0 items-center justify-center rounded-full border border-border-strong bg-layer-alt text-accent-solid",
  "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
  "hover:bg-hover",
  "data-checked:border-accent-solid data-checked:hover:border-accent-solid-hover data-checked:hover:text-accent-solid-hover",
  focusRing,
  "aria-invalid:border-danger-border data-invalid:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:border-border-disabled data-disabled:bg-transparent data-disabled:text-fg-disabled",
  "[&_svg]:block",
];


export interface RadioGroupProps extends Omit<RadioGroupPrimitive.Props<string>, "className" | "render"> {
  /** Size of every radio: small 14, medium 16 (Fluent's), large 20 px (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A set of options of which exactly one is chosen, on Base UI's RadioGroup. Use `value` and
 * `onValueChange`, or `defaultValue`. Put a FieldLegend first, then a FieldItem per option with a
 * FieldLabel around a RadioGroupItem and its text. The ref reaches the group's `<div>`.
 */
export function RadioGroup({ size, className, disabled, ref, children, ...props }: RadioGroupProps) {
  const box = controlSize(size);
  // Base UI's pattern for a labelled group: a Fieldset.Root rendered as the RadioGroup.
  return (
    <FieldsetPrimitive.Root
      data-slot="radio-group"
      data-size={box}
      ref={ref}
      disabled={disabled}
      className={cn(base, radioGroupVariants.size[box], className)}
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
      <RadioPrimitive.Indicator className="flex size-full items-center justify-center">
        <Icon icon={Circle} filled />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}
