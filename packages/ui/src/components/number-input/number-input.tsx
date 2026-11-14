import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { cn } from "@/lib/cn";

// A number input on Base UI's NumberField: the text control (inputmode decimal, formatted for the
// locale) followed by decrement and increment buttons inside one frame. Arrow keys step by
// `step`, Shift+arrow and PageUp/PageDown by `largeStep`, Home/End jump to min/max. The buttons
// are out of the tab order (Base UI), so the frame's ring follows the text control only.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const numberInputVariants = {
  size: {
    sm: "h-control-sm *:first:px-inset-sm",
    md: "h-control-md",
    lg: "h-control-lg *:first:px-inset-lg",
  },
} as const;

const base = ["flex w-full min-w-0 flex-col font-sans"];

// Written out in full (no template strings): Tailwind finds classes by scanning the source as text.
const groupClasses = [
  "flex w-full min-w-0 items-stretch overflow-hidden rounded-md border border-border-strong bg-surface text-body text-fg",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "has-[[data-slot=number-input-input]:focus-visible]:outline-solid has-[[data-slot=number-input-input]:focus-visible]:outline-[length:var(--by-ring-width)]",
  "has-[[data-slot=number-input-input]:focus-visible]:outline-offset-[var(--by-ring-offset)] has-[[data-slot=number-input-input]:focus-visible]:outline-ring",
  "data-invalid:border-danger-border has-[[aria-invalid=true]]:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
];

const inputClasses = [
  "h-full min-w-0 flex-1 bg-transparent px-control-x text-body text-fg tabular-nums outline-none",
  "placeholder:text-fg-subtle",
  "data-disabled:cursor-not-allowed",
];

const stepClasses = [
  "flex h-full aspect-square shrink-0 select-none items-center justify-center border-s border-border text-fg-muted",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "hover:bg-hover hover:text-fg active:bg-pressed",
  "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
  "[&_svg]:size-icon-sm",
];

const MinusIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M3.5 8h9" />
  </svg>
);

const PlusIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M3.5 8h9M8 3.5v9" />
  </svg>
);

export interface NumberInputProps extends Omit<NumberFieldPrimitive.Root.Props, "className" | "children"> {
  /** Height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof numberInputVariants.size;
  /** Placeholder of the text control. */
  placeholder?: string;
  /** Accessible name when there is no FieldLabel; set on the text control. */
  "aria-label"?: string;
  /** The decrement button's accessible name. */
  decrementLabel?: string;
  /** The increment button's accessible name. */
  incrementLabel?: string;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A number input on Base UI's NumberField, with decrement and increment buttons. Use `value`
 * (a number, or null when empty) and `onValueChange`, `min`, `max`, `step` and `format`
 * (Intl.NumberFormat options). Inside a Field it takes the label, description and validity. The
 * ref reaches the root `<div>`; `inputRef` the `<input>`.
 */
export function NumberInput({
  size = "md",
  placeholder,
  "aria-label": ariaLabel,
  decrementLabel = "Decrease",
  incrementLabel = "Increase",
  className,
  ...props
}: NumberInputProps) {
  return (
    <NumberFieldPrimitive.Root data-slot="number-input" data-size={size} className={cn(base, className)} {...props}>
      <NumberFieldPrimitive.Group data-slot="number-input-group" className={cn(groupClasses, numberInputVariants.size[size])}>
        <NumberFieldPrimitive.Input data-slot="number-input-input" placeholder={placeholder} aria-label={ariaLabel} className={cn(inputClasses)} />
        <NumberFieldPrimitive.Decrement data-slot="number-input-decrement" aria-label={decrementLabel} className={cn(stepClasses)}>
          <MinusIcon />
        </NumberFieldPrimitive.Decrement>
        <NumberFieldPrimitive.Increment data-slot="number-input-increment" aria-label={incrementLabel} className={cn(stepClasses)}>
          <PlusIcon />
        </NumberFieldPrimitive.Increment>
      </NumberFieldPrimitive.Group>
    </NumberFieldPrimitive.Root>
  );
}
