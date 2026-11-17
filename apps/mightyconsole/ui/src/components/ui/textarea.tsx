import { Input as InputPrimitive } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { controlSize, fieldAppearance, fieldAppearances, fieldFrame, fieldPadding, fieldStates, type ControlSizeProp, type FieldAppearance } from "@/lib/control";

// Fluent 2's Textarea. Base UI has no textarea part: its Input (Field.Control) renders a <textarea>
// through `render`, so a Textarea inside a Field takes the label, the description and the
// validity like Input does. Same appearances, focus underline and states as Input.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const textareaVariants = {
  appearance: fieldAppearances,
  size: {
    small: `${fieldPadding.small} py-inline-xs text-caption-1`,
    medium: `${fieldPadding.medium} py-inline-sm text-body-1`,
    large: `${fieldPadding.large} py-inline-md text-body-2`,
  },
} as const;

const base = [
  "block w-full min-w-0 resize-y",
  fieldFrame,
  fieldStates,
  "placeholder:text-fg-subtle data-disabled:resize-none data-disabled:placeholder:text-fg-disabled",
];

export interface TextareaProps extends Omit<ComponentProps<"textarea">, "className" | "onChange"> {
  /** Fluent's field appearance: outline (default), underline, filled-darker or filled-lighter. */
  appearance?: FieldAppearance | undefined;
  /** Padding and text, matched to Input's sizes; the height follows `rows` (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Called with the new value on every change (Base UI's Field.Control). */
  onValueChange?: (value: string, details: unknown) => void;
  /** The native change event, if you need it; prefer onValueChange. */
  onChange?: ComponentProps<"textarea">["onChange"];
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A multi-line text input. Inside a Base UI Field it takes the field's label, description and
 * validity; on its own, set `aria-invalid`. Three rows by default, resizable vertically. The ref
 * reaches the `<textarea>`.
 */
export function Textarea({ appearance, size, rows = 3, className, ref, ...props }: TextareaProps) {
  const look = fieldAppearance(appearance);
  const height = controlSize(size);
  return (
    <InputPrimitive
      data-slot="textarea"
      data-appearance={look}
      data-size={height}
      render={<textarea ref={ref} rows={rows} />}
      className={cn(base, textareaVariants.appearance[look], textareaVariants.size[height], className)}
      {...(props as Omit<InputPrimitive.Props, "size">)}
    />
  );
}
