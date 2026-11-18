import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { controlSize, fieldAppearance, fieldAppearances, fieldFrame, fieldSizes, type ControlSizeProp, type FieldAppearance } from "@/lib/control";
import { Add, Subtract } from "@/lib/icons";

// A number input on Base UI's NumberField: the text control (inputmode decimal, formatted for the
// locale) followed by decrement and increment buttons inside one frame. Arrow keys step by
// `step`, Shift+arrow and PageUp/PageDown by `largeStep`, Home/End jump to min/max. The buttons
// are out of the tab order (Base UI), so the frame's focus underline follows the text control
// only. The frame takes Input's Fluent appearances, sizes and states (Fluent's SpinButton).

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const numberInputVariants = {
  appearance: fieldAppearances,
  size: {
    small: `${fieldSizes.small} *:first:px-inset-xs [&_svg]:size-icon-sm`,
    medium: `${fieldSizes.medium} [&_svg]:size-icon-md`,
    large: `${fieldSizes.large} *:first:px-inset-md [&_svg]:size-icon-lg`,
  },
} as const;

const base = ["flex w-full min-w-0 flex-col font-sans"];

// Written out in full (no template strings): Tailwind finds classes by scanning the source as text.
const groupClasses = [
  "flex w-full min-w-0 items-stretch overflow-hidden",
  fieldFrame,
  "has-[[data-slot=number-input-input]:focus-visible]:shadow-focus-underline",
  "data-invalid:border-danger-border data-invalid:border-b-danger-stroke has-[[aria-invalid=true]]:border-danger-border has-[[aria-invalid=true]]:border-b-danger-stroke",
  "data-disabled:cursor-not-allowed data-disabled:border-border-disabled data-disabled:bg-transparent data-disabled:text-fg-disabled",
];

const inputClasses = [
  "h-full min-w-0 flex-1 bg-transparent px-control-x text-fg tabular-nums outline-none",
  "placeholder:text-fg-subtle",
  "data-disabled:cursor-not-allowed data-disabled:text-fg-disabled data-disabled:placeholder:text-fg-disabled",
];

const stepClasses = [
  "flex h-full aspect-square shrink-0 select-none items-center justify-center border-s border-border-subtle text-fg-muted",
  "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
  "hover:bg-hover hover:text-fg active:bg-pressed",
  "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
];

export interface NumberInputProps extends Omit<NumberFieldPrimitive.Root.Props, "className" | "children"> {
  /** Fluent's field appearance of the frame: outline (default), underline, filled-darker or filled-lighter. */
  appearance?: FieldAppearance | undefined;
  /** Fluent's size: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
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
  appearance,
  size,
  placeholder,
  "aria-label": ariaLabel,
  decrementLabel = "Decrease",
  incrementLabel = "Increase",
  className,
  ...props
}: NumberInputProps) {
  const look = fieldAppearance(appearance);
  const height = controlSize(size);
  return (
    <NumberFieldPrimitive.Root data-slot="number-input" data-appearance={look} data-size={height} className={cn(base, className)} {...props}>
      <NumberFieldPrimitive.Group data-slot="number-input-group" className={cn(groupClasses, numberInputVariants.appearance[look], numberInputVariants.size[height])}>
        <NumberFieldPrimitive.Input data-slot="number-input-input" placeholder={placeholder} aria-label={ariaLabel} className={cn(inputClasses)} />
        <NumberFieldPrimitive.Decrement data-slot="number-input-decrement" aria-label={decrementLabel} className={cn(stepClasses)}>
          <Icon icon={Subtract} />
        </NumberFieldPrimitive.Decrement>
        <NumberFieldPrimitive.Increment data-slot="number-input-increment" aria-label={incrementLabel} className={cn(stepClasses)}>
          <Icon icon={Add} />
        </NumberFieldPrimitive.Increment>
      </NumberFieldPrimitive.Group>
    </NumberFieldPrimitive.Root>
  );
}
