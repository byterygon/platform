import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/cn";
import { controlSize, fieldAppearance, fieldAppearances, fieldFrame, fieldPadding, fieldSizes, fieldStates, type ControlSizeProp, type FieldAppearance } from "@/lib/control";

// Fluent 2's Input on Base UI's Input: appearance outline (default), underline, filled-darker or
// filled-lighter; sizes small, medium and large. The frame is a hairline with a darker bottom
// edge (what makes the field 3:1); focus is the accent underline; invalid turns the edges danger.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const inputVariants = {
  appearance: fieldAppearances,
  size: {
    small: `${fieldSizes.small} ${fieldPadding.small}`,
    medium: `${fieldSizes.medium} ${fieldPadding.medium}`,
    large: `${fieldSizes.large} ${fieldPadding.large}`,
  },
} as const;

const base = ["flex w-full min-w-0", fieldFrame, fieldStates, "placeholder:text-fg-subtle data-disabled:placeholder:text-fg-disabled"];

export interface InputProps extends Omit<InputPrimitive.Props, "className" | "size"> {
  /** Fluent's field appearance: outline (default), underline, filled-darker or filled-lighter. */
  appearance?: FieldAppearance | undefined;
  /** Fluent's size: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A single-line text input on Base UI's Input. Inside a Base UI Field it takes the field's label,
 * description and validity; on its own, set `aria-invalid` to mark it invalid. The ref reaches
 * the `<input>`.
 */
export function Input({ appearance, size, className, ...props }: InputProps) {
  const look = fieldAppearance(appearance);
  const height = controlSize(size);
  return (
    <InputPrimitive
      data-slot="input"
      data-appearance={look}
      data-size={height}
      className={cn(base, inputVariants.appearance[look], inputVariants.size[height], className)}
      {...props}
    />
  );
}
