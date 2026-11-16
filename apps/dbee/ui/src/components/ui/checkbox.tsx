import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckboxGroup as CheckboxGroupPrimitive } from "@base-ui/react/checkbox-group";
import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import { cn } from "@/lib/cn";

// A checkbox on Base UI's Checkbox: a focusable <span role="checkbox"> with a hidden <input>
// beside it for forms. Ticked and mixed it fills with the accent solid and shows a check or a
// dash. Label it by wrapping it in a FieldLabel (or any <label>). CheckboxGroup shares one
// string[] value between several checkboxes and is a fieldset, so a FieldLegend names it.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const checkboxVariants = {
  size: {
    sm: "size-icon-sm [&_svg]:size-icon-xs",
    md: "size-icon-md [&_svg]:size-icon-sm",
    lg: "size-icon-lg [&_svg]:size-icon-md",
  },
} as const;

const base = [
  "inline-flex shrink-0 items-center justify-center rounded-xs border border-border-strong bg-surface text-accent-solid-fg",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "hover:bg-hover",
  "data-checked:border-transparent data-checked:bg-accent-solid data-checked:hover:bg-accent-solid-hover",
  "data-indeterminate:border-transparent data-indeterminate:bg-accent-solid data-indeterminate:hover:bg-accent-solid-hover",
  "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "aria-invalid:border-danger-border data-invalid:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
  "[&_svg]:block",
];

const groupClasses = ["flex min-w-0 flex-col gap-stack-sm"];

const CheckIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </svg>
);

const DashIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 8h8" />
  </svg>
);

export interface CheckboxProps extends Omit<CheckboxPrimitive.Root.Props, "className" | "children"> {
  /** Box size, from the `size.icon.*` roles. */
  size?: keyof typeof checkboxVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A checkbox for one yes/no choice that takes effect on submit, on Base UI's Checkbox. Use
 * `checked` and `onCheckedChange`, or `defaultChecked`; `indeterminate` shows the mixed state (a
 * "select all" over a partial selection). Wrap it in a FieldLabel with its text. The ref reaches
 * the `<span role="checkbox">`.
 */
export function Checkbox({ size = "md", className, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" data-size={size} className={cn(base, checkboxVariants.size[size], className)} {...props}>
      <CheckboxPrimitive.Indicator render={(indicatorProps, state) => <span {...indicatorProps}>{state.indeterminate ? <DashIcon /> : <CheckIcon />}</span>} />
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
