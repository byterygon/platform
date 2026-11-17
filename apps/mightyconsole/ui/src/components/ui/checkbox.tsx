import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckboxGroup as CheckboxGroupPrimitive } from "@base-ui/react/checkbox-group";
import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { controlSize, focusRing, type ControlSizeProp } from "@/lib/control";
import { Checkmark, Subtract } from "@/lib/icons";

// A checkbox on Base UI's Checkbox: a focusable <span role="checkbox"> with a hidden <input>
// beside it for forms. Ticked and mixed it fills with the accent solid and shows a check or a
// dash. Label it by wrapping it in a FieldLabel (or any <label>). CheckboxGroup shares one
// string[] value between several checkboxes and is a fieldset, so a FieldLegend names it.
// Fluent 2's Checkbox: a 16 px box (20 large, 14 small) with the accessible stroke, the accent fill
// and a Fluent Checkmark when ticked, Subtract when mixed, and the double focus ring.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const checkboxVariants = {
  size: {
    small: "size-icon-sm [&_svg]:size-icon-xs",
    medium: "size-icon-md [&_svg]:size-icon-xs",
    large: "size-icon-lg [&_svg]:size-icon-md",
  },
} as const;

const base = [
  "inline-flex shrink-0 items-center justify-center rounded-xs border border-border-strong bg-layer-alt text-accent-solid-fg",
  "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
  "hover:bg-hover",
  "data-checked:border-transparent data-checked:bg-accent-solid data-checked:hover:bg-accent-solid-hover data-checked:active:bg-accent-solid-active",
  "data-indeterminate:border-transparent data-indeterminate:bg-accent-solid data-indeterminate:hover:bg-accent-solid-hover",
  focusRing,
  "aria-invalid:border-danger-border data-invalid:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:border-border-disabled data-disabled:bg-transparent data-disabled:text-fg-disabled",
  "data-disabled:data-checked:bg-disabled data-disabled:data-indeterminate:bg-disabled",
  "[&_svg]:block",
];

const groupClasses = ["flex min-w-0 flex-col gap-stack-sm"];


export interface CheckboxProps extends Omit<CheckboxPrimitive.Root.Props, "className" | "children"> {
  /** Box size: small 14, medium 16 (Fluent's), large 20 px (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A checkbox for one yes/no choice that takes effect on submit, on Base UI's Checkbox. Use
 * `checked` and `onCheckedChange`, or `defaultChecked`; `indeterminate` shows the mixed state (a
 * "select all" over a partial selection). Wrap it in a FieldLabel with its text. The ref reaches
 * the `<span role="checkbox">`.
 */
export function Checkbox({ size, className, ...props }: CheckboxProps) {
  const box = controlSize(size);
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" data-size={box} className={cn(base, checkboxVariants.size[box], className)} {...props}>
      <CheckboxPrimitive.Indicator
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            <Icon icon={state.indeterminate ? Subtract : Checkmark} filled />
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

export interface CheckboxGroupProps extends Omit<CheckboxGroupPrimitive.Props, "className" | "render"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * Checkboxes that share one value, on Base UI's CheckboxGroup: `value` is the array of the ticked
 * checkboxes' `value`s. A fieldset: put a FieldLegend first, then a FieldItem per checkbox. A
 * Checkbox with `parent` ticks or clears all of `allValues`. The ref reaches the group's `<div>`.
 */
export function CheckboxGroup({ className, disabled, ref, children, ...props }: CheckboxGroupProps) {
  // Base UI's pattern for a labelled group: a Fieldset.Root rendered as the CheckboxGroup.
  return (
    <FieldsetPrimitive.Root
      data-slot="checkbox-group"
      ref={ref}
      disabled={disabled}
      className={cn(groupClasses, className)}
      render={<CheckboxGroupPrimitive disabled={disabled} {...props} />}
    >
      {children}
    </FieldsetPrimitive.Root>
  );
}
