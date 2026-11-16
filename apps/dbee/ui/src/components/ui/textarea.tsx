import { Input as InputPrimitive } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// Base UI has no textarea part: its Input (Field.Control) renders a <textarea> through `render`,
// so a Textarea inside a Field takes the label, the description and the validity like Input does.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const textareaVariants = {
  size: {
    sm: "px-inset-sm py-inline-xs",
    md: "px-control-x py-inline-sm",
    lg: "px-inset-lg py-inline-md",
  },
} as const;

const base = [
  "block w-full min-w-0 resize-y rounded-md border border-border-strong bg-surface font-sans text-body text-fg",
  "placeholder:text-fg-subtle",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "aria-invalid:border-danger-border data-invalid:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:resize-none data-disabled:opacity-[var(--by-opacity-disabled)]",
];

export interface TextareaProps extends Omit<ComponentProps<"textarea">, "className" | "onChange"> {
  /** Padding, matched to Input's sizes; the height follows `rows`. */
  size?: keyof typeof textareaVariants.size;
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
export function Textarea({ size = "md", rows = 3, className, ref, ...props }: TextareaProps) {
  return (
    <InputPrimitive
      data-slot="textarea"
      data-size={size}
      render={<textarea ref={ref} rows={rows} />}
      className={cn(base, textareaVariants.size[size], className)}
      {...(props as Omit<InputPrimitive.Props, "size">)}
    />
  );
}
