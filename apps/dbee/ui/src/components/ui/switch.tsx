import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/cn";

// An on/off switch on Base UI's Switch: a focusable <span role="switch"> with a hidden <input>
// for forms, and a thumb inside. The track's end padding is one thumb wide, so the thumb slides
// by its own width (translate-x-full) with no computed lengths. The group's classes style the
// thumb (`*:`), the only child.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const switchVariants = {
  size: {
    sm: "pe-[var(--by-size-icon-xs)] *:size-icon-xs",
    md: "pe-[var(--by-size-icon-sm)] *:size-icon-sm",
    lg: "pe-[var(--by-size-icon-md)] *:size-icon-md",
  },
} as const;

const base = [
  "inline-flex shrink-0 items-center rounded-full border-2 border-transparent bg-border-strong",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "data-checked:bg-accent-solid data-checked:hover:bg-accent-solid-hover",
  "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "data-invalid:data-unchecked:bg-danger-border aria-invalid:data-unchecked:bg-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
  "*:rounded-full *:bg-surface *:shadow-raised",
  "*:transition-transform *:duration-[var(--by-motion-duration-fast)] *:ease-standard",
  "data-checked:*:translate-x-full rtl:data-checked:*:-translate-x-full",
];

export interface SwitchProps extends Omit<SwitchPrimitive.Root.Props, "className" | "children"> {
  /** Thumb size, from the `size.icon.*` roles; the track is two thumbs wide. */
  size?: keyof typeof switchVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A setting that is on or off and takes effect at once ("Read-only connection"), on Base UI's
 * Switch. Use `checked` and `onCheckedChange`, or `defaultChecked`. Wrap it in a FieldLabel with
 * its text. The ref reaches the `<span role="switch">`.
 */
export function Switch({ size = "md", className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root data-slot="switch" data-size={size} className={cn(base, switchVariants.size[size], className)} {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
