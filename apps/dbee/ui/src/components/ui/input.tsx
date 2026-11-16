import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/cn";

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const inputVariants = {
  size: {
    sm: "h-control-sm px-inset-sm",
    md: "h-control-md px-control-x",
    lg: "h-control-lg px-inset-lg",
  },
} as const;

const base = [
  "flex w-full min-w-0 rounded-md border border-border-strong bg-surface font-sans text-body text-fg",
  "placeholder:text-fg-subtle",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "aria-invalid:border-danger-border data-invalid:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
];

export interface InputProps extends Omit<InputPrimitive.Props, "className" | "size"> {
  /** Control height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof inputVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A single-line text input on Base UI's Input. Inside a Base UI Field it takes the field's label,
 * description and validity; on its own, set `aria-invalid` to mark it invalid. The ref reaches
 * the `<input>`.
 */
export function Input({ size = "md", className, ...props }: InputProps) {
  return <InputPrimitive data-slot="input" data-size={size} className={cn(base, inputVariants.size[size], className)} {...props} />;
}
